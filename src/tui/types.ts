/**
 * View model the TUI consumes. The driver and SDK don't depend on
 * this — they emit raw events; the TUI projects them into this shape.
 */
import type { UsageSnapshot } from "../usage/client.ts";

export type TuiState =
  | "STARTING" | "RUNNING" | "PAUSED" | "ESCALATED"
  | "GUARDRAIL_TRIP" | "DONE";

/**
 * One entry in the live "now" pane. The pane is cleared at each step
 * boundary and re-populated as the SDK stream arrives.
 */
export type TurnEvent =
  | { kind: "turn_start"; turn: number; ts: string }
  | { kind: "assistant_text"; text: string; ts: string }
  | { kind: "tool_use"; tool: string; summary: string; ts: string }
  | { kind: "tool_result"; tool: string; ok: boolean; excerpt: string; ts: string }
  | { kind: "idle"; ts: string; note: string };

/** Which scrollable pane currently owns keyboard scroll input. */
export type FocusTarget = "now" | "log";

export interface TuiViewModel {
  state: TuiState;
  step: number;
  runId: string;
  startedAt: string;
  cwd: string;
  elapsedMs: number;
  usage: UsageSnapshot | null;
  rollingCostUsd: number;
  rollingTokensIn: number;
  rollingTokensOut: number;
  averageCacheHitRate: number;
  /** Number of consecutive recent steps below the cache-hit-rate
   *  threshold (per SPEC §11). Renderer can surface ≥3 as a yellow
   *  flag — that's the same point at which the cache_warning event
   *  fires. 0 when healthy. */
  cacheLowStreak: number;
  /** Live stream of the current step's turns. Cleared at step boundaries. */
  nowContent: TurnEvent[];
  /** Pre-formatted human-readable log lines. Capped at 500. */
  logContent: string[];
  /** Which scrollable pane has keyboard focus. */
  focus: FocusTarget;
  /** Toggles each tick so users see the loop is alive. */
  heartbeat: "●" | "○";
  /** True after a Ctrl+C arrives — flips the controls hint to a
   *  "stopping… press again to force-exit" message. */
  interrupting: boolean;
  /** When non-null, the loop is sleeping between steps (cadence wait).
   *  Header renders an X/Y s countdown computed from these. */
  cadenceWait: { startedAt: string; totalMs: number } | null;
  pause: { until: string; reason: string } | null;
  escalation: { reason: string } | null;
  guardrail: { which: string; limit: unknown; actual: unknown } | null;
  done: { finalCommitSha: string } | null;
  /** Static line of single-key controls per current state. */
  controlsHint: string;
  /** SPEC.md `- [ ]` / `- [x]` checklist progress. `null` when the
   *  spec has no items (or hasn't been read yet). Surfaced in the
   *  header so an operator can see "12/47 done" at a glance — the
   *  template promises this and overnight runs need it most. */
  checklist: { done: number; total: number } | null;
}

export const EMPTY_VIEW: TuiViewModel = {
  state: "STARTING",
  step: 0,
  runId: "",
  startedAt: "",
  cwd: "",
  elapsedMs: 0,
  usage: null,
  rollingCostUsd: 0,
  rollingTokensIn: 0,
  rollingTokensOut: 0,
  averageCacheHitRate: 0,
  cacheLowStreak: 0,
  nowContent: [],
  logContent: [],
  focus: "now",
  heartbeat: "●",
  interrupting: false,
  cadenceWait: null,
  pause: null,
  escalation: null,
  guardrail: null,
  done: null,
  controlsHint: "ctrl-c quit",
  checklist: null,
};
