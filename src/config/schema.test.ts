import { describe, expect, test } from "bun:test";
import { ConfigError, DEFAULTS, mergeConfig } from "./schema.ts";

describe("mergeConfig", () => {
  test("undefined returns defaults clone", () => {
    const cfg = mergeConfig(undefined);
    expect(cfg).toEqual(DEFAULTS);
    expect(cfg).not.toBe(DEFAULTS);
  });

  test("partial override merges with defaults", () => {
    const cfg = mergeConfig({ loop: { max_steps: 10 } });
    expect(cfg.loop.max_steps).toBe(10);
    expect(cfg.loop.max_wall_clock).toBe(DEFAULTS.loop.max_wall_clock);
    expect(cfg.claude).toEqual(DEFAULTS.claude);
  });

  test("unknown top-level key errors", () => {
    expect(() => mergeConfig({ bogus: 1 })).toThrow(ConfigError);
  });

  test("unknown nested key errors with key path", () => {
    expect(() => mergeConfig({ loop: { bogus: 1 } })).toThrow(/loop\.bogus/);
  });

  test("wrong type errors with key path", () => {
    expect(() => mergeConfig({ loop: { max_steps: "ten" } })).toThrow(
      /loop\.max_steps/,
    );
  });

  test("future schema_version errors", () => {
    expect(() => mergeConfig({ schema_version: 999 })).toThrow(/upgrade ccloop/);
  });

  test("backoff array accepted", () => {
    const cfg = mergeConfig({ failure: { backoff: [10, 20] } });
    expect(cfg.failure.backoff).toEqual([10, 20]);
  });

  test("rejects max_turns_per_step < 1", () => {
    expect(() => mergeConfig({ claude: { max_turns_per_step: 0 } })).toThrow(
      /max_turns_per_step.*>= 1/,
    );
  });

  test("rejects negative max_steps_per_session", () => {
    expect(() => mergeConfig({ claude: { max_steps_per_session: -1 } })).toThrow(
      /max_steps_per_session.*>= 0/,
    );
  });

  test("rejects out-of-range utilization thresholds", () => {
    expect(() => mergeConfig({ loop: { pause_at_utilization: 150 } })).toThrow(
      /pause_at_utilization.*\[0, 100\]/,
    );
    expect(() => mergeConfig({ loop: { escalate_at_utilization: -5 } })).toThrow(
      /escalate_at_utilization.*\[0, 100\]/,
    );
  });

  test("rejects negative backoff entry", () => {
    expect(() => mergeConfig({ failure: { backoff: [10, -1] } })).toThrow(
      /backoff\[1\]/,
    );
  });

  test("rejects failure.consecutive_failures_before_escalation < 1", () => {
    expect(() =>
      mergeConfig({ failure: { consecutive_failures_before_escalation: 0 } }),
    ).toThrow(/consecutive_failures_before_escalation.*>= 1/);
  });

  test("rejects failure.no_progress_threshold < 1", () => {
    expect(() => mergeConfig({ failure: { no_progress_threshold: 0 } })).toThrow(
      /no_progress_threshold.*>= 1/,
    );
  });

  test("rejects failure.loop_detection_repeats < 2", () => {
    expect(() => mergeConfig({ failure: { loop_detection_repeats: 1 } })).toThrow(
      /loop_detection_repeats.*>= 2/,
    );
  });

  test("rejects unparseable max_wall_clock", () => {
    expect(() => mergeConfig({ loop: { max_wall_clock: "garbage" } })).toThrow(
      /max_wall_clock.*parseable/,
    );
  });

  test("empty max_wall_clock disables the guardrail (no throw)", () => {
    const cfg = mergeConfig({ loop: { max_wall_clock: "" } });
    expect(cfg.loop.max_wall_clock).toBe("");
  });
});
