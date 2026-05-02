/**
 * Build the TUI view model from a state snapshot + recent step
 * records + recent events. Pure; the renderer subscribes to a tick
 * and re-projects.
 */
import type { CcloopState } from "../state/state.ts";
import type { UsageSnapshot } from "../usage/client.ts";
import type { StepRecord } from "../loop/stepRecord.ts";
import { inputContextTokens, pickContextWindow } from "../sdk/types.ts";
import type {
  FocusTarget,
  LifecycleEntry,
  TranscriptEntry,
  TuiState,
  TuiViewModel,
  TurnEvent,
} from "./types.ts";

export interface ProjectorInput {
  state: CcloopState;
  cwd: string;
  usage: UsageSnapshot | null;
  recent: StepRecord[];
  /** Durable lifecycle events, oldest → newest. Caller caps the
   *  length. The projector promotes these into the transcript so the
   *  renderer can pick a typed block per event kind. */
  events: LifecycleEntry[];
  /** Live current-step stream. Caller resets at step boundaries. */
  nowContent?: TurnEvent[];
  /** Which scrollable pane currently has focus. */
  focus?: FocusTarget;
  /** Heartbeat tick. */
  heartbeat?: "●" | "○";
  /** True between first Ctrl+C and process exit. */
  interrupting?: boolean;
  /** Active cadence wait, if any. */
  cadenceWait?: { startedAt: string; totalMs: number } | null;
  /** Latest SPEC.md checklist count, sampled by the caller. */
  checklist?: { done: number; total: number } | null;
  now: Date;
  finalCommitSha?: string;
  /** Configured model id, used to pick the context-window denominator
   *  (200K default, 1M when the id contains "1m"). Empty / undefined
   *  → 200K. */
  model?: string;
  /** Running peak input-token count for the in-flight step. Set by
   *  the CLI from `usage_tick` bus events; the projector takes the
   *  max of this and the most recent completed step's peak so the
   *  context bar advances live within a step. */
  liveStepPeakTokens?: number;
  /** Operator pause flag — projects as `OPERATOR_PAUSED` when the
   *  underlying state is `running`. State.json itself is unchanged
   *  (operator pause is per-instance, not durable). */
  operatorPaused?: boolean;
}

const RUN_CONTROLS = "↑↓ scroll · ⇞⇟ page · g/G top/bot · ctrl-c stop";

const CONTROLS: Record<TuiState, string> = {
  STARTING: "ctrl-c quit",
  RUNNING: `p pause · ${RUN_CONTROLS}`,
  PAUSED: RUN_CONTROLS,
  OPERATOR_PAUSED: `p resume · ${RUN_CONTROLS}`,
  ESCALATED: "c continue · r revert · e edit spec · q quit",
  GUARDRAIL_TRIP: "q quit · e edit ccloop.toml",
  DONE: "↑↓ scroll · ⇞⇟ page · g/G top/bot · q quit",
};

export function project(input: ProjectorInput): TuiViewModel {
  // Only project as OPERATOR_PAUSED when the durable state is
  // running. If state.json says paused/escalated/guardrail_trip/done,
  // those take precedence — operator pause is layered on top of a
  // healthy run, not a way to override terminal states.
  const tuiState =
    input.operatorPaused && input.state.state === "running"
      ? "OPERATOR_PAUSED"
      : stateToTui(input.state.state);
  const elapsedMs =
    input.now.getTime() - Date.parse(input.state.started_at);

  let cost = 0;
  let tokensIn = 0;
  let tokensOut = 0;
  let cacheRateSum = 0;
  let cacheRateSamples = 0;
  for (const r of input.recent) {
    cost += r.cost_usd;
    tokensIn += r.usage.input_tokens;
    tokensOut += r.usage.output_tokens;
    // Only steps that actually called the model contribute to the
    // average. A step_timeout / synthesized failure has empty usage
    // and a 0 hit rate — including those would pull the displayed
    // average toward zero on an overnight run with a few hangs even
    // though the real cache behaviour is healthy.
    const tokens =
      r.usage.input_tokens +
      r.usage.cache_read_input_tokens +
      r.usage.cache_creation_input_tokens;
    if (tokens > 0) {
      cacheRateSum += r.cache_hit_rate;
      cacheRateSamples += 1;
    }
  }
  const avgCache = cacheRateSamples > 0 ? cacheRateSum / cacheRateSamples : 0;

  const lastStep = input.recent[input.recent.length - 1];
  const cachedPeak = lastStep ? inputContextTokens(lastStep.usage) : 0;
  // Within a step, the live peak walks up turn by turn. At
  // step_start it resets to 0; until the first usage_tick it stays
  // 0, so we fall back to the last completed step's peak for the
  // bar — better than blanking the bar on every step boundary.
  const lastContextTokens = Math.max(cachedPeak, input.liveStepPeakTokens ?? 0);
  const contextWindowTokens = pickContextWindow(input.model);

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
    cacheLowStreak: input.state.cache_low_streak,
    lastContextTokens,
    contextWindowTokens,
    transcript: mergeTranscript(input.events, input.nowContent ?? []),
    focus: input.focus ?? "transcript",
    heartbeat: input.heartbeat ?? "●",
    interrupting: input.interrupting ?? false,
    cadenceWait: input.cadenceWait ?? null,
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
    controlsHint: input.interrupting
      ? "stopping…  press ctrl-c again to force-exit"
      : CONTROLS[tuiState],
    checklist:
      input.checklist && input.checklist.total > 0 ? input.checklist : null,
  };
}

/** Merge lifecycle and turn events into a single chronological list.
 *  Lifecycle entries are durable (events.jsonl); turn entries are live
 *  for the current step. We rely on caller-provided ordering within
 *  each list and stable-merge by ts so a step_start that arrives at
 *  the same instant as the first stream chunk lands first. */
function mergeTranscript(
  events: LifecycleEntry[],
  turns: TurnEvent[],
): TranscriptEntry[] {
  const out: TranscriptEntry[] = [];
  let i = 0;
  let j = 0;
  while (i < events.length && j < turns.length) {
    const a = events[i];
    const b = turns[j];
    if (!a) { out.push({ source: "turn", ts: b!.ts, entry: b! }); j++; continue; }
    if (!b) { out.push({ source: "lifecycle", ts: a.ts, entry: a }); i++; continue; }
    if (a.ts <= b.ts) {
      out.push({ source: "lifecycle", ts: a.ts, entry: a });
      i++;
    } else {
      out.push({ source: "turn", ts: b.ts, entry: b });
      j++;
    }
  }
  for (; i < events.length; i++) {
    const a = events[i]!;
    out.push({ source: "lifecycle", ts: a.ts, entry: a });
  }
  for (; j < turns.length; j++) {
    const b = turns[j]!;
    out.push({ source: "turn", ts: b.ts, entry: b });
  }
  return out;
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
