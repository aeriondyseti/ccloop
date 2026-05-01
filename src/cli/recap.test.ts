import { describe, expect, test } from "bun:test";
import type { StepRecord } from "../loop/stepRecord.ts";
import type { EventBase } from "../state/events.ts";
import {
  asIsoTimestamp, asRunId, asSessionId, asSha,
} from "../branded.ts";
import { buildRecap } from "./recap.ts";

const NOW = new Date("2026-05-01T12:00:00.000Z");

function step(over: Partial<StepRecord>): StepRecord {
  return {
    step: 1,
    run_id: asRunId("run"),
    started_at: asIsoTimestamp("2026-05-01T11:55:00.000Z"),
    ended_at: asIsoTimestamp("2026-05-01T11:56:00.000Z"),
    duration_ms: 60_000,
    outcome: "success",
    subtype: "success",
    stop_reason: null,
    session_id: asSessionId(""),
    num_turns: 1,
    usage: {
      input_tokens: 0, output_tokens: 0,
      cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
    },
    cost_usd: 0,
    cache_hit_rate: 0,
    commit_sha: asSha(""),
    commit_subject: "",
    failure: null,
    ...over,
  };
}

function event(type: string, ts: string): EventBase {
  return {
    type: type as EventBase["type"],
    ts: asIsoTimestamp(ts),
    run_id: asRunId("run"),
    step: 1,
  };
}

