/**
 * Map an SDK `StepResult` to ccloop's success / failure classification
 * per §6.3 + §9.1.
 */
import type { StepResult } from "../sdk/types.ts";

export interface StepFailure {
  category: FailureCategory;
  excerpt: string;
}

export type StepClassification =
  | { outcome: "success" }
  | ({ outcome: "failure" } & StepFailure);

export type FailureCategory =
  | "sdk"
  | "max_turns"
  | "structured_output"
  | "refusal"
  | "max_budget"
  | "sdk_init"
  | "context_overflow"
  | "commit"
  | "gate"
  | "step_timeout"
  | "loop_detected";

/** Matches the SDK's synthetic "Prompt is too long" assistant message,
 *  and any close paraphrase. Tested against `final_text` rather than the
 *  errors array because the SDK puts this in the result payload directly. */
const CONTEXT_OVERFLOW_RE = /prompt is too long|context.*(too long|exceed|overflow)|input is too long/i;

export function classifyStep(r: StepResult): StepClassification {
  // Errored results must be classified as failures even when the SDK
  // tags subtype: "success". The clearest case is "Prompt is too long":
  // a synthetic assistant message with subtype: "success", is_error:
  // true, no API call made, no tokens billed. Falling through to
  // success here is what wedged ccloop into resuming the same poisoned
  // session every step (see step-0012 dump, 2026-05-01).
  if (r.is_error) {
    if (CONTEXT_OVERFLOW_RE.test(r.final_text) || CONTEXT_OVERFLOW_RE.test(r.errors.join(" "))) {
      return {
        outcome: "failure",
        category: "context_overflow",
        excerpt: capExcerpt(r.final_text || "context overflow"),
      };
    }
    // Non-context errors that snuck through subtype: success — fall
    // back to the generic SDK category so the failure is recorded.
    return {
      outcome: "failure",
      category: "sdk",
      excerpt: capExcerpt(r.final_text || r.errors.join("\n") || "errored result"),
    };
  }
  switch (r.subtype) {
    case "success":
      if (r.stop_reason === "refusal") {
        return { outcome: "failure", category: "refusal", excerpt: "model refusal" };
      }
      // pause_turn, max_tokens, end_turn → success
      return { outcome: "success" };
    case "error_during_execution":
      return {
        outcome: "failure",
        category: "sdk",
        excerpt: capExcerpt(r.errors.join("\n") || "execution error"),
      };
    case "error_max_turns":
      return {
        outcome: "failure",
        category: "max_turns",
        excerpt: `hit maxTurns (${r.num_turns})`,
      };
    case "error_max_structured_output_retries":
      return {
        outcome: "failure",
        category: "structured_output",
        excerpt: "structured output retries exhausted",
      };
    case "error_max_budget_usd":
      return {
        outcome: "failure",
        category: "max_budget",
        excerpt: "max budget exceeded",
      };
  }
}

import { truncateToWidth } from "../util/width.ts";

/** Cap a step-failure excerpt to `max` visual columns (default 1024).
 *  Width-aware so emoji and wide characters in error output don't
 *  cause silent over-truncation or surrogate-pair splits. */
export function capExcerpt(s: string, max = 1024): string {
  return truncateToWidth(s, max);
}
