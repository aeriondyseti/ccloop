import {
  query as defaultQuery,
  type HookCallback,
  type Options,
  type SDKMessage,
  type SDKAssistantMessage,
  type SDKResultMessage,
  type NonNullableUsage,
} from "@anthropic-ai/claude-agent-sdk";
import type { SdkDebugSink } from "./debugDump.ts";

// SDK debug dump module is loaded lazily so it can be excluded from
// the published npm tarball without breaking production runs (where
// CCLOOP_SDK_DEBUG is never set).
const SDK_DEBUG_ENV = "CCLOOP_SDK_DEBUG";
async function maybeOpenSdkDebugSink(
  cwd: string,
  step: number | undefined,
): Promise<SdkDebugSink | null> {
  if (process.env[SDK_DEBUG_ENV] !== "1") return null;
  const { openSdkDebugSink } = await import("./debugDump.ts");
  return openSdkDebugSink(cwd, step);
}

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
  onMessage?: (msg: SDKMessage) => void;
  /** PreToolUse hook (per §6.5). Pre-empts the CLI's hardcoded
   *  command-prefix / shell-operator / file-write pre-checks so our
   *  denylist + sandbox wrap is the only trust boundary. */
  preToolUseHook?: HookCallback;
  /** Test seam — defaults to the SDK's `query`. */
  queryImpl?: QueryImpl;
  /** Step number, used to label SDK debug dumps when
   *  `CCLOOP_SDK_DEBUG=1`. Optional — dumps still work without it
   *  (they fall back to a timestamp-based dir). */
  step?: number;
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
  let isError = false;

  let prompt = input.prompt;
  let resume = input.resumeSessionId;
  let continuations = 0;
  const debugSink = await maybeOpenSdkDebugSink(input.cwd, input.step);

  // Outer loop = one SDK `query` call. We keep going while the SDK
  // returns `pause_turn` (it wants to continue past its own maxTurns
  // budget) and we have continuation headroom. Without this, every
  // pause_turn produced a separate ccloop step with its own commit
  // and cadence sleep, fragmenting Claude's work.
  while (true) {
    const sdkOptions = buildSdkOptions(input, resume);
    debugSink?.startAttempt(continuations, {
      prompt,
      resumeSessionId: resume,
      options: sdkOptions,
    });
    const q = queryImpl({ prompt, options: sdkOptions });

    let lastResultUsage: NonNullableUsage | undefined;
    let gotResult = false;
    try {
      for await (const msg of q) {
        debugSink?.message(msg);
        try {
          input.onMessage?.(msg);
        } catch {
          // Observers must not break the step.
        }

        if (msg.session_id) sessionId = asSessionId(msg.session_id);

        if (msg.type === "assistant") {
          handleAssistant(msg, usage, assistantTurns, (sr) => { stopReason = sr; });
        } else if (msg.type === "result") {
          gotResult = true;
          subtype = msg.subtype;
          numTurns += msg.num_turns;
          totalCost += msg.total_cost_usd;
          lastResultUsage = msg.usage;
          if (msg.subtype !== "success" && Array.isArray(msg.errors)) {
            for (const e of msg.errors) errors.push(e);
          }
          if (msg.subtype === "success") resultText = msg.result;
          // Sticky: any errored result message marks the step as errored.
          // The synthetic "Prompt is too long" reply has subtype: "success"
          // with is_error: true; classifyStep relies on this flag.
          if (msg.is_error) isError = true;
        }
      }
    } catch (err) {
      // The Claude Code CLI subprocess exits with code 1 immediately
      // after emitting the synthetic "Prompt is too long" result for
      // an over-budget prompt. The SDK iterator surfaces that exit as
      // a thrown Error AFTER the result message has already been
      // yielded. If we let it escape, the orchestrator's catch
      // classifies it as `sdk_init` and our context_overflow rotation
      // path never fires — the run wedges retrying the same poisoned
      // session. When `gotResult` is true the SDK-level call
      // effectively completed; treat the post-stream throw as
      // transport noise and let `classifyStep` see the is_error flag.
      if (!gotResult) throw err;
      errors.push((err as Error).message ?? String(err));
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

  const stepResult: StepResult = {
    subtype,
    stop_reason: stopReason,
    num_turns: numTurns,
    total_cost_usd: totalCost,
    duration_ms: Date.now() - startedAt,
    usage,
    session_id: sessionId,
    final_text: finalText,
    errors,
    is_error: isError,
  };
  debugSink?.finish(stepResult);
  return stepResult;
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
): Options {
  const yolo = input.config.claude.yolo_mode;
  const opts: Options = {
    cwd: input.cwd,
    includePartialMessages: true,
    maxTurns: input.config.claude.max_turns_per_step,
    permissionMode: yolo ? "bypassPermissions" : "default",
    settingSources: ["project"],
  };
  const thinking = effortToThinkingTokens(input.config.claude.effort);
  if (thinking !== undefined) opts.maxThinkingTokens = thinking;
  if (input.config.claude.system_prompt) {
    opts.systemPrompt = {
      type: "preset",
      preset: "claude_code",
      append: input.config.claude.system_prompt,
    };
  }
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

/** Drain an assistant message into per-step accumulators. Pulled out
 *  so the iterator hot path stays readable. */
function handleAssistant(
  msg: SDKAssistantMessage,
  usage: StepUsage,
  turns: string[],
  setStopReason: (sr: StepResult["stop_reason"]) => void,
): void {
  const inner = msg.message;
  if (inner.stop_reason) setStopReason(inner.stop_reason as StepResult["stop_reason"]);
  if (inner.usage) accumulateUsage(usage, inner.usage);
  const turnText = extractAssistantText(inner.content);
  if (turnText) turns.push(turnText);
}

function accumulateUsage(into: StepUsage, raw: NonNullableUsage): void {
  into.input_tokens += raw.input_tokens;
  into.output_tokens += raw.output_tokens;
  into.cache_read_input_tokens += raw.cache_read_input_tokens;
  into.cache_creation_input_tokens += raw.cache_creation_input_tokens;
  // Track the heaviest single inference's input-side total. The
  // sums above conflate work across all turns (cache reads recur
  // each turn) so they overstate the model's actual context window
  // utilization by a factor of num_turns. The peak is what the
  // model saw at one moment — the right number to gate rotation on.
  const inferenceInput =
    raw.input_tokens + raw.cache_read_input_tokens + raw.cache_creation_input_tokens;
  if (inferenceInput > (into.peak_input_tokens ?? 0)) {
    into.peak_input_tokens = inferenceInput;
  }
}

/** Extract concatenated text from an APIAssistantMessage's `content`.
 *  The Anthropic SDK types `content` as a discriminated union of
 *  ContentBlock variants; we only pull from `text` blocks. */
export function extractAssistantText(content: SDKAssistantMessage["message"]["content"]): string {
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    }
  }
  return parts.join("\n").trim();
}