describe("buildRecap", () => {
  test("empty input → empty string", () => {
    expect(buildRecap({ steps: [], events: [], now: NOW })).toBe("");
  });

  test("checklist line is rendered when total > 0", () => {
    const r = buildRecap({
      steps: [],
      events: [event("escalate", "2026-05-01T11:00:00.000Z")],
      now: NOW,
      checklist: { done: 7, total: 12 },
    });
    expect(r).toContain("checklist: 7/12 done (58%)");
  });

  test("checklist with zero total is suppressed", () => {
    const r = buildRecap({
      steps: [],
      events: [event("escalate", "2026-05-01T11:00:00.000Z")],
      now: NOW,
      checklist: { done: 0, total: 0 },
    });
    expect(r).not.toContain("checklist:");
  });

  test("checklist alone surfaces a recap even with no steps/events", () => {
    const r = buildRecap({
      steps: [], events: [], now: NOW,
      checklist: { done: 0, total: 5 },
    });
    expect(r).toContain("checklist: 0/5 done (0%)");
  });

  test("renders summary lines for steps + events", () => {
    const recap = buildRecap({
      steps: [
        step({ step: 1, outcome: "success", cost_usd: 0.10, commit_subject: "feat: x" }),
        step({
          step: 2, outcome: "failure", cost_usd: 0.05,
          failure: { category: "gate", excerpt: "..." },
        }),
        step({
          step: 3, outcome: "failure", cost_usd: 0.05,
          failure: { category: "gate", excerpt: "..." },
          ended_at: asIsoTimestamp("2026-05-01T11:58:00.000Z"),
        }),
      ],
      events: [event("escalate", "2026-05-01T11:30:00.000Z")],
      now: NOW,
    });
    expect(recap).toContain("ccloop — overnight recap");
    expect(recap).toContain("last activity: 2m ago");
    expect(recap).toContain("last 3 steps:");
    expect(recap).toContain("1 ✓");
    expect(recap).toContain("2 ✗");
    expect(recap).toContain("$0.20");
    expect(recap).toContain("gate×2");
    expect(recap).toContain("last commit: feat: x");
    expect(recap).toContain("1 escalation");
  });

  test("counts sdk_init step_failed events distinctly", () => {
    const recap = buildRecap({
      steps: [],
      events: [
        { ...event("step_failed", "2026-05-01T11:00:00.000Z"), category: "sdk_init" } as EventBase,
        { ...event("step_failed", "2026-05-01T11:01:00.000Z"), category: "sdk_init" } as EventBase,
        { ...event("step_failed", "2026-05-01T11:02:00.000Z"), category: "sdk" } as EventBase,
      ],
      now: NOW,
    });
    expect(recap).toContain("2 sdk_init failures");
    // step_failed with non-sdk_init category isn't counted in this slot
    expect(recap).not.toContain("3 sdk_init");
  });

  test("counts failed notifications and surfaces multi-instance runs", () => {
    const recap = buildRecap({
      steps: [],
      events: [
        { ...event("instance_start", "2026-05-01T08:00:00.000Z") } as EventBase,
        { ...event("instance_start", "2026-05-01T10:00:00.000Z") } as EventBase,
        { ...event("instance_start", "2026-05-01T11:00:00.000Z") } as EventBase,
        { ...event("notification_sent", "2026-05-01T11:30:00.000Z"), ok: false } as EventBase,
        { ...event("notification_sent", "2026-05-01T11:31:00.000Z"), ok: true } as EventBase,
        { ...event("notification_sent", "2026-05-01T11:32:00.000Z"), ok: false } as EventBase,
      ],
      now: NOW,
    });
    expect(recap).toContain("2 notify failures");
    expect(recap).toContain("instances: 3");
  });

  test("prior crash detected from unpaired instance_start", () => {
    // Three starts, one exit → two starts unpaired. The CURRENT
    // instance accounts for one (it hasn't exited yet); the other
    // is a prior crash (SIGKILL, OOM, machine reboot).
    const recap = buildRecap({
      steps: [],
      events: [
        { ...event("instance_start", "2026-05-01T08:00:00.000Z") } as EventBase,
        { ...event("instance_start", "2026-05-01T09:00:00.000Z") } as EventBase, // crashed
        { ...event("instance_start", "2026-05-01T11:00:00.000Z") } as EventBase, // current
        { ...event("instance_exit", "2026-05-01T08:30:00.000Z"), reason: "done" } as EventBase,
      ],
      now: NOW,
    });
    expect(recap).toContain("1 prior instance");
    expect(recap).toContain("did not exit cleanly");
  });

  test("recovery_commit is surfaced when paired with a prior crash", () => {
    const recap = buildRecap({
      steps: [],
      events: [
        { ...event("instance_start", "2026-05-01T08:00:00.000Z") } as EventBase,
        { ...event("instance_start", "2026-05-01T11:00:00.000Z") } as EventBase, // current
        {
          ...event("recovery_commit", "2026-05-01T11:00:01.000Z"),
          commit_sha: "abc1234deadbeef",
          commit_subject: "chore(ccloop): recovery commit before resume of step 7",
        } as EventBase,
      ],
      now: NOW,
    });
    expect(recap).toContain("did not exit cleanly");
    expect(recap).toContain("recovery commit abc1234");
  });

  test("escalation_resolved actions are surfaced when paired with escalations", () => {
    const recap = buildRecap({
      steps: [],
      events: [
        { ...event("escalate", "2026-05-01T10:00:00.000Z") } as EventBase,
        { ...event("escalate", "2026-05-01T10:30:00.000Z") } as EventBase,
        { ...event("escalation_resolved", "2026-05-01T10:01:00.000Z"), action: "continue" } as EventBase,
        { ...event("escalation_resolved", "2026-05-01T10:31:00.000Z"), action: "revert" } as EventBase,
      ],
      now: NOW,
    });
    expect(recap).toContain("2 escalations");
    expect(recap).toContain("escalations resolved:");
    expect(recap).toContain("1 continue");
    expect(recap).toContain("1 revert");
  });

  test("clean multi-instance run does not warn about crashes", () => {
    // Two starts, one exit → only one unpaired (the current one).
    // No crash to warn about.
    const recap = buildRecap({
      steps: [],
      events: [
        { ...event("instance_start", "2026-05-01T08:00:00.000Z") } as EventBase,
        { ...event("instance_start", "2026-05-01T11:00:00.000Z") } as EventBase, // current
        { ...event("instance_exit", "2026-05-01T10:00:00.000Z"), reason: "done" } as EventBase,
      ],
      now: NOW,
    });
    expect(recap).not.toContain("did not exit cleanly");
  });

  test("single-instance run does not print the instance-count line", () => {
    const recap = buildRecap({
      steps: [],
      events: [
        { ...event("instance_start", "2026-05-01T08:00:00.000Z") } as EventBase,
        { ...event("escalate", "2026-05-01T11:00:00.000Z") } as EventBase,
      ],
      now: NOW,
    });
    expect(recap).not.toContain("instances:");
    expect(recap).toContain("1 escalation");
  });

  test("only events, no steps", () => {
    const recap = buildRecap({
      steps: [],
      events: [event("pause_enter", "2026-05-01T11:00:00.000Z")],
      now: NOW,
    });
    expect(recap).toContain("1 pause");
  });
});
