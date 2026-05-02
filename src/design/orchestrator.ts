/**
 * Design loop orchestrator.
 *
 * Drives an interactive SDK conversation that produces a validated
 * SPEC.md. The orchestrator owns the SDK loop, the in-process MCP
 * server (for `ask_user`), the draft sandbox (via the design approver
 * hook), lifecycle event emission, and acceptance/promotion. All
 * user-facing rendering is delegated to an IoAdapter (see io.ts) so
 * the same orchestrator drives stdio CLI, two-pane TUI, and tests.
 */

import {
  query as defaultQuery,
  type Options,
  type SDKMessage,
  type SDKAssistantMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { CcloopConfig } from "../config/schema.ts";
import { createDesignMcpServer } from "../mcp/server.ts";
import { makeDesignApprover } from "./approver.ts";
import { DESIGN_SYSTEM_PROMPT } from "./prompts.ts";
import {
  initializeDraft,
  loadDraft,
  loadDraftIfExists,
  saveDraft,
} from "./draft.ts";
import { acceptDraft, formatValidationError, generateAcceptancePrompt, checkDraftValidity } from "./acceptance.ts";
import { createDesignEventEmitter } from "./events.ts";
import { effortToThinkingTokens } from "../sdk/runStep.ts";
import { asSessionId, type SessionId } from "../branded.ts";
import type { IoAdapter } from "./io.ts";
import type { DesignSessionResult } from "./types.ts";

type QueryImpl = typeof defaultQuery;

export interface RunDesignSessionInput {
  cwd: string;
  config: CcloopConfig;
  io: IoAdapter;
  /** External cancel signal — wired to SIGINT/SIGTERM. */
  abortController?: AbortController;
  /** Test seam — defaults to the SDK's `query`. */
  queryImpl?: QueryImpl;
  /** Override path to the templates/SPEC.md scaffold (test seam). */
  templatePath?: string;
}

const FILE_EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

export async function runDesignSession(
  input: RunDesignSessionInput,
): Promise<DesignSessionResult> {
  const { cwd, config, io } = input;
  const queryImpl: QueryImpl = input.queryImpl ?? defaultQuery;
  const events = createDesignEventEmitter(cwd);

  await events.sessionStart("vision");
  io.showInfo(
    "ccloop design — interactive spec-shaping session.\n" +
    "Type freeform input between turns. Slash commands: /accept, /abort.",
  );

  // Ensure ./.ccloop/design/ exists and seed the draft if missing.
  await initializeDraft(cwd, input.templatePath);
  const initialDraft = await loadDraft(cwd);
  io.draftUpdated(initialDraft);

  // MCP server is created once and shared across all SDK turns. Each
  // ask_user invocation routes through the IoAdapter so the
  // presentation layer (TUI widget vs stdio menu) is decoupled.
  const mcpServer = createDesignMcpServer(async (askInput) => {
    await events.askUserAsked(askInput.question);
    const result = await io.askUser(askInput);
    await events.askUserAnswered(result.selected, result.freeform);
    return result;
  });

  const approver = makeDesignApprover({ cwd });

  let resumeSession: SessionId | null = null;
  let totalTurns = 0;
  let totalCost = 0;
  let nextPrompt: string =
    "Welcome. The user has just started a design session. Read the current draft at " +
    "`./.ccloop/design/spec.draft.md`, greet the user briefly, and begin the **Vision** phase " +
    "by asking what problem they're trying to solve. Use the `ask_user` tool when you have " +
    "specific multiple-choice questions; otherwise prefer brief prose. Keep your first message short.";

  const startedAt = new Date().toISOString();

  while (true) {
    if (input.abortController?.signal.aborted) {
      await finalizeAbort(events, "signal");
      return abortedResult(cwd, startedAt, totalTurns, totalCost);
    }

    const opts = buildSdkOptions({
      cwd, config, mcpServer, approverHook: approver,
      resume: resumeSession, abortController: input.abortController,
    });

    let lastSessionId: SessionId | null = null;
    try {
      const q = queryImpl({ prompt: nextPrompt, options: opts });
      for await (const msg of q) {
        if (msg.session_id) lastSessionId = asSessionId(msg.session_id);
        if (msg.type === "assistant") {
          await handleAssistantMessage(msg, cwd, io, events);
        } else if (msg.type === "result") {
          totalTurns += msg.num_turns;
          totalCost += msg.total_cost_usd;
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      io.showError(`SDK error: ${message}`);
      await events.sessionEnd("error");
      return {
        outcome: "error",
        final_draft: (await loadDraftIfExists(cwd)) ?? "",
        metadata: {
          started_at: startedAt,
          current_phase: "vision",
          turn_count: totalTurns,
          total_cost_usd: totalCost,
        },
        error_message: message,
      };
    }
    if (lastSessionId) resumeSession = lastSessionId;

    // Between agent turns, hand control to the user.
    const userInput = await io.getNextInput();
    if (userInput === null) {
      await finalizeAbort(events, "eof");
      return abortedResult(cwd, startedAt, totalTurns, totalCost);
    }

    const trimmed = userInput.trim();
    if (trimmed === "/abort") {
      await finalizeAbort(events, "user-abort");
      return abortedResult(cwd, startedAt, totalTurns, totalCost);
    }

    if (trimmed === "/accept") {
      const validation = await checkDraftValidity(cwd);
      if (!validation.ok) {
        io.showError(formatValidationError(validation.error));
        nextPrompt =
          `The user attempted to accept the draft but validation failed: ${validation.error}. ` +
          `Please update the draft to address this and then continue the conversation.`;
        continue;
      }
      const confirmed = await io.confirm(
        generateAcceptancePrompt(validation.checklistCount),
        true,
      );
      if (!confirmed) {
        nextPrompt =
          "The user declined promotion at the last moment. Continue refining the draft.";
        continue;
      }
      const result = await acceptDraft(cwd);
      if (!result.accepted) {
        io.showError(formatValidationError(result.validationError));
        nextPrompt =
          `Promotion failed: ${result.validationError}. Please continue refining the draft.`;
        continue;
      }
      io.showInfo(
        `Promoted to repo root: ${result.promotedFiles.join(", ")}.`,
      );
      await events.sessionAccept(totalTurns, totalCost);
      const launchBuild = await io.confirm(
        "Launch `ccloop build` now to start the build loop?",
        false,
      );
      if (launchBuild) {
        io.showInfo(
          "Run `ccloop build` from this directory to start the build loop.",
        );
      }
      await events.sessionEnd("accepted");
      return {
        outcome: "accepted",
        final_draft: await loadDraft(cwd),
        metadata: {
          started_at: startedAt,
          current_phase: "acceptance",
          turn_count: totalTurns,
          total_cost_usd: totalCost,
          accepted: true,
        },
      };
    }

    nextPrompt = userInput;
  }
}

async function handleAssistantMessage(
  msg: SDKAssistantMessage,
  cwd: string,
  io: IoAdapter,
  events: ReturnType<typeof createDesignEventEmitter>,
): Promise<void> {
  const inner = msg.message;
  const content = inner.content;
  if (!Array.isArray(content)) return;

  const textParts: string[] = [];
  for (const block of content) {
    if (block.type === "text" && typeof block.text === "string") {
      textParts.push(block.text);
    } else if (block.type === "tool_use") {
      io.showToolUse(block.name, summarizeToolInput(block.name, block.input));
      if (FILE_EDIT_TOOLS.has(block.name)) {
        // The agent just modified the draft (or another sandboxed file).
        // Refresh the IoAdapter's view so the TUI right-pane re-renders.
        const draft = await loadDraftIfExists(cwd);
        if (draft !== null) {
          io.draftUpdated(draft);
          await events.draftEdit(extractFilePath(block.input) ?? "spec.draft.md");
        }
      }
    }
  }
  const combined = textParts.join("\n").trim();
  if (combined) io.showAssistantText(combined);
}

function summarizeToolInput(name: string, raw: unknown): string {
  if (!raw || typeof raw !== "object") return "";
  const input = raw as Record<string, unknown>;
  if (name === "Bash" && typeof input.command === "string") {
    return input.command.length > 80 ? `${input.command.slice(0, 77)}...` : input.command;
  }
  if (FILE_EDIT_TOOLS.has(name)) {
    const fp = extractFilePath(input);
    return fp ?? "";
  }
  if (name === "Read" && typeof input.file_path === "string") {
    return input.file_path;
  }
  if (name === "Grep" && typeof input.pattern === "string") {
    return input.pattern;
  }
  if (name === "Glob" && typeof input.pattern === "string") {
    return input.pattern;
  }
  return "";
}

function extractFilePath(raw: unknown): string | null {
  if (!raw || typeof raw !== "object") return null;
  const input = raw as Record<string, unknown>;
  if (typeof input.file_path === "string") return input.file_path;
  if (typeof input.notebook_path === "string") return input.notebook_path;
  if (Array.isArray(input.edits) && input.edits.length > 0) {
    const first = input.edits[0];
    if (first && typeof first === "object") {
      const fp = (first as Record<string, unknown>).file_path;
      if (typeof fp === "string") return fp;
    }
  }
  return null;
}

interface BuildOptionsArgs {
  cwd: string;
  config: CcloopConfig;
  mcpServer: ReturnType<typeof createDesignMcpServer>;
  approverHook: ReturnType<typeof makeDesignApprover>;
  resume: SessionId | null;
  abortController?: AbortController;
}

function buildSdkOptions(args: BuildOptionsArgs): Options {
  const { cwd, config, mcpServer, approverHook, resume, abortController } = args;
  const opts: Options = {
    cwd,
    includePartialMessages: false,
    maxTurns: config.design.max_turns,
    permissionMode: "default",
    settingSources: ["project"],
    systemPrompt: DESIGN_SYSTEM_PROMPT,
    mcpServers: { "design-loop": mcpServer },
    hooks: {
      PreToolUse: [{ hooks: [approverHook] }],
    },
  };
  const thinking = effortToThinkingTokens(config.design.effort);
  if (thinking !== undefined) opts.maxThinkingTokens = thinking;
  if (config.design.model) opts.model = config.design.model;
  if (resume) opts.resume = resume;
  if (abortController) opts.abortController = abortController;
  return opts;
}

async function finalizeAbort(
  events: ReturnType<typeof createDesignEventEmitter>,
  reason: string,
): Promise<void> {
  await events.sessionAbort(reason);
  await events.sessionEnd("aborted");
}

async function abortedResult(
  cwd: string,
  startedAt: string,
  totalTurns: number,
  totalCost: number,
): Promise<DesignSessionResult> {
  return {
    outcome: "aborted",
    final_draft: (await loadDraftIfExists(cwd)) ?? "",
    metadata: {
      started_at: startedAt,
      current_phase: "vision",
      turn_count: totalTurns,
      total_cost_usd: totalCost,
    },
  };
}

// Re-export saveDraft so external test fixtures can prime a draft
// without the orchestrator re-importing it.
export { saveDraft };
