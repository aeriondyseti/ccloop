/**
 * Wraps `LoopDriver` with the surrounding concerns from §4 / §7 / §8 /
 * §9 that are not pure step logic:
 *
 *   - Pre-step usage gate (§7.6 / §8.3) → PAUSED / ESCALATED
 *   - Cadence sleep (§7.3) after a successful step
 *   - Backoff (§9.2) after a failed step
 *   - Pause loop (§8.5) with periodic refresh; wakes early if window
 *     clears
 *   - Cancellation via AbortController (§6.10)
 *
 * The orchestrator emits the same `DriverEvent` stream the TUI
 * subscribes to, with the addition of `pause_enter` / `pause_exit`.
 */
import type { CcloopConfig } from "../config/schema.ts";
import type { CcloopState } from "../state/state.ts";
import type { RuntimePaths } from "../state/paths.ts";
import { writeState } from "../state/state.ts";
import { type DriverEvent, type LoopDriver, type StepStatus } from "./driver.ts";
import { EventLogger } from "../state/events.ts";
import { abortableSleep } from "./sleep.ts";
import { type EventBus } from "./eventBus.ts";
import {
  type UsageClient,
  type UsageResult,
  type UsageSnapshot,
} from "../usage/client.ts";
import { decideUsage, type UsageThresholds } from "../usage/decide.ts";
import { type IsoTimestamp, nowIso } from "../branded.ts";
import { isRateLimitError, parseRateLimitError } from "../usage/reactive.ts";
import { loadRecentSteps } from "../state/stepLoader.ts";
import {
  type NotifyOptions, type RateLimitState,
  freshRateLimitState, notify,
} from "../notify/notify.ts";
import { pingHeartbeat } from "../notify/heartbeat.ts";

