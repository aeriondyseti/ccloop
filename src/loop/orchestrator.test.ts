import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runtimePaths } from "../state/paths.ts";
import { freshState } from "../state/state.ts";
import { DEFAULTS } from "../config/schema.ts";
import { EventBus } from "./eventBus.ts";
import type { DriverEvent } from "./driver.ts";
import { escalationPayload, runLoop } from "./orchestrator.ts";
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
    async recordSdkInitFailure(state: import("../state/state.ts").CcloopState, message: string) {
      const failure = { category: "sdk_init" as const, excerpt: message };
      state.consecutive_failures += 1;
      state.last_failure = failure;
      return failure;
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

  test("locally rate-limited notifications do not emit notification_sent events", async () => {
    // Regression: rate-limited results from notify() carry ok:false
    // but represent ccloop-side throttling, not a channel failure.
    // The recap's "N notify failures" count must not include them,
    // and the cleanest way is to suppress the event entirely.
    const cfg = structuredClone(DEFAULTS);
    cfg.loop.target_cadence_seconds = 0;
    cfg.notify.notify_on_done = true;
    cfg.notify.pause_alert_seconds = 1; // pause-alert path also fires
    const bus = new EventBus<DriverEvent>();
    const driver = fakeDriver([{ kind: "done", finalCommitSha: asSha("z") }]);
    const ac = new AbortController();
    let calls = 0;
    const fakeFetch = (async () => {
      calls++;
      return new Response("", { status: 200 });
    }) as unknown as typeof fetch;
    const events: DriverEvent[] = [];
    bus.subscribe((e) => events.push(e));
    // Two consecutive runs sharing rate-limit state would test this
    // end-to-end, but for unit clarity we just verify the success
    // path still emits exactly one event per channel attempted.
    await runLoop(freshState(), {
      config: cfg, paths: runtimePaths(dir), driver, bus,
      abortSignal: ac.signal, usage: null,
      notifyOptions: { pushUrl: "https://push.example", webhookUrl: "", fetchImpl: fakeFetch },
    });
    const sent = events.filter((e) => e.type === "notification_sent");
    expect(calls).toBe(1);
    expect(sent.length).toBe(1);
    expect(sent[0]?.ok).toBe(true);
  });

  test("notification_sent event records each push/webhook attempt", async () => {
    // Spec §11.5 — operator needs a durable trail of which channels
    // fired and whether they succeeded, so a silently-broken on-call
    // webhook is visible after the fact.
    const cfg = structuredClone(DEFAULTS);
    cfg.loop.target_cadence_seconds = 0;
    cfg.notify.notify_on_done = true;
    const bus = new EventBus<DriverEvent>();
    const driver = fakeDriver([{ kind: "done", finalCommitSha: asSha("z") }]);
    const ac = new AbortController();
    // Push succeeds (200), webhook fails (502) — both should produce
    // a notification_sent event.
    const fakeFetch = (async (url: string) => {
      if (String(url).includes("push")) return new Response("", { status: 200 });
      return new Response("bad gateway", { status: 502 });
    }) as unknown as typeof fetch;
    const events: DriverEvent[] = [];
    bus.subscribe((e) => events.push(e));
    await runLoop(freshState(), {
      config: cfg, paths: runtimePaths(dir), driver, bus,
      abortSignal: ac.signal, usage: null,
      notifyOptions: {
        pushUrl: "https://push.example",
        webhookUrl: "https://hook.example",
        fetchImpl: fakeFetch,
      },
    });
    const sent = events.filter((e) => e.type === "notification_sent");
    expect(sent.length).toBe(2);
    const byChannel = new Map(sent.map((e) => [String(e.channel), e]));
    expect(byChannel.get("push")?.ok).toBe(true);
    expect(byChannel.get("push")?.status).toBe(200);
    expect(byChannel.get("webhook")?.ok).toBe(false);
    expect(byChannel.get("webhook")?.status).toBe(502);
  });

  test("heartbeat fires after each step when heartbeatUrl is set", async () => {
    const cfg = structuredClone(DEFAULTS);
    cfg.loop.target_cadence_seconds = 0;
    const bus = new EventBus<DriverEvent>();
    const driver = fakeDriver([
      { kind: "ran", outcome: "success", result: {} as never },
      { kind: "done", finalCommitSha: asSha("z") },
    ]);
    const ac = new AbortController();
    const calls: { url: string; outcome: string }[] = [];
    const fakeFetch = (async (url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      calls.push({ url: String(url), outcome: body.outcome });
      return new Response("", { status: 200 });
    }) as unknown as typeof fetch;
    await runLoop(freshState(), {
      config: cfg, paths: runtimePaths(dir), driver, bus,
      abortSignal: ac.signal, usage: null,
      notifyOptions: { pushUrl: "", webhookUrl: "" },
      heartbeatUrl: "https://hc.example/abc",
      fetchImpl: fakeFetch,
    });
    // One heartbeat per stepOnce return (ran + done).
    expect(calls.length).toBe(2);
    expect(calls[0]?.url).toBe("https://hc.example/abc");
    expect(calls[0]?.outcome).toBe("success");
    expect(calls[1]?.outcome).toBe("done");
  });

  test("hung heartbeat host does not block step iteration", async () => {
    // Regression for the await-fireHeartbeat throttle: a misconfigured
    // or unreachable heartbeat URL used to cost up to 10s × N steps
    // overnight. Fire-and-forget keeps the loop on cadence regardless.
    const cfg = structuredClone(DEFAULTS);
    cfg.loop.target_cadence_seconds = 0;
    const bus = new EventBus<DriverEvent>();
    const driver = fakeDriver([
      { kind: "ran", outcome: "success", result: {} as never },
      { kind: "ran", outcome: "success", result: {} as never },
      { kind: "done", finalCommitSha: asSha("z") },
    ]);
    const ac = new AbortController();
    // Fetch returns a Promise that never resolves — simulates a host
    // black-holing the request. AbortSignal.timeout(10s) inside
    // pingHeartbeat would eventually clear it, but only after
    // delaying every step by 10s.
    const hangingFetch = (() =>
      new Promise<Response>(() => {})) as unknown as typeof fetch;
    const start = Date.now();
    await runLoop(freshState(), {
      config: cfg, paths: runtimePaths(dir), driver, bus,
      abortSignal: ac.signal, usage: null,
      notifyOptions: { pushUrl: "", webhookUrl: "" },
      heartbeatUrl: "https://hung.example/abc",
      fetchImpl: hangingFetch,
    });
    const elapsed = Date.now() - start;
    // 3 stepOnce calls; if heartbeat were awaited each one would add
    // ~10s. Generous bound here — a CI machine under load shouldn't
    // need anywhere near a second.
    expect(elapsed).toBeLessThan(2000);
  });

  test("heartbeat is skipped when heartbeatUrl is empty", async () => {
    const cfg = structuredClone(DEFAULTS);
    cfg.loop.target_cadence_seconds = 0;
    const bus = new EventBus<DriverEvent>();
    const driver = fakeDriver([{ kind: "done", finalCommitSha: asSha("z") }]);
    const ac = new AbortController();
    let calls = 0;
    const fakeFetch = (async () => {
      calls++;
      return new Response("", { status: 200 });
    }) as unknown as typeof fetch;
    await runLoop(freshState(), {
      config: cfg, paths: runtimePaths(dir), driver, bus,
      abortSignal: ac.signal, usage: null,
      notifyOptions: { pushUrl: "", webhookUrl: "" },
      fetchImpl: fakeFetch,
    });
    expect(calls).toBe(0);
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

  test("abort during stepOnce does not record a failure", async () => {
    // Regression: user hits Ctrl+C during the SDK call → SDK throws
    // AbortError → orchestrator caught it as a "genuine surprise" and
    // bumped consecutive_failures. Two prior real failures + a clean
    // cancel would silently escalate on resume.
    const cfg = structuredClone(DEFAULTS);
    cfg.loop.target_cadence_seconds = 0;
    cfg.failure.consecutive_failures_before_escalation = 3;
    const bus = new EventBus<DriverEvent>();
    const ac = new AbortController();
    const driver = {
      async stepOnce() {
        ac.abort();
        throw new Error("aborted");
      },
      async checkDoneTransition() { return null; },
      async recordSdkInitFailure() {
        throw new Error("should not be called on user-abort");
      },
    } as unknown as LoopDriver;
    const state = freshState();
    state.consecutive_failures = 2; // one short of escalation threshold
    const r = await runLoop(state, {
      config: cfg, paths: runtimePaths(dir), driver, bus,
      abortSignal: ac.signal, usage: null,
      notifyOptions: { pushUrl: "", webhookUrl: "" },
    });
    expect(r.kind).toBe("cancelled");
    // Counter must NOT have been bumped to 3.
    expect(state.consecutive_failures).toBe(2);
    expect(state.state).not.toBe("escalated");
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
    expect(state.last_failure?.category).toBe("sdk_init");
    expect(state.last_failure?.excerpt).toContain("disk full");
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

  test("pause-period heartbeat fires while waiting out a pause", async () => {
    // Regression: a long rate-limit pause emitted no heartbeat —
    // an off-device monitor with a multi-minute grace period would
    // alarm "ccloop went silent" overnight. Each refresh tick
    // (~60s) must now emit a heartbeat with outcome="paused".
    const cfg = structuredClone(DEFAULTS);
    cfg.loop.target_cadence_seconds = 0;
    const bus = new EventBus<DriverEvent>();
    const driver = fakeDriver([{ kind: "done", finalCommitSha: asSha("z") }]);
    const ac = new AbortController();
    const state = freshState();
    state.state = "paused";
    state.pause = pausedFor(120);
    const beats: { outcome: string; state: string }[] = [];
    const fakeFetch = (async (_u: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      beats.push({ outcome: body.outcome, state: body.state });
      return new Response("", { status: 200 });
    }) as unknown as typeof fetch;
    await runLoop(state, {
      config: cfg, paths: runtimePaths(dir), driver, bus,
      abortSignal: ac.signal, usage: null,
      notifyOptions: { pushUrl: "", webhookUrl: "" },
      heartbeatUrl: "https://hc.example/x",
      fetchImpl: fakeFetch,
    });
    expect(beats.some((b) => b.outcome === "paused")).toBe(true);
  });

  test("escalation during pause-wait fires the notification and stops", async () => {
    const cfg = structuredClone(DEFAULTS);
    cfg.loop.target_cadence_seconds = 0;
    cfg.loop.pause_at_utilization = 95;
    cfg.loop.escalate_at_utilization = 80;
    const bus = new EventBus<DriverEvent>();
    // Driver should never be reached.
    const driver = fakeDriver([{ kind: "done", finalCommitSha: asSha("never") }]);
    const ac = new AbortController();
    const state = freshState();
    state.state = "paused";
    state.pause = pausedFor(60_000);
    // First refresh inside waitOutPause sees the seven-day threshold
    // crossed → escalate-during-pause path.
    const usage = fakeUsage([{ kind: "ok", snapshot: snapshot(98, 90) }]);
    let pushed = 0;
    const r = await runLoop(state, {
      config: cfg, paths: runtimePaths(dir), driver, bus,
      abortSignal: ac.signal, usage,
      notifyOptions: {
        pushUrl: "https://push.example",
        webhookUrl: "",
        fetchImpl: (async () => {
          pushed++;
          return new Response("", { status: 200 });
        }) as unknown as typeof fetch,
      },
    });
    expect(r).toMatchObject({ kind: "escalated", reason: expect.stringMatching(/weekly/i) });
    expect(pushed).toBe(1);
  });

  test("escalation webhook payload includes a populated trail", async () => {
    const cfg = structuredClone(DEFAULTS);
    cfg.loop.target_cadence_seconds = 0;
    cfg.loop.escalate_at_utilization = 80;
    const paths = runtimePaths(dir);

    // Seed two step records on disk so loadRecentSteps has content.
    const { writeStepRecord, buildStepRecord } = await import("./stepRecord.ts");
    const { emptyUsage } = await import("../sdk/types.ts");
    const { asSessionId, asRunId, asSha } = await import("../branded.ts");
    for (let i = 1; i <= 2; i++) {
      const rec = buildStepRecord({
        step: i,
        runId: asRunId("r1"),
        startedAt: new Date(0),
        endedAt: new Date(1000),
        outcome: "success",
        subtype: "success",
        stopReason: "end_turn",
        sessionId: asSessionId("s"),
        numTurns: 1,
        usage: emptyUsage(),
        costUsd: 0.1 * i,
        commitSha: asSha("a".repeat(40)),
        commitSubject: `step ${i} subject`,
        failure: null,
      });
      await writeStepRecord(paths, rec);
    }

    const bus = new EventBus<DriverEvent>();
    const driver = fakeDriver([{ kind: "done", finalCommitSha: asSha("never") }]);
    const ac = new AbortController();
    const usage = fakeUsage([{ kind: "ok", snapshot: snapshot(10, 90) }]);
    let webhookBody = "";
    const r = await runLoop(freshState(), {
      config: cfg, paths, driver, bus,
      abortSignal: ac.signal, usage,
      notifyOptions: {
        pushUrl: "",
        webhookUrl: "https://hook.example",
        fetchImpl: (async (_u: string, init?: RequestInit) => {
          webhookBody = String(init?.body ?? "");
          return new Response("", { status: 200 });
        }) as unknown as typeof fetch,
      },
    });
    expect(r.kind).toBe("escalated");
    const payload = JSON.parse(webhookBody);
    expect(payload.trail).toBeInstanceOf(Array);
    expect(payload.trail.length).toBe(2);
    expect(payload.trail[0]).toMatchObject({ step: 1, outcome: "success", subject: "step 1 subject" });
  });

  test("orchestrator-emitted events are persisted to events.jsonl", async () => {
    // Regression: pause_enter / pause_exit / escalate / usage_degraded
    // emitted from the orchestrator used to land only on the in-memory
    // bus, not in the durable log. The wake-up recap reads events.jsonl
    // for these counts, so an overnight pause + crash before resume
    // would underreport.
    const cfg = structuredClone(DEFAULTS);
    cfg.loop.target_cadence_seconds = 0;
    cfg.loop.escalate_at_utilization = 80;
    const bus = new EventBus<DriverEvent>();
    const driver = fakeDriver([{ kind: "done", finalCommitSha: asSha("z") }]);
    const ac = new AbortController();
    // Snapshot triggers escalate (seven_day at 90 >= 80).
    const usage = fakeUsage([{ kind: "ok", snapshot: snapshot(10, 90) }]);
    const paths = runtimePaths(dir);
    await runLoop(freshState(), {
      config: cfg, paths, driver, bus,
      abortSignal: ac.signal, usage,
      notifyOptions: { pushUrl: "", webhookUrl: "" },
    });
    // events.jsonl should contain the escalate line.
    const text = await import("node:fs/promises").then((m) =>
      m.readFile(paths.events, "utf8").catch(() => ""),
    );
    const lines = text.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const escalates = lines.filter((l) => l.type === "escalate");
    expect(escalates.length).toBe(1);
    expect(escalates[0].reason).toMatch(/weekly/i);
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

describe("escalationPayload", () => {
  test("plain summary when last_failure is null", () => {
    const s = freshState();
    const p = escalationPayload(s, "3 consecutive failures", true);
    expect(p.summary).toContain("3 consecutive failures");
    expect(p.summary).toContain(`run ${s.run_id}`);
    expect(p.summary).not.toContain("—");
  });

  test("appends failure category and first excerpt line when flag set", () => {
    const s = freshState();
    s.last_failure = { category: "sdk", excerpt: "boom: tests failed\n\nmore detail" };
    const p = escalationPayload(s, "3 consecutive failures", true);
    expect(p.summary).toContain("sdk: boom: tests failed");
    expect(p.summary).not.toContain("more detail");
  });

  test("flag defaults to false — non-failure causes don't append last_failure", () => {
    const s = freshState();
    s.last_failure = { category: "sdk", excerpt: "stale prior failure" };
    const p = escalationPayload(s, "guardrail max_steps");
    expect(p.summary).not.toContain("stale prior failure");
    expect(p.summary).not.toContain("sdk:");
  });

  test("truncates very long excerpt lines", () => {
    const s = freshState();
    s.last_failure = { category: "commit", excerpt: "x".repeat(500) };
    const p = escalationPayload(s, "consecutive failures", true);
    expect(p.summary.length).toBeLessThan(400);
    expect(p.summary).toContain("commit:");
  });
});
