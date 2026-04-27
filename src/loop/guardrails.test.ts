import { describe, expect, test } from "bun:test";
import { DEFAULTS } from "../config/schema.ts";
import { checkGuardrails } from "./guardrails.ts";

describe("checkGuardrails", () => {
  test("under both → pass", () => {
    expect(checkGuardrails(DEFAULTS.loop, { currentStep: 1, wallClockMs: 0 }).trip)
      .toBe(false);
  });
  test("max_steps trip", () => {
    const cfg = { ...DEFAULTS.loop, max_steps: 5 };
    const r = checkGuardrails(cfg, { currentStep: 6, wallClockMs: 0 });
    expect(r.trip).toBe(true);
    if (r.trip) expect(r.which).toBe("max_steps");
  });
  test("max_steps = 0 disables", () => {
    const cfg = { ...DEFAULTS.loop, max_steps: 0 };
    expect(checkGuardrails(cfg, { currentStep: 999_999, wallClockMs: 0 }).trip)
      .toBe(false);
  });
  test("max_wall_clock trip", () => {
    const cfg = { ...DEFAULTS.loop, max_wall_clock: "1s" };
    const r = checkGuardrails(cfg, { currentStep: 1, wallClockMs: 2000 });
    expect(r.trip).toBe(true);
    if (r.trip) expect(r.which).toBe("max_wall_clock");
  });
  test("empty wall_clock disables", () => {
    const cfg = { ...DEFAULTS.loop, max_wall_clock: "" };
    expect(checkGuardrails(cfg, { currentStep: 1, wallClockMs: 1e15 }).trip)
      .toBe(false);
  });
});
