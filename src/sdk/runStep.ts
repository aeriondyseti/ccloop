import { query as defaultQuery, type HookCallback } from "@anthropic-ai/claude-agent-sdk";

type QueryImpl = typeof defaultQuery;

/** Prompt sent on each `pause_turn` continuation. The SDK only needs
 *  a non-empty user message to nudge the resumed session forward —
 *  the real conversation context comes from `resume`. */
const CONTINUATION_PROMPT = "continue";
import type { CcloopConfig } from "../config/schema.ts";
import { type StepResult, type StepUsage, emptyUsage } from "./types.ts";
import { type SessionId, asSessionId } from "../branded.ts";

export interface RunStepInput {
  prompt: string;
  cwd: string;
  config: CcloopConfig;
  /** SDK session id to resume from. Null on the first step. */
  resumeSessionId: SessionId | null;
  /** External cancel signal — wired to SIGINT/SIGTERM. */
  abortController?: AbortController;
  /** Stream observer; called for every SDK message. Errors are swallowed. */
  onMessage?: (msg: unknown) => void;
  /** PreToolUse hook (per §6.5). Pre-empts the CLI's hardcoded
   *  command-prefix / shell-operator / file-write pre-checks so our
   *  denylist + sandbox wrap is the only trust boundary. */
  preToolUseHook?: HookCallback;
  /** Test seam — defaults to the SDK's `query`. */
  queryImpl?: QueryImpl;
}

/**
 * Run one ccloop step = one SDK `query`. Drains the iterator to
 * exhaustion and returns aggregated telemetry plus the terminal
 * `ResultMessage`'s subtype.
 *
 * This wrapper deliberately keeps the SDK's types behind its own
 * `StepResult` so the loop driver doesn't bind to the SDK's evolving
 * shape (see §6.3).
 */
export async function runStep(input: RunStepInput): Promise<StepResult> {
  const startedAt = Date.now();
  const queryImpl: QueryImpl = input.queryImpl ?? defaultQuery;
  const maxContinuations = Math.max(0, input.config.claude.max_continuations_per_step);

  // Aggregated across all SDK calls within this ccloop step.
  const usage: StepUsage = emptyUsage();
  const assistantTurns: string[] = [];
  const errors: string[] = [];
  let stopReason: StepResult["stop_reason"] = null;
  let resultText = "";
  let sessionId: SessionId = input.resumeSessionId ?? asSessionId("");
  let subtype: StepResult["subtype"] = "error_during_execution";
  let numTurns = 0;
  let totalCost = 0;

  let prompt = input.prompt;
  let resume = input.resumeSessionId;
  let continuations = 0;

  // Outer loop = one SDK `query` call. We keep going while the SDK
  // returns `pause_turn` (it wants to continue past its own maxTurns
  // budget) and we have continuation headroom. Without this, every
  // pause_turn produced a separate ccloop step with its own commit
  // and cadence sleep, fragmenting Claude's work.
  while (true) {
    const sdkOptions = buildSdkOptions(input, resume);
    const q = queryImpl({ prompt, options: sdkOptions });

    let lastResultUsage: Record<string, unknown> | undefined;
    for await (const msg of q) {
      try {
        input.onMessage?.(msg);
      } catch {
        // Observers must not break the step.
      }

      const m = msg as Record<string, unknown>;
      if (typeof m.session_id === "string" && m.session_id.length > 0) {
        sessionId = asSessionId(m.session_id);
      }

      if (m.type === "assistant") {
        const inner = (m.message as Record<string, unknown> | undefined) ?? {};
        const sr = inner.stop_reason;
        if (typeof sr === "string") stopReason = sr as StepResult["stop_reason"];
        const innerUsage = inner.usage as Record<string, unknown> | undefined;
        if (innerUsage) accumulateUsage(usage, innerUsage);
        const turnText = extractText(inner.content);
        if (turnText) assistantTurns.push(turnText);
      }

      if (m.type === "result") {
        subtype = (m.subtype as StepResult["subtype"]) ?? subtype;
        numTurns += numberOr(m.num_turns, 0);
        totalCost += numberOr(m.total_cost_usd, 0);
        lastResultUsage = m.usage as Record<string, unknown> | undefined;
        if (Array.isArray(m.errors)) {
          for (const e of m.errors) if (typeof e === "string") errors.push(e);
        }
        if (typeof (m as { result?: unknown }).result === "string") {
          resultText = (m as { result: string }).result;
        }
      }
    }

    // Result-level usage as fallback if no assistant message contributed.
    if (lastResultUsage && usage.input_tokens === 0 && usage.output_tokens === 0) {
      accumulateUsage(usage, lastResultUsage);
    }

    if (stopReason !== "pause_turn" || continuations >= maxContinuations) {
      break;
    }
    // External cancellation (SIGINT / SIGTERM) — don't kick off
    // another SDK call just to have it tear down on first message.
    if (input.abortController?.signal.aborted) break;
    continuations += 1;
    prompt = CONTINUATION_PROMPT;
    resume = sessionId; // resume the just-paused session.
  }

  // Prefer the canonical ResultMessage.result when it's strictly richer
  // than the accumulated transcript; otherwise keep the full transcript
  // so intermediate-turn explanations aren't lost. (See §6.3.)
  const accumulated = assistantTurns.join("\n\n");
  const finalText = resultText.length > accumulated.length ? resultText : accumulated;

  return {
    subtype,
    stop_reason: stopReason,
    num_turns: numTurns,
    total_cost_usd: totalCost,
    duration_ms: Date.now() - startedAt,
    usage,
    session_id: sessionId,
    final_text: finalText,
    errors,
  };
}

