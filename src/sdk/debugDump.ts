/**
 * Per-step SDK debug dumps. Opt-in via `CCLOOP_SDK_DEBUG=1`
 * (auto-set by `--debug`). When enabled, every SDK query in
 * `runStep` writes its inputs and stream to disk so the operator
 * can inspect what we sent to the SDK and what came back —
 * primarily for diagnosing "prompt is too long" and runaway tool
 * loops.
 *
 * Layout:
 *   .ccloop/sdk-debug/
 *     .gitignore                # written once: contains "*"
 *     step-0042/
 *       input-0.json            # one per SDK query (per continuation)
 *       stream-0.jsonl
 *       input-1.json
 *       stream-1.jsonl
 *       result.json             # final aggregated StepResult
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

export const SDK_DEBUG_ENV = "CCLOOP_SDK_DEBUG";

export function sdkDebugEnabled(): boolean {
  return process.env[SDK_DEBUG_ENV] === "1";
}

export interface SdkDebugSink {
  /** Called once per SDK query (the outer while loop in runStep).
   *  `attempt` is the continuation index (0 = initial query). */
  startAttempt(
    attempt: number,
    payload: { prompt: string; resumeSessionId: string | null;
               options: Record<string, unknown> },
  ): void;
  /** Called for every SDK message in the current attempt. */
  message(msg: unknown): void;
  /** Called once at end-of-step with the aggregated result. */
  finish(result: unknown): void;
}

/** Returns null when debug is off — call sites should skip work. */
export function openSdkDebugSink(
  cwd: string,
  step: number | undefined,
): SdkDebugSink | null {
  if (!sdkDebugEnabled()) return null;
  const root = join(cwd, ".ccloop", "sdk-debug");
  const dir = join(
    root,
    step !== undefined
      ? `step-${String(step).padStart(4, "0")}`
      : `step-${Date.now()}`,
  );
  try {
    mkdirSync(dir, { recursive: true });
    const gi = join(root, ".gitignore");
    if (!existsSync(gi)) writeFileSync(gi, "*\n");
  } catch {
    // Best-effort. If we can't create the dir we silently skip
    // rather than break the step.
    return null;
  }

  let currentAttempt = -1;
  let currentStreamPath = "";

  return {
    startAttempt(attempt, payload) {
      currentAttempt = attempt;
      currentStreamPath = join(dir, `stream-${attempt}.jsonl`);
      const inputPath = join(dir, `input-${attempt}.json`);
      try {
        writeFileSync(inputPath, JSON.stringify(payload, jsonReplacer, 2));
        // Truncate any pre-existing stream file (rerun on the same
        // step number) so the JSONL reflects this attempt only.
        writeFileSync(currentStreamPath, "");
      } catch {
        // Non-fatal.
      }
    },
    message(msg) {
      if (currentAttempt < 0) return;
      try {
        appendFileSync(
          currentStreamPath,
          JSON.stringify(msg, jsonReplacer) + "\n",
        );
      } catch {
        // Non-fatal.
      }
    },
    finish(result) {
      try {
        writeFileSync(
          join(dir, "result.json"),
          JSON.stringify(result, jsonReplacer, 2),
        );
      } catch {
        // Non-fatal.
      }
    },
  };
}

/** JSON.stringify replacer: drop fields that aren't usefully
 *  serialisable (functions, AbortController) so dumps stay clean
 *  diff-able JSON. */
function jsonReplacer(_key: string, value: unknown): unknown {
  if (typeof value === "function") return "[function]";
  if (value instanceof AbortController) return "[AbortController]";
  if (value instanceof AbortSignal) return "[AbortSignal]";
  return value;
}
