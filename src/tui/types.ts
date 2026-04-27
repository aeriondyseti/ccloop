/**
 * View model the TUI consumes. The driver and SDK don't depend on
 * this — they emit raw events; the TUI projects them into this shape.
 */
import type { UsageSnapshot } from "../usage/client.ts";

export type TuiState =
  | "STARTING" | "RUNNING" | "PAUSED" | "ESCALATED"
  | "GUARDRAIL_TRIP" | "DONE";

export interface TuiStepSummary {
  step: number;
  outcome: "success" | "failure" | "no-op";
  cost_usd: number;
  duration_ms: number;
  cache_hit_rate: number;
  commit_subject: string;
}

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
  recentSteps: TuiStepSummary[];
  events: string[];                       // pre-formatted lines
  pause: { until: string; reason: string } | null;
  escalation: { reason: string } | null;
  guardrail: { which: string; limit: unknown; actual: unknown } | null;
  done: { finalCommitSha: string } | null;
  /** Static line of single-key controls per current state. */
  controlsHint: string;
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
  recentSteps: [],
  events: [],
  pause: null,
  escalation: null,
  guardrail: null,
  done: null,
  controlsHint: "ctrl-c quit",
};
