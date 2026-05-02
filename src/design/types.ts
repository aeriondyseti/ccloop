/**
 * Type definitions for the design loop.
 *
 * The design loop is an interactive session where the agent guides the user
 * through creating a validated SPEC.md, walking through phases linearly:
 * vision → users → scope → architecture → milestones → acceptance.
 */

/**
 * Design session phases.
 * In MVP, phases are traversed linearly (no phase-hopping).
 */
export type DesignPhase =
  | "vision"
  | "users"
  | "scope"
  | "architecture"
  | "milestones"
  | "acceptance";

/**
 * Paths for design artifacts within ./.ccloop/design/
 */
export interface DesignPaths {
  /** Main draft spec being edited */
  draft: string;
  /** Explicit non-goals and future scope */
  roadmap: string;
  /** Parking lot for ideas */
  ideas: string;
  /** Intentional shortcuts / known gaps */
  techDebt: string;
  /** Summary written on graceful shutdown (Ctrl+C) */
  lastSession: string;
}

/**
 * Design session configuration.
 * Sourced from ccloop.toml [design] section.
 */
export interface DesignConfig {
  /** Model to use (defaults to Claude Opus, independent of build.model) */
  model?: string;
  /** Maximum turns per SDK query call (generous default for interactive sessions) */
  max_turns?: number;
  /** Effort level (maps to maxThinkingTokens) */
  effort?: string;
}

/**
 * Design session metadata.
 * Persisted to ./.ccloop/design/session.json for resume.
 */
export interface DesignSessionMetadata {
  /** When the session started */
  started_at: string;
  /** Current phase the agent is working on */
  current_phase: DesignPhase;
  /** Number of agent turns so far */
  turn_count: number;
  /** Total cost in USD */
  total_cost_usd: number;
  /** Whether the session was accepted by the user */
  accepted?: boolean;
}

/**
 * Result of a design session.
 * Returned when the session completes (accept, abort, or error).
 */
export interface DesignSessionResult {
  /** How the session ended */
  outcome: "accepted" | "aborted" | "error";
  /** Draft content at the end */
  final_draft: string;
  /** Session metadata */
  metadata: DesignSessionMetadata;
  /** Error message if outcome is "error" */
  error_message?: string;
}

/**
 * Design loop lifecycle events (emitted to ./.ccloop/events.jsonl).
 */
export type DesignEvent =
  | { type: "design_session_start"; timestamp: string; phase: DesignPhase }
  | { type: "design_phase_enter"; timestamp: string; phase: DesignPhase }
  | { type: "ask_user_asked"; timestamp: string; question: string }
  | { type: "ask_user_answered"; timestamp: string; selected: string[]; freeform?: string }
  | { type: "draft_edit"; timestamp: string; file_path: string }
  | { type: "design_session_accept"; timestamp: string; turn_count: number; total_cost_usd: number }
  | { type: "design_session_abort"; timestamp: string; reason: string }
  | { type: "design_session_end"; timestamp: string; outcome: "accepted" | "aborted" | "error" };
