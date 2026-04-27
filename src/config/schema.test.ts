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
});
