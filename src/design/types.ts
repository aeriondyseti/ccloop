/** Type definitions for the design loop. The design loop walks the
 *  user through six phases linearly:
 *  vision → users → scope → architecture → milestones → acceptance. */

export type DesignPhase =
  | "vision"
  | "users"
  | "scope"
  | "architecture"
  | "milestones"
  | "acceptance";

export interface DesignPaths {
  draft: string;
  roadmap: string;
  ideas: string;
  techDebt: string;
  /** Summary written on graceful shutdown (Ctrl+C). */
  lastSession: string;
}

/** Sourced from `ccloop.toml [design]`. */
export interface DesignConfig {
  model?: string;
  max_turns?: number;
  effort?: string;
}

export interface DesignSessionMetadata {
  started_at: string;
  current_phase: DesignPhase;
  turn_count: number;
  total_cost_usd: number;
  accepted?: boolean;
}

export interface DesignSessionResult {
  outcome: "accepted" | "aborted" | "error";
  final_draft: string;
  metadata: DesignSessionMetadata;
  error_message?: string;
}

/** Lifecycle events the orchestrator emits to `./.ccloop/events.jsonl`. */
export type DesignEvent =
  | { type: "design_session_start"; timestamp: string; phase: DesignPhase }
  | { type: "ask_user_asked"; timestamp: string; question: string }
  | { type: "ask_user_answered"; timestamp: string; selected: string[]; freeform?: string }
  | { type: "draft_edit"; timestamp: string; file_path: string }
  | { type: "design_session_accept"; timestamp: string; turn_count: number; total_cost_usd: number }
  | { type: "design_session_abort"; timestamp: string; reason: string }
  | { type: "design_session_end"; timestamp: string; outcome: "accepted" | "aborted" | "error" };
