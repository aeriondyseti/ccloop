import { describe, expect, test } from "bun:test";
import { project } from "./projector.ts";
import { freshState } from "../state/state.ts";
import { emptyUsage } from "../sdk/types.ts";
import type { StepRecord } from "../loop/stepRecord.ts";
import { asIsoTimestamp, asRunId, asSessionId, asSha } from "../branded.ts";

function rec(p: Partial<StepRecord>): StepRecord {
  return {
    step: 1, run_id: asRunId("r"),
    started_at: asIsoTimestamp(""), ended_at: asIsoTimestamp(""),
    duration_ms: 0, outcome: "success", subtype: "success",
    stop_reason: null, session_id: asSessionId(""), num_turns: 0,
    usage: emptyUsage(), cost_usd: 0, cache_hit_rate: 0,
    commit_sha: asSha(""), commit_subject: "", failure: null, ...p,
  };
}

describe("project", () => {
  test("RUNNING with no records → empty rolling stats", () => {
    const s = freshState();
    const v = project({
      state: s, cwd: "/x", usage: null, recent: [], events: [], now: new Date(),
    });
    expect(v.state).toBe("RUNNING");
    expect(v.rollingCostUsd).toBe(0);
    expect(v.controlsHint).toMatch(/ctrl-c/);
  });

  test("RUNNING controls hint advertises scroll keys", () => {
    const s = freshState();
    const v = project({
      state: s, cwd: "/x", usage: null, recent: [], events: [], now: new Date(),
    });
    expect(v.controlsHint).toMatch(/tab focus/);
    expect(v.controlsHint).toMatch(/scroll/);
  });

  test("nowContent / focus / heartbeat pass through", () => {
    const s = freshState();
    const v = project({
      state: s, cwd: "/x", usage: null, recent: [], events: [],
      now: new Date(),
      nowContent: [{ kind: "assistant_text", text: "hi", ts: "" }],
      focus: "log",
      heartbeat: "○",
    });
    expect(v.nowContent.length).toBe(1);
    expect(v.focus).toBe("log");
    expect(v.heartbeat).toBe("○");
  });

  test("nowContent / focus / heartbeat have sensible defaults", () => {
    const s = freshState();
    const v = project({
      state: s, cwd: "/x", usage: null, recent: [], events: [], now: new Date(),
    });
    expect(v.nowContent).toEqual([]);
    expect(v.focus).toBe("now");
    expect(v.heartbeat).toBe("●");
  });

  test("rolling stats sum across many records (recent-steps pane removed)", () => {
    const s = freshState();
    const many = Array.from({ length: 50 }, (_, i) =>
      rec({ step: i + 1, cost_usd: 0.1, cache_hit_rate: 0.5,
            usage: { ...emptyUsage(), input_tokens: 1, output_tokens: 1 } }));
    const v = project({
      state: s, cwd: "/x", usage: null, recent: many, events: [],
      now: new Date(),
    });
    expect(v.rollingCostUsd).toBeCloseTo(5.0);
    expect(v.rollingTokensIn).toBe(50);
    expect(v.rollingTokensOut).toBe(50);
  });

  test("rolling stats sum across records", () => {
    const s = freshState();
    const v = project({
      state: s, cwd: "/x", usage: null, events: [], now: new Date(),
      recent: [
        rec({ cost_usd: 0.1, cache_hit_rate: 1.0,
              usage: { ...emptyUsage(), input_tokens: 10, output_tokens: 5 } }),
        rec({ cost_usd: 0.2, cache_hit_rate: 0.5,
              usage: { ...emptyUsage(), input_tokens: 20, output_tokens: 5 } }),
      ],
    });
    expect(v.rollingCostUsd).toBeCloseTo(0.3);
    expect(v.rollingTokensIn).toBe(30);
    expect(v.rollingTokensOut).toBe(10);
    expect(v.averageCacheHitRate).toBe(0.75);
    expect(v.cacheLowStreak).toBe(0);
  });

  test("averageCacheHitRate excludes records with no token usage", () => {
    // step_timeout / synthesized-failure records carry empty usage and
    // a 0 cache_hit_rate. Including them would pull the displayed
    // average toward zero on overnight runs that survived a few hangs
    // even though real cache behaviour is healthy.
    const s = freshState();
    const v = project({
      state: s, cwd: "/x", usage: null, events: [], now: new Date(),
      recent: [
        rec({ cost_usd: 0.1, cache_hit_rate: 1.0,
              usage: { ...emptyUsage(), input_tokens: 10, output_tokens: 5 } }),
        // Synthesized failure: zero usage, zero rate — must not count.
        rec({ cost_usd: 0, cache_hit_rate: 0, usage: emptyUsage() }),
        rec({ cost_usd: 0.2, cache_hit_rate: 0.8,
              usage: { ...emptyUsage(), input_tokens: 20, output_tokens: 5 } }),
      ],
    });
    expect(v.averageCacheHitRate).toBeCloseTo(0.9); // (1.0 + 0.8) / 2
  });

  test("checklist is surfaced when total > 0 and suppressed otherwise", () => {
    const s = freshState();
    const v1 = project({
      state: s, cwd: "/x", usage: null, recent: [], events: [], now: new Date(),
      checklist: { done: 7, total: 12 },
    });
    expect(v1.checklist).toEqual({ done: 7, total: 12 });
    const v2 = project({
      state: s, cwd: "/x", usage: null, recent: [], events: [], now: new Date(),
      checklist: { done: 0, total: 0 },
    });
    expect(v2.checklist).toBeNull();
    const v3 = project({
      state: s, cwd: "/x", usage: null, recent: [], events: [], now: new Date(),
    });
    expect(v3.checklist).toBeNull();
  });

  test("cacheLowStreak is surfaced from state", () => {
    const s = freshState();
    s.cache_low_streak = 4;
    const v = project({
      state: s, cwd: "/x", usage: null, recent: [], events: [], now: new Date(),
    });
    expect(v.cacheLowStreak).toBe(4);
  });

  test("escalated state surfaces reason", () => {
    const s = freshState();
    s.state = "escalated";
    s.escalation = { reason: "weekly_cap", trail: [], entered_at: asIsoTimestamp("") };
    const v = project({
      state: s, cwd: "/x", usage: null, recent: [], events: [], now: new Date(),
    });
    expect(v.state).toBe("ESCALATED");
    expect(v.escalation?.reason).toBe("weekly_cap");
    expect(v.controlsHint).toMatch(/c continue/);
  });

  test("paused state surfaces countdown info", () => {
    const s = freshState();
    s.state = "paused";
    s.pause = {
      until: asIsoTimestamp("2026-04-27T14:00:00Z"),
      reason: "5h cap", window: "five_hour",
      entered_at: asIsoTimestamp(""),
    };
    const v = project({
      state: s, cwd: "/x", usage: null, recent: [], events: [], now: new Date(),
    });
    expect(v.state).toBe("PAUSED");
    expect(v.pause?.reason).toBe("5h cap");
  });

  test("operatorPaused projects to OPERATOR_PAUSED when state is running", () => {
    const s = freshState();
    const v = project({
      state: s, cwd: "/x", usage: null, recent: [], events: [], now: new Date(),
      operatorPaused: true,
    });
    expect(v.state).toBe("OPERATOR_PAUSED");
    expect(v.controlsHint).toMatch(/p resume/);
  });

  test("operatorPaused does NOT override terminal states", () => {
    const s = freshState();
    s.state = "escalated";
    s.escalation = { reason: "weekly_cap", trail: [], entered_at: asIsoTimestamp("") };
    const v = project({
      state: s, cwd: "/x", usage: null, recent: [], events: [], now: new Date(),
      operatorPaused: true,
    });
    expect(v.state).toBe("ESCALATED");
  });

  test("RUNNING controls hint advertises p pause", () => {
    const s = freshState();
    const v = project({
      state: s, cwd: "/x", usage: null, recent: [], events: [], now: new Date(),
    });
    expect(v.controlsHint).toMatch(/p pause/);
  });
});