export interface OrchestratorOptions {
  config: CcloopConfig;
  paths: RuntimePaths;
  driver: LoopDriver;
  bus: EventBus<DriverEvent>;
  abortSignal: AbortSignal;
  /** May be null if usage endpoint should not be polled. */
  usage: UsageClient | null;
  /** Notification channels; either URL may be empty. */
  notifyOptions: NotifyOptions;
  /** Liveness ping URL. Empty disables. */
  heartbeatUrl?: string;
  /** Test seam — pluggable fetch for heartbeat + notify in tests. */
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export type RunOutcome =
  | { kind: "done"; finalCommitSha: string }
  | { kind: "guardrail_trip"; which: string; limit: unknown; actual: unknown }
  | { kind: "escalated"; reason: string }
  | { kind: "cancelled" };

const PAUSE_REFRESH_INTERVAL_MS = 60_000;

export async function runLoop(
  state: CcloopState,
  opts: OrchestratorOptions,
): Promise<RunOutcome> {
  const { config, paths, driver, bus, abortSignal } = opts;
  const now = opts.now ?? (() => Date.now());
  const rateLimit: RateLimitState = freshRateLimitState();
  // Two writers to events.jsonl (driver also has one) is fine: each
  // write is an atomic O_APPEND on POSIX, and the file is line-
  // delimited JSON so interleaved writes don't corrupt earlier lines.
  // Without this, pause_enter / pause_exit / escalate / usage_degraded
  // emitted from the orchestrator never reached the durable log,
  // breaking the wake-up recap's counts on overnight runs.
  const events = new EventLogger(paths.events);
  let usageDegradedWarned = false;

  /** Emit a durable event: bus + events.jsonl. Use for any event the
   *  wake-up recap or post-mortem reads back. Cadence_wait_* and
   *  stream_chunk stay bus-only (they fire too often to be worth
   *  the durable-log bytes). */
  const emitDurable = async (event: Omit<DriverEvent, "ts">): Promise<void> => {
    const enriched = { ...event, ts: nowIso(now) } as DriverEvent;
    bus.emit(enriched);
    await events.append(enriched);
  };

  while (!abortSignal.aborted) {
    // Re-enter pause if state already paused (continue case).
    if (state.state === "paused" && state.pause) {
      const paused = await waitOutPause(state, opts, rateLimit);
      if (paused === "cancelled") return { kind: "cancelled" };
      // waitOutPause may transition straight into escalated when a
      // refreshed usage snapshot crosses the 7-day threshold mid-pause.
      // It already fired the notification + escalate event; just
      // surface the terminal status and stop, don't fall through to
      // pre-flight which would re-emit a duplicate.
      if ((state as CcloopState).state === "escalated") {
        return { kind: "escalated", reason: state.escalation?.reason ?? "unknown" };
      }
    }

    // Pre-step usage gate.
    if (opts.usage) {
      const decision = await checkUsageGate(opts.usage, config);
      if (decision.kind === "pause") {
        applyPause(state, decision.until, decision.reason, now);
        await writeState(paths.state, state);
        await emitDurable({
          run_id: state.run_id,
          step: state.current_step,
          type: "pause_enter",
          reason: decision.reason,
          until: decision.until,
          window: "five_hour",
        });
        const paused = await waitOutPause(state, opts, rateLimit);
        if (paused === "cancelled") return { kind: "cancelled" };
        continue;
      }
      if (decision.kind === "escalate") {
        applyEscalation(state, decision.reason, now);
        await writeState(paths.state, state);
        await fireNotification(state, opts, rateLimit, escalationPayload(state, decision.reason));
        await emitDurable({
          run_id: state.run_id,
          step: state.current_step,
          type: "escalate",
          reason: decision.reason,
        });
        return { kind: "escalated", reason: decision.reason };
      }
      if (decision.kind === "proceed" && decision.degraded && !usageDegradedWarned) {
        usageDegradedWarned = true;
        await emitDurable({
          run_id: state.run_id,
          step: state.current_step,
          type: "usage_degraded",
          status: decision.degraded.status,
          reason: decision.degraded.reason,
        });
      }
    }

    // Run one step.
    const stepStartedAt = now();
    let status: StepStatus;
    try {
      status = await driver.stepOnce(state, abortSignal);
      fireHeartbeat(state, opts, statusOutcome(status));
    } catch (err) {
      // User-initiated cancellation propagating through the SDK as a
      // throw — the abortSignal aborted, the SDK noticed, threw an
      // AbortError out of its stream iterator. Don't pollute the
      // failure counter or escalation state with what the user
      // explicitly asked for. Without this guard, two prior real
      // failures + a Ctrl+C would tip into ESCALATED on resume.
      if (abortSignal.aborted) return { kind: "cancelled" };

      // §8.4 — reactive rate-limit detection. If the SDK threw
      // something rate-limit-shaped, route through pause/escalate
      // instead of charging the failure counter.
      const reactive = tryReactiveRateLimit(err, config);
      if (reactive) {
        if (reactive.kind === "pause") {
          applyPause(state, reactive.until, "rate_limit (reactive)", now);
          await writeState(paths.state, state);
          await emitDurable({
            run_id: state.run_id,
            step: state.current_step,
            type: "pause_enter",
            reason: "rate_limit (reactive)",
            until: reactive.until,
            window: "five_hour",
          });
          const paused = await waitOutPause(state, opts, rateLimit);
          if (paused === "cancelled") return { kind: "cancelled" };
          continue;
        }
        if (reactive.kind === "escalate") {
          applyEscalation(state, reactive.reason, now);
          await writeState(paths.state, state);
          await fireNotification(state, opts, rateLimit, escalationPayload(state, reactive.reason));
          await emitDurable({
            run_id: state.run_id,
            step: state.current_step,
            type: "escalate",
            reason: reactive.reason,
          });
          return { kind: "escalated", reason: reactive.reason };
        }
      }
      // Genuine surprise.
      // Treat surprises as an SDK init failure for accounting purposes
      // (SPEC §9.1). Driver owns the state mutation + step_failed
      // event so the bus, events.jsonl, TUI events pane, and wake-up
      // recap all see the failure — without this routing, the failure
      // would only show as an incremented `consecutive_failures`
      // counter with no audit trail.
      await driver.recordSdkInitFailure(state, (err as Error).message ?? String(err));
      fireHeartbeat(state, opts, "sdk_init_error");
      if (
        state.consecutive_failures >=
        config.failure.consecutive_failures_before_escalation
      ) {
        const reason = `repeated SDK init failures: ${(err as Error).message}`;
        applyEscalation(state, reason, now);
        await writeState(paths.state, state);
        await fireNotification(state, opts, rateLimit, escalationPayload(state, reason));
        return { kind: "escalated", reason };
      }
      const backoffMs = backoffSecondsFor(config, state.consecutive_failures - 1) * 1000;
      await abortableSleep(backoffMs, abortSignal);
      continue;
    }

    if (status.kind === "done") {
      if (config.notify.notify_on_done) {
        await fireNotification(state, opts, rateLimit, {
          reason: "done",
          summary: `ccloop done: run ${state.run_id} step ${state.current_step} sha ${status.finalCommitSha}`,
        });
      }
      return { kind: "done", finalCommitSha: status.finalCommitSha };
    }
    if (status.kind === "guardrail_trip") {
      await fireNotification(state, opts, rateLimit, escalationPayload(state, `guardrail ${status.which}`));
      return status;
    }
    if (status.kind === "escalated") {
      await fireNotification(state, opts, rateLimit, escalationPayload(state, status.reason, true));
      return status;
    }

    // Step ran. Decide cadence vs backoff.
    const stepDurationMs = now() - stepStartedAt;
    if (status.kind !== "ran") continue;
    if (status.outcome === "failure") {
      const idx = Math.max(0, state.consecutive_failures - 1);
      const backoffMs = backoffSecondsFor(config, idx) * 1000;
      await abortableSleep(backoffMs, abortSignal);
    } else {
      // Post-step DONE check: if the step we just finished created
      // DONE.md, transition immediately rather than waiting out the
      // next cadence window before the next pre-flight notices.
      // Pass the just-completed step number — `state.current_step`
      // was already incremented by stepOnce, so without this the
      // events.jsonl `done` line and the notify summary would
      // attribute the achievement to a step that never ran.
      const justFinishedStep = state.current_step - 1;
      const done = await driver.checkDoneTransition(state, justFinishedStep);
      if (done && done.kind === "done") {
        fireHeartbeat(state, opts, "done");
        if (config.notify.notify_on_done) {
          await fireNotification(state, opts, rateLimit, {
            reason: "done",
            summary: `ccloop done: run ${state.run_id} step ${justFinishedStep} sha ${done.finalCommitSha}`,
          });
        }
        return { kind: "done", finalCommitSha: done.finalCommitSha };
      }
      const cadenceMs = config.loop.target_cadence_seconds * 1000;
      const sleepMs = cadenceMs - stepDurationMs;
      if (sleepMs > 0) {
        bus.emit({
          ts: nowIso(now),
          run_id: state.run_id,
          step: state.current_step,
          type: "cadence_wait_enter",
          started_at: nowIso(now),
          total_ms: sleepMs,
        });
        try {
          await abortableSleep(sleepMs, abortSignal);
        } finally {
          bus.emit({
            ts: nowIso(now),
            run_id: state.run_id,
            step: state.current_step,
            type: "cadence_wait_exit",
          });
        }
      }
    }
  }

  return { kind: "cancelled" };
}

export interface UsageDegradedWarning {
  status: number | null;
  reason: string;
}

async function checkUsageGate(
  usage: UsageClient,
  config: CcloopConfig,
): Promise<
  | { kind: "proceed"; degraded?: UsageDegradedWarning }
  | { kind: "pause"; until: IsoTimestamp; reason: string }
  | { kind: "escalate"; reason: string }
> {
  const got: UsageResult = await usage.get();
  let snapshot: UsageSnapshot | null = null;
  let degraded: UsageDegradedWarning | undefined;
  if (got.kind === "ok") snapshot = got.snapshot;
  else if (got.kind === "auth_error") {
    return {
      kind: "escalate",
      reason: `usage endpoint auth_error (HTTP ${got.status}); rotate token`,
    };
  } else {
    snapshot = got.lastGood;
    degraded = describeDegradation(got);
  }
  if (!snapshot) {
    return degraded ? { kind: "proceed", degraded } : { kind: "proceed" };
  }
  const thresholds: UsageThresholds = {
    pauseAtUtilization: config.loop.pause_at_utilization,
    escalateAtUtilization: config.loop.escalate_at_utilization,
    resetBufferMs: 30_000,
  };
  const d = decideUsage(snapshot, thresholds);
  if (d.action === "pause") return { kind: "pause", until: d.until, reason: d.reason };
  if (d.action === "escalate") return { kind: "escalate", reason: d.reason };
  return degraded ? { kind: "proceed", degraded } : { kind: "proceed" };
}

function describeDegradation(got: UsageResult): UsageDegradedWarning | undefined {
  if (got.kind === "endpoint_unavailable") {
    // 403 is almost always the `claude setup-token` scope case: the
    // token has `user:inference` but `/api/oauth/usage` requires
    // `user:profile`. Re-auth via `claude /login` to enable proactive
    // gating. Reactive limit detection still works without this.
    return {
      status: got.status,
      reason: `usage endpoint forbidden (HTTP ${got.status}); token likely lacks user:profile scope. Re-auth via 'claude /login' to enable proactive gating. Falling back to reactive-only detection.`,
    };
  }
  if (got.kind === "rate_limited") {
    return {
      status: 429,
      reason: "usage endpoint rate-limited (HTTP 429); falling back to reactive-only detection.",
    };
  }
  if (got.kind === "shape_mismatch") {
    return {
      status: null,
      reason: "usage endpoint returned unexpected shape; falling back to reactive-only detection.",
    };
  }
  if (got.kind === "network_error") {
    return {
      status: null,
      reason: `usage endpoint unreachable (${got.error}); falling back to reactive-only detection.`,
    };
  }
  return undefined;
}

async function waitOutPause(
  state: CcloopState,
  opts: OrchestratorOptions,
  rateLimit: RateLimitState,
): Promise<"woke" | "cancelled"> {
  const { abortSignal, paths, bus, config } = opts;
  const now = opts.now ?? (() => Date.now());
  // Local persistence sink so mid-pause escalations and pause_exit
  // events land in events.jsonl, not just the bus. See the comment
  // on the corresponding instantiation in `runLoop`.
  const events = new EventLogger(paths.events);
  const emitDurable = async (event: Omit<DriverEvent, "ts">): Promise<void> => {
    const enriched = { ...event, ts: nowIso(now) } as DriverEvent;
    bus.emit(enriched);
    await events.append(enriched);
  };
  if (!state.pause) return "woke";
  const pauseStartedMs = Date.parse(state.pause.entered_at);
  const alertThresholdMs = config.notify.pause_alert_seconds * 1000;
  let alertFired = false;
  while (!abortSignal.aborted) {
    if (!state.pause) break;
    const remaining = Date.parse(state.pause.until) - now();
    if (!Number.isFinite(remaining) || remaining <= 0) break;

    // Pause-period heartbeat: a long rate-limit pause emits no
    // step-end heartbeats, so an external monitor with a multi-
    // minute grace period would otherwise alarm "ccloop went silent"
    // overnight. Each refresh tick (~60s) also pings, with outcome
    // "paused" so a richer consumer can render context.
    fireHeartbeat(state, opts, "paused");

    if (
      !alertFired &&
      alertThresholdMs > 0 &&
      now() - pauseStartedMs >= alertThresholdMs
    ) {
      alertFired = true;
      await fireNotification(state, opts, rateLimit, {
        reason: `pause_alert: ${state.pause.reason}`,
        summary: `ccloop paused >${config.notify.pause_alert_seconds}s: ${state.pause.reason} (until ${state.pause.until})`,
      });
    }

    // Refresh usage every PAUSE_REFRESH_INTERVAL_MS in case the window
    // clears early.
    if (opts.usage) {
      const got = await opts.usage.refresh();
      if (got.kind === "ok") {
        const t = decideUsage(got.snapshot, {
          pauseAtUtilization: opts.config.loop.pause_at_utilization,
          escalateAtUtilization: opts.config.loop.escalate_at_utilization,
          resetBufferMs: 30_000,
        });
        if (t.action === "proceed") {
          // window cleared early; wake.
          break;
        }
        if (t.action === "escalate") {
          applyEscalation(state, t.reason, now);
          await writeState(paths.state, state);
          // Fire the escalation notification *here*. Returning "woke"
          // and relying on the next pre-flight to notice the
          // escalation works only if the pre-flight runs at all — an
          // abort or a different gate decision in between would drop
          // the notification on the floor.
          await fireNotification(state, opts, rateLimit, escalationPayload(state, t.reason));
          await emitDurable({
            run_id: state.run_id,
            step: state.current_step,
            type: "escalate",
            reason: t.reason,
          });
          return "woke";
        }
      }
    }

    await abortableSleep(
      Math.min(PAUSE_REFRESH_INTERVAL_MS, remaining),
      abortSignal,
    );
  }
  if (abortSignal.aborted) return "cancelled";

  // Clear pause state.
  state.pause = null;
  state.state = "running";
  await writeState(paths.state, state);
  await emitDurable({
    run_id: state.run_id,
    step: state.current_step,
    type: "pause_exit",
    wake_reason: "timer_or_clear",
  });
  return "woke";
}

function tryReactiveRateLimit(
  err: unknown,
  config: CcloopConfig,
): { kind: "pause"; until: IsoTimestamp } | { kind: "escalate"; reason: string } | null {
  const text = (err as Error)?.message ?? String(err);
  if (!isRateLimitError(text)) return null;
  const decision = parseRateLimitError(text, {
    defaultPauseSeconds: config.loop.rate_limit_default_pause_seconds,
  });
  if (decision.kind === "pause") return { kind: "pause", until: decision.until };
  return { kind: "escalate", reason: decision.reason };
}

function applyPause(state: CcloopState, until: IsoTimestamp, reason: string, now: () => number): void {
  state.state = "paused";
  state.pause = {
    until,
    reason,
    window: "five_hour",
    entered_at: nowIso(now),
  };
}

function applyEscalation(state: CcloopState, reason: string, now: () => number): void {
  state.state = "escalated";
  state.escalation = { reason, trail: [], entered_at: nowIso(now) };
}

function backoffSecondsFor(cfg: CcloopConfig, idx: number): number {
  const tab = cfg.failure.backoff;
  if (tab.length === 0) return 0;
  const i = Math.min(idx, tab.length - 1);
  return tab[i] ?? 0;
}

/** Build the escalation push/webhook summary. `appendLastFailure`
 *  controls whether `state.last_failure` is suffixed onto the headline.
 *  We append when the escalation was *caused* by step failures (so the
 *  failure detail is the actual signal the operator wants), and skip
 *  it for unrelated causes — guardrail trips, no_progress, loop_detected,
 *  reactive rate-limit hits — because in those cases `last_failure`
 *  may be a stale entry from an earlier step that has nothing to do
 *  with why we're escalating now. */
export function escalationPayload(
  state: CcloopState,
  reason: string,
  appendLastFailure = false,
): { reason: string; summary: string } {
  const head = `ccloop escalated: ${reason} (run ${state.run_id} step ${state.current_step})`;
  if (!appendLastFailure) return { reason, summary: head };
  const lf = state.last_failure;
  if (!lf) return { reason, summary: head };
  const tail = lf.excerpt.trim().split("\n")[0]?.slice(0, 200) ?? "";
  const detail = tail.length > 0 ? ` — ${lf.category}: ${tail}` : ` — ${lf.category}`;
  return { reason, summary: head + detail };
}

function statusOutcome(s: StepStatus): string {
  switch (s.kind) {
    case "ran": return s.outcome;
    case "done": return "done";
    case "escalated": return "escalated";
    case "guardrail_trip": return "guardrail_trip";
    case "paused": return "paused";
  }
}

/** Fire-and-forget liveness ping. Synchronous return path so the
 *  orchestrator's main loop is never throttled by heartbeat latency:
 *  a misconfigured URL (10s timeout × N steps) would otherwise add
 *  tens of minutes of stall to an overnight run. The fetch's
 *  synchronous body still runs before this returns, so test
 *  observers that record into shared state during the fetch see
 *  the call without needing an async tick. Errors are swallowed —
 *  pingHeartbeat already catches them, and a heartbeat is by
 *  definition best-effort. */
function fireHeartbeat(
  state: CcloopState,
  opts: OrchestratorOptions,
  outcome: string,
): void {
  const url = opts.heartbeatUrl;
  if (!url) return;
  void pingHeartbeat({
    url,
    body: {
      run_id: state.run_id,
      step: state.current_step,
      outcome,
      state: state.state,
      ts: nowIso(opts.now ?? (() => Date.now())),
    },
    fetchImpl: opts.fetchImpl,
  }).catch(() => {});
}

async function fireNotification(
  state: CcloopState,
  opts: OrchestratorOptions,
  rateLimit: RateLimitState,
  payload: { reason: string; summary: string },
): Promise<void> {
  if (!opts.notifyOptions.pushUrl && !opts.notifyOptions.webhookUrl) return;
  const results = await notify(
    {
      run_id: state.run_id,
      step: state.current_step,
      reason: payload.reason,
      // Lazy: notify only resolves this when the webhook is actually
      // about to fire (URL set, not rate-limited).
      trail: () => buildTrail(opts.paths.steps),
      summary: payload.summary,
    },
    opts.notifyOptions,
    rateLimit,
  );
  // Emit one durable `notification_sent` event per channel attempted
  // (per SPEC §11.5). Without this, a webhook that silently 502s
  // overnight gives the operator no signal that the on-call channel
  // is broken. Persist via a fresh EventLogger — same pattern as
  // waitOutPause, the file is append-safe across writers on POSIX.
  const events = new EventLogger(opts.paths.events);
  const tsFn = opts.now ?? (() => Date.now());
  for (const r of results) {
    // Locally rate-limited results never hit the network — they're
    // ccloop-side throttling, not a channel failure. Suppress the
    // `notification_sent` event so the recap's "N notify failures"
    // count doesn't conflate "we throttled ourselves" with "the
    // on-call webhook is broken."
    if (r.rateLimited) continue;
    const ev = {
      ts: nowIso(tsFn),
      run_id: state.run_id,
      step: state.current_step,
      type: "notification_sent" as const,
      channel: r.channel,
      status: r.status,
      ok: r.ok,
      ...(r.error ? { error: r.error } : {}),
    };
    opts.bus.emit(ev as DriverEvent);
    await events.append(ev);
  }
}

/** Trail of the last few step summaries, attached to webhook payloads
 *  so a consumer (Slack bot, etc.) can show the operator the run's
 *  recent context without round-tripping back to the dashboard.
 *  Best-effort: any read failure → empty trail. */
async function buildTrail(stepsDir: string): Promise<unknown[]> {
  try {
    const recent = await loadRecentSteps(stepsDir, 5);
    return recent.map((r) => ({
      step: r.step,
      outcome: r.outcome,
      subject: r.commit_subject || undefined,
      failure: r.failure ? { category: r.failure.category, excerpt: r.failure.excerpt } : undefined,
      cost_usd: r.cost_usd,
      cache_hit_rate: r.cache_hit_rate,
    }));
  } catch {
    return [];
  }
}
