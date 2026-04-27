/**
 * Domain types for ccloop's view of an SDK step. These shapes are
 * intentionally narrower than the SDK's own types so we can swap SDK
 * versions without churning the loop driver.
 */
import type { SessionId } from "../branded.ts";

export type StepSubtype =
  | "success"
  | "error_during_execution"
  | "error_max_turns"
  | "error_max_structured_output_retries"
  | "error_max_budget_usd";

export type StopReason =
  | "end_turn"
  | "max_tokens"
  | "pause_turn"
  | "tool_use"
  | "stop_sequence"
  | "refusal"
  | null;

export interface StepUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
}

export interface StepResult {
  subtype: StepSubtype;
  /** Latest assistant `stop_reason` observed across turns. May be null
   *  if the SDK didn't surface any. */
  stop_reason: StopReason;
  num_turns: number;
  total_cost_usd: number;
  duration_ms: number;
  usage: StepUsage;
  session_id: SessionId;
  /** Final assistant text, used to derive a commit subject. May be empty. */
  final_text: string;
  /** Concatenated error messages on the failure path. */
  errors: string[];
}

export function emptyUsage(): StepUsage {
  return {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  };
}

export function cacheHitRate(u: StepUsage): number {
  const denom = u.cache_read_input_tokens + u.input_tokens;
  if (denom <= 0) return 0;
  return u.cache_read_input_tokens / denom;
}