/** Map ccloop's string `effort` knob to the SDK's numeric
 *  `maxThinkingTokens` budget. Numbers calibrated to the Claude Code
 *  CLI conventions for low/medium/high/xhigh; an unrecognized value
 *  leaves `maxThinkingTokens` unset so the SDK uses its own default. */
const EFFORT_TO_THINKING_TOKENS: Record<string, number> = {
  low: 4000,
  medium: 12000,
  high: 24000,
  xhigh: 64000,
};

export function effortToThinkingTokens(effort: string): number | undefined {
  return EFFORT_TO_THINKING_TOKENS[effort.toLowerCase()];
}

function buildSdkOptions(
  input: RunStepInput,
  resume: SessionId | null,
): Record<string, unknown> {
  const yolo = input.config.claude.yolo_mode;
  const opts: Record<string, unknown> = {
    cwd: input.cwd,
    includePartialMessages: true,
    maxTurns: input.config.claude.max_turns_per_step,
    permissionMode: yolo ? "bypassPermissions" : "default",
    settingSources: ["project"],
  };
  const thinking = effortToThinkingTokens(input.config.claude.effort);
  if (thinking !== undefined) opts.maxThinkingTokens = thinking;
  if (input.config.claude.model) opts.model = input.config.claude.model;
  if (input.config.claude.fallback_model) opts.fallbackModel = input.config.claude.fallback_model;
  if (yolo) opts.allowDangerouslySkipPermissions = true;
  if (input.preToolUseHook) {
    opts.hooks = {
      PreToolUse: [{ hooks: [input.preToolUseHook] }],
    };
  }
  if (input.abortController) opts.abortController = input.abortController;
  if (resume) opts.resume = resume;
  return opts;
}

function accumulateUsage(into: StepUsage, raw: Record<string, unknown>): void {
  into.input_tokens += numberOr(raw.input_tokens, 0);
  into.output_tokens += numberOr(raw.output_tokens, 0);
  into.cache_read_input_tokens += numberOr(raw.cache_read_input_tokens, 0);
  into.cache_creation_input_tokens += numberOr(raw.cache_creation_input_tokens, 0);
}

function numberOr(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function extractText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (block && typeof block === "object") {
      const b = block as Record<string, unknown>;
      if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
    }
  }
  return parts.join("\n").trim();
}
