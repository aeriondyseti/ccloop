import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runtimePaths } from "../state/paths.ts";
import { freshState } from "../state/state.ts";
import { DEFAULTS } from "../config/schema.ts";
import { EventBus } from "./eventBus.ts";
import type { DriverEvent } from "./driver.ts";
import { runLoop } from "./orchestrator.ts";
import type { LoopDriver, StepStatus } from "./driver.ts";
import { asSessionId, asSha, isoFromMs, nowIso } from "../branded.ts";
import type { PauseInfo } from "../state/state.ts";
import type { UsageClient, UsageResult, UsageSnapshot } from "../usage/client.ts";

function fakeUsage(results: UsageResult[]): UsageClient {
  let i = 0;
  let last: UsageSnapshot | null = null;
  const next = (): UsageResult => {
    const r = results[Math.min(i, results.length - 1)] ?? { kind: "network_error", error: "drained", lastGood: null };
    i++;
    if (r.kind === "ok") last = r.snapshot;
    return r;
  };
  return {
    get: async () => next(),
    refresh: async () => next(),
    lastSnapshot: () => last,
  } as unknown as UsageClient;
}

function snapshot(fiveHourPct: number, sevenDayPct: number, fiveHourResetMsFromNow = 5 * 60 * 60 * 1000): UsageSnapshot {
  return {
    five_hour: { utilization: fiveHourPct, resets_at: isoFromMs(Date.now() + fiveHourResetMsFromNow) },
    seven_day: { utilization: sevenDayPct, resets_at: isoFromMs(Date.now() + 7 * 24 * 60 * 60 * 1000) },
    fetched_at: Date.now(),
  };
}

function pausedFor(msFromNow: number): PauseInfo {
  return {
    until: isoFromMs(Date.now() + msFromNow),
    reason: "test",
    window: "five_hour",
    entered_at: nowIso(),
  };
}

function fakeDriver(steps: Array<StepStatus | Error>): LoopDriver {
  let i = 0;
  return {
    async loadOrInitState() {
      throw new Error("not used in these tests");
    },
    async stepOnce() {
      const s = steps[i++];
      if (!s) return { kind: "done", finalCommitSha: asSha("") } satisfies StepStatus;
      if (s instanceof Error) throw s;
      return s;
    },
    /** Stub — real driver checks `existsSync(./DONE.md)`. Tests
     *  that drive `done` via stepOnce statuses don't exercise this
     *  path, so it's safe to always return null here. */
    async checkDoneTransition() {
      return null;
    },
  } as unknown as LoopDriver;
}

