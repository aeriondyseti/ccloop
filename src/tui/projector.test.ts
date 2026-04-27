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
});
