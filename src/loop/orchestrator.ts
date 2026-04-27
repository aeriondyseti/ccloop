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
import {
  type NotifyOptions, type RateLimitState,
  freshRateLimitState, notify,
} from "../notify/notify.ts";

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

  while (!abortSignal.aborted) {
    // Re-enter pause if state already paused (continue case).
    if (state.state === "paused" && state.pause) {
      const paused = await waitOutPause(state, opts, rateLimit);
      if (paused === "cancelled") return { kind: "cancelled" };
      // fall through to next pre-flight
    }

    // Pre-step usage gate.
    if (opts.usage) {
      const decision = await checkUsageGate(opts.usage, config);
      if (decision.kind === "pause") {
        applyPause(state, decision.until, decision.reason, now);
        await writeState(paths.state, state);
        bus.emit({
          ts: nowIso(now),
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
        bus.emit({
          ts: nowIso(now),
          run_id: state.run_id,
          step: state.current_step,
          type: "escalate",
          reason: decision.reason,
        });
        return { kind: "escalated", reason: decision.reason };
      }
    }

    // Run one step.
    const stepStartedAt = now();
    let status: StepStatus;
    try {
      status = await driver.stepOnce(state, abortSignal);
    } catch (err) {
      // §8.4 — reactive rate-limit detection. If the SDK threw
      // something rate-limit-shaped, route through pause/escalate
      // instead of charging the failure counter.
      const reactive = tryReactiveRateLimit(err, config);
      if (reactive) {
        if (reactive.kind === "pause") {
          applyPause(state, reactive.until, "rate_limit (reactive)", now);
          await writeState(paths.state, state);
          bus.emit({
            ts: nowIso(now),
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
          bus.emit({
            ts: nowIso(now),
            run_id: state.run_id,
            step: state.current_step,
            type: "escalate",
            reason: reactive.reason,
          });
          return { kind: "escalated", reason: reactive.reason };
        }
      }
      // Genuine surprise.
      // Treat surprises as an SDK init failure for accounting purposes.
      state.consecutive_failures += 1;
      await writeState(paths.state, state);
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
      await fireNotification(state, opts, rateLimit, escalationPayload(state, status.reason));
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
      const cadenceMs = config.loop.target_cadence_seconds * 1000;
      const sleepMs = cadenceMs - stepDurationMs;
      if (sleepMs > 0) await abortableSleep(sleepMs, abortSignal);
    }
  }

  return { kind: "cancelled" };
}

async function checkUsageGate(
  usage: UsageClient,
  config: CcloopConfig,
): Promise<
  | { kind: "proceed" }
  | { kind: "pause"; until: IsoTimestamp; reason: string }
  | { kind: "escalate"; reason: string }
> {
  const got: UsageResult = await usage.get();
  let snapshot: UsageSnapshot | null = null;
  if (got.kind === "ok") snapshot = got.snapshot;
  else if (got.kind === "rate_limited" || got.kind === "shape_mismatch" || got.kind === "network_error") {
    snapshot = got.lastGood;
  } else if (got.kind === "auth_error") {
    return {
      kind: "escalate",
      reason: `usage endpoint auth_error (HTTP ${got.status}); rotate token`,
    };
  }
  if (!snapshot) return { kind: "proceed" };
  const thresholds: UsageThresholds = {
    pauseAtUtilization: config.loop.pause_at_utilization,
    escalateAtUtilization: config.loop.escalate_at_utilization,
    resetBufferMs: 30_000,
  };
  const d = decideUsage(snapshot, thresholds);
  if (d.action === "pause") return { kind: "pause", until: d.until, reason: d.reason };
  if (d.action === "escalate") return { kind: "escalate", reason: d.reason };
  return { kind: "proceed" };
}

async function waitOutPause(
  state: CcloopState,
  opts: OrchestratorOptions,
  rateLimit: RateLimitState,
): Promise<"woke" | "cancelled"> {
  const { abortSignal, paths, bus, config } = opts;
  const now = opts.now ?? (() => Date.now());
  if (!state.pause) return "woke";
  const pauseStartedMs = Date.parse(state.pause.entered_at);
  const alertThresholdMs = config.notify.pause_alert_seconds * 1000;
  let alertFired = false;
  while (!abortSignal.aborted) {
    if (!state.pause) break;
    const remaining = Date.parse(state.pause.until) - now();
    if (!Number.isFinite(remaining) || remaining <= 0) break;

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
  bus.emit({
    ts: nowIso(now),
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

function escalationPayload(state: CcloopState, reason: string): { reason: string; summary: string } {
  return {
    reason,
    summary: `ccloop escalated: ${reason} (run ${state.run_id} step ${state.current_step})`,
  };
}

async function fireNotification(
  state: CcloopState,
  opts: OrchestratorOptions,
  rateLimit: RateLimitState,
  payload: { reason: string; summary: string },
): Promise<void> {
  if (!opts.notifyOptions.pushUrl && !opts.notifyOptions.webhookUrl) return;
  await notify(
    {
      run_id: state.run_id,
      step: state.current_step,
      reason: payload.reason,
      trail: [],
      summary: payload.summary,
    },
    opts.notifyOptions,
    rateLimit,
  );
}
