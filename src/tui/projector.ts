/**
 * Build the TUI view model from a state snapshot + recent step
 * records + recent events. Pure; the renderer subscribes to a tick
 * and re-projects.
 */
import type { CcloopState } from "../state/state.ts";
import type { UsageSnapshot } from "../usage/client.ts";
import type { StepRecord } from "../loop/stepRecord.ts";
import type { TuiState, TuiViewModel } from "./types.ts";

export interface ProjectorInput {
  state: CcloopState;
  cwd: string;
  usage: UsageSnapshot | null;
  recent: StepRecord[];
  events: string[];
  now: Date;
  finalCommitSha?: string;
}

const CONTROLS: Record<TuiState, string> = {
  STARTING: "ctrl-c quit",
  RUNNING: "ctrl-c stop",
  PAUSED: "ctrl-c stop",
  ESCALATED: "c continue · r revert · e edit spec · q quit",
  GUARDRAIL_TRIP: "q quit · e edit ccloop.toml",
  DONE: "q quit",
};

export function project(input: ProjectorInput): TuiViewModel {
  const tuiState = stateToTui(input.state.state);
  const elapsedMs =
    input.now.getTime() - Date.parse(input.state.started_at);

  let cost = 0;
  let tokensIn = 0;
  let tokensOut = 0;
  let cacheRateSum = 0;
  for (const r of input.recent) {
    cost += r.cost_usd;
    tokensIn += r.usage.input_tokens;
    tokensOut += r.usage.output_tokens;
    cacheRateSum += r.cache_hit_rate;
  }
  const avgCache = input.recent.length > 0 ? cacheRateSum / input.recent.length : 0;

  return {
    state: tuiState,
    step: input.state.current_step,
    runId: input.state.run_id,
    startedAt: input.state.started_at,
    cwd: input.cwd,
    elapsedMs: Number.isFinite(elapsedMs) ? elapsedMs : 0,
    usage: input.usage,
    rollingCostUsd: cost,
    rollingTokensIn: tokensIn,
    rollingTokensOut: tokensOut,
    averageCacheHitRate: avgCache,
    recentSteps: input.recent.map((r) => ({
      step: r.step,
      outcome: r.outcome,
      cost_usd: r.cost_usd,
      duration_ms: r.duration_ms,
      cache_hit_rate: r.cache_hit_rate,
      commit_subject: r.commit_subject,
    })),
    events: input.events,
    pause: input.state.pause
      ? { until: input.state.pause.until, reason: input.state.pause.reason }
      : null,
    escalation: input.state.escalation
      ? { reason: input.state.escalation.reason }
      : null,
    guardrail: input.state.guardrail_trip
      ? {
          which: input.state.guardrail_trip.which,
          limit: input.state.guardrail_trip.limit,
          actual: input.state.guardrail_trip.actual,
        }
      : null,
    done: input.state.state === "done"
      ? { finalCommitSha: input.finalCommitSha ?? "" }
      : null,
    controlsHint: CONTROLS[tuiState],
  };
}

function stateToTui(s: CcloopState["state"]): TuiState {
  switch (s) {
    case "running": return "RUNNING";
    case "paused": return "PAUSED";
    case "escalated": return "ESCALATED";
    case "guardrail_trip": return "GUARDRAIL_TRIP";
    case "done": return "DONE";
  }
}