describe("runLoop", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ccloop-orch-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("done outcome propagates", async () => {
    const cfg = structuredClone(DEFAULTS);
    cfg.loop.target_cadence_seconds = 0;
    const bus = new EventBus<DriverEvent>();
    const driver = fakeDriver([{ kind: "done", finalCommitSha: asSha("abc") }]);
    const ac = new AbortController();
    const r = await runLoop(freshState(), {
      config: cfg, paths: runtimePaths(dir), driver, bus,
      abortSignal: ac.signal, usage: null,
      notifyOptions: { pushUrl: "", webhookUrl: "" },
    });
    expect(r.kind).toBe("done");
    if (r.kind === "done") expect(r.finalCommitSha).toBe(asSha("abc"));
  });

  test("notify_on_done fires when configured", async () => {
    const cfg = structuredClone(DEFAULTS);
    cfg.loop.target_cadence_seconds = 0;
    cfg.notify.notify_on_done = true;
    const bus = new EventBus<DriverEvent>();
    const driver = fakeDriver([{ kind: "done", finalCommitSha: asSha("xyz") }]);
    const ac = new AbortController();
    const calls: string[] = [];
    const fakeFetch = (async (url: string) => {
      calls.push(String(url));
      return new Response("", { status: 200 });
    }) as unknown as typeof fetch;
    const r = await runLoop(freshState(), {
      config: cfg, paths: runtimePaths(dir), driver, bus,
      abortSignal: ac.signal, usage: null,
      notifyOptions: { pushUrl: "https://push.example", webhookUrl: "", fetchImpl: fakeFetch },
    });
    expect(r.kind).toBe("done");
    expect(calls).toEqual(["https://push.example"]);
  });

  test("escalated outcome propagates", async () => {
    const cfg = structuredClone(DEFAULTS);
    cfg.loop.target_cadence_seconds = 0;
    const bus = new EventBus<DriverEvent>();
    const driver = fakeDriver([{ kind: "escalated", reason: "boom" }]);
    const ac = new AbortController();
    const r = await runLoop(freshState(), {
      config: cfg, paths: runtimePaths(dir), driver, bus,
      abortSignal: ac.signal, usage: null,
      notifyOptions: { pushUrl: "", webhookUrl: "" },
    });
    expect(r.kind).toBe("escalated");
  });

  test("guardrail_trip propagates", async () => {
    const cfg = structuredClone(DEFAULTS);
    cfg.loop.target_cadence_seconds = 0;
    const bus = new EventBus<DriverEvent>();
    const driver = fakeDriver([{
      kind: "guardrail_trip", which: "max_steps", limit: 1, actual: 2,
    }]);
    const ac = new AbortController();
    const r = await runLoop(freshState(), {
      config: cfg, paths: runtimePaths(dir), driver, bus,
      abortSignal: ac.signal, usage: null,
      notifyOptions: { pushUrl: "", webhookUrl: "" },
    });
    expect(r.kind).toBe("guardrail_trip");
  });

  test("rate-limit error escalates on weekly", async () => {
    const cfg = structuredClone(DEFAULTS);
    cfg.loop.target_cadence_seconds = 0;
    const bus = new EventBus<DriverEvent>();
    const driver = fakeDriver([new Error("weekly rate limit reached")]);
    const ac = new AbortController();
    const r = await runLoop(freshState(), {
      config: cfg, paths: runtimePaths(dir), driver, bus,
      abortSignal: ac.signal, usage: null,
      notifyOptions: { pushUrl: "", webhookUrl: "" },
    });
    expect(r.kind).toBe("escalated");
    if (r.kind === "escalated") expect(r.reason).toMatch(/weekly/);
  });

  test("non-rate-limit error increments failure counter", async () => {
    const cfg = structuredClone(DEFAULTS);
    cfg.loop.target_cadence_seconds = 0;
    cfg.failure.consecutive_failures_before_escalation = 1;
    cfg.failure.backoff = [0];
    const bus = new EventBus<DriverEvent>();
    const driver = fakeDriver([new Error("disk full")]);
    const ac = new AbortController();
    const state = freshState();
    const r = await runLoop(state, {
      config: cfg, paths: runtimePaths(dir), driver, bus,
      abortSignal: ac.signal, usage: null,
      notifyOptions: { pushUrl: "", webhookUrl: "" },
    });
    expect(r.kind).toBe("escalated");
    expect(state.consecutive_failures).toBeGreaterThanOrEqual(1);
  });

  test("abort during cadence sleep returns cancelled", async () => {
    const cfg = structuredClone(DEFAULTS);
    cfg.loop.target_cadence_seconds = 60; // ensures we sleep
    const bus = new EventBus<DriverEvent>();
    // Provide a successful run, then an aborter to interrupt the sleep.
    const driver = fakeDriver([
      { kind: "ran", outcome: "success", result: {
        subtype: "success", stop_reason: "end_turn", num_turns: 1,
        total_cost_usd: 0, duration_ms: 0, usage: {
          input_tokens: 0, output_tokens: 0,
          cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
        }, session_id: asSessionId(""), final_text: "", errors: [],
      } },
    ]);
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 30);
    const r = await runLoop(freshState(), {
      config: cfg, paths: runtimePaths(dir), driver, bus,
      abortSignal: ac.signal, usage: null,
      notifyOptions: { pushUrl: "", webhookUrl: "" },
    });
    expect(r.kind).toBe("cancelled");
  });

  test("re-entering with state.paused waits out the pause then runs", async () => {
    const cfg = structuredClone(DEFAULTS);
    cfg.loop.target_cadence_seconds = 0;
    const bus = new EventBus<DriverEvent>();
    const driver = fakeDriver([{ kind: "done", finalCommitSha: asSha("xyz") }]);
    const ac = new AbortController();
    const state = freshState();
    state.state = "paused";
    state.pause = pausedFor(120);
    const events: DriverEvent[] = [];
    bus.subscribe((e) => events.push(e));
    const r = await runLoop(state, {
      config: cfg, paths: runtimePaths(dir), driver, bus,
      abortSignal: ac.signal, usage: null,
      notifyOptions: { pushUrl: "", webhookUrl: "" },
    });
    expect(r.kind).toBe("done");
    expect(state.pause).toBeNull();
    expect(state.state as string).toBe("running");
    expect(events.some((e) => e.type === "pause_exit")).toBe(true);
  });

  test("usage gate >= seven_day threshold escalates pre-step", async () => {
    const cfg = structuredClone(DEFAULTS);
    cfg.loop.target_cadence_seconds = 0;
    cfg.loop.escalate_at_utilization = 80;
    const bus = new EventBus<DriverEvent>();
    const driver = fakeDriver([{ kind: "done", finalCommitSha: asSha("never") }]);
    const ac = new AbortController();
    const usage = fakeUsage([{ kind: "ok", snapshot: snapshot(10, 90) }]);
    const r = await runLoop(freshState(), {
      config: cfg, paths: runtimePaths(dir), driver, bus,
      abortSignal: ac.signal, usage,
      notifyOptions: { pushUrl: "", webhookUrl: "" },
    });
    expect(r).toMatchObject({ kind: "escalated", reason: expect.stringMatching(/weekly/i) });
  });

  test("usage gate >= five_hour threshold pauses then resumes when window clears", async () => {
    const cfg = structuredClone(DEFAULTS);
    cfg.loop.target_cadence_seconds = 0;
    cfg.loop.pause_at_utilization = 95;
    cfg.loop.escalate_at_utilization = 80;
    const bus = new EventBus<DriverEvent>();
    const driver = fakeDriver([{ kind: "done", finalCommitSha: asSha("xyz") }]);
    const ac = new AbortController();
    const usage = fakeUsage([
      { kind: "ok", snapshot: snapshot(96, 10, 100) },
      { kind: "ok", snapshot: snapshot(10, 10) },
    ]);
    const events: DriverEvent[] = [];
    bus.subscribe((e) => events.push(e));
    const r = await runLoop(freshState(), {
      config: cfg, paths: runtimePaths(dir), driver, bus,
      abortSignal: ac.signal, usage,
      notifyOptions: { pushUrl: "", webhookUrl: "" },
    });
    expect(r.kind).toBe("done");
    expect(events.some((e) => e.type === "pause_enter")).toBe(true);
    expect(events.some((e) => e.type === "pause_exit")).toBe(true);
  });

  test("usage gate auth_error escalates pre-step", async () => {
    const cfg = structuredClone(DEFAULTS);
    cfg.loop.target_cadence_seconds = 0;
    const bus = new EventBus<DriverEvent>();
    const driver = fakeDriver([{ kind: "done", finalCommitSha: asSha("never") }]);
    const ac = new AbortController();
    const usage = fakeUsage([{ kind: "auth_error", status: 401 }]);
    const r = await runLoop(freshState(), {
      config: cfg, paths: runtimePaths(dir), driver, bus,
      abortSignal: ac.signal, usage,
      notifyOptions: { pushUrl: "", webhookUrl: "" },
    });
    expect(r).toMatchObject({ kind: "escalated", reason: expect.stringMatching(/auth_error/) });
  });

  test("usage gate endpoint_unavailable does NOT escalate, emits usage_degraded once", async () => {
    const cfg = structuredClone(DEFAULTS);
    cfg.loop.target_cadence_seconds = 0;
    const bus = new EventBus<DriverEvent>();
    const driver = fakeDriver([{ kind: "done", finalCommitSha: asSha("ok123") }]);
    const ac = new AbortController();
    const usage = fakeUsage([
      { kind: "endpoint_unavailable", status: 403, lastGood: null },
    ]);
    const events: DriverEvent[] = [];
    bus.subscribe((e) => events.push(e));
    const r = await runLoop(freshState(), {
      config: cfg, paths: runtimePaths(dir), driver, bus,
      abortSignal: ac.signal, usage,
      notifyOptions: { pushUrl: "", webhookUrl: "" },
    });
    expect(r.kind).toBe("done");
    const degraded = events.filter((e) => e.type === "usage_degraded");
    expect(degraded.length).toBe(1);
    expect(degraded[0]).toMatchObject({
      type: "usage_degraded",
      status: 403,
      reason: expect.stringMatching(/user:profile|forbidden/i),
    });
  });

  test("usage gate emits usage_degraded only once across multiple steps", async () => {
    const cfg = structuredClone(DEFAULTS);
    cfg.loop.target_cadence_seconds = 0;
    const bus = new EventBus<DriverEvent>();
    const driver = fakeDriver([
      { kind: "ran", result: { kind: "ok", finalCommitSha: asSha("aaa") } as never, outcome: "no-op" },
      { kind: "done", finalCommitSha: asSha("bbb") },
    ]);
    const ac = new AbortController();
    const usage = fakeUsage([
      { kind: "endpoint_unavailable", status: 403, lastGood: null },
      { kind: "endpoint_unavailable", status: 403, lastGood: null },
    ]);
    const events: DriverEvent[] = [];
    bus.subscribe((e) => events.push(e));
    await runLoop(freshState(), {
      config: cfg, paths: runtimePaths(dir), driver, bus,
      abortSignal: ac.signal, usage,
      notifyOptions: { pushUrl: "", webhookUrl: "" },
    });
    const degraded = events.filter((e) => e.type === "usage_degraded");
    expect(degraded.length).toBe(1);
  });

  test("rate-limit error with parseable reset pauses then resumes", async () => {
    const cfg = structuredClone(DEFAULTS);
    cfg.loop.target_cadence_seconds = 0;
    const bus = new EventBus<DriverEvent>();
    const ts = isoFromMs(Date.now() + 100);
    const driver = fakeDriver([
      new Error(`5h session limit; resets at ${ts}`),
      { kind: "done", finalCommitSha: asSha("ok") },
    ]);
    const ac = new AbortController();
    const events: DriverEvent[] = [];
    bus.subscribe((e) => events.push(e));
    const r = await runLoop(freshState(), {
      config: cfg, paths: runtimePaths(dir), driver, bus,
      abortSignal: ac.signal, usage: null,
      notifyOptions: { pushUrl: "", webhookUrl: "" },
    });
    expect(r.kind).toBe("done");
    const pe = events.find((e) => e.type === "pause_enter");
    expect(pe).toBeDefined();
  });

  test("abort during pause returns cancelled", async () => {
    const cfg = structuredClone(DEFAULTS);
    cfg.loop.target_cadence_seconds = 0;
    const bus = new EventBus<DriverEvent>();
    const driver = fakeDriver([{ kind: "done", finalCommitSha: asSha("never") }]);
    const ac = new AbortController();
    const state = freshState();
    state.state = "paused";
    state.pause = pausedFor(60_000);
    setTimeout(() => ac.abort(), 30);
    const r = await runLoop(state, {
      config: cfg, paths: runtimePaths(dir), driver, bus,
      abortSignal: ac.signal, usage: null,
      notifyOptions: { pushUrl: "", webhookUrl: "" },
    });
    expect(r.kind).toBe("cancelled");
    expect(state.pause).not.toBeNull();
  });
});
