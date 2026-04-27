import { query, type HookCallback } from "@anthropic-ai/claude-agent-sdk";
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
  const usage: StepUsage = emptyUsage();
  let stopReason: StepResult["stop_reason"] = null;
  const assistantTurns: string[] = [];
  let resultText = "";
  let sessionId: SessionId = input.resumeSessionId ?? asSessionId("");
  let subtype: StepResult["subtype"] = "error_during_execution";
  let numTurns = 0;
  let totalCost = 0;
  const errors: string[] = [];

  const sdkOptions = buildSdkOptions(input);

  const q = query({ prompt: input.prompt, options: sdkOptions });

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
      numTurns = numberOr(m.num_turns, numTurns);
      totalCost = numberOr(m.total_cost_usd, totalCost);
      const u = m.usage as Record<string, unknown> | undefined;
      if (u) {
        // Prefer the result-level usage when assistant-level didn't accumulate.
        if (usage.input_tokens === 0 && usage.output_tokens === 0) {
          accumulateUsage(usage, u);
        }
      }
      if (Array.isArray(m.errors)) {
        for (const e of m.errors) if (typeof e === "string") errors.push(e);
      }
      if (typeof (m as { result?: unknown }).result === "string") {
        resultText = (m as { result: string }).result;
      }
    }
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

function buildSdkOptions(input: RunStepInput): Record<string, unknown> {
  const yolo = input.config.claude.yolo_mode;
  const opts: Record<string, unknown> = {
    cwd: input.cwd,
    includePartialMessages: true,
    maxTurns: input.config.claude.max_turns_per_step,
    permissionMode: yolo ? "bypassPermissions" : "default",
    settingSources: ["project"],
  };
  if (yolo) opts.allowDangerouslySkipPermissions = true;
  if (input.preToolUseHook) {
    opts.hooks = {
      PreToolUse: [{ hooks: [input.preToolUseHook] }],
    };
  }
  if (input.abortController) opts.abortController = input.abortController;
  if (input.resumeSessionId) opts.resume = input.resumeSessionId;
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
