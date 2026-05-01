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
  | "commit"
  | "gate"
  | "step_timeout"
  | "loop_detected";

export function classifyStep(r: StepResult): StepClassification {
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
