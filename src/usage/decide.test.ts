import { describe, expect, test } from "bun:test";
import { DEFAULT_THRESHOLDS, decideUsage } from "./decide.ts";
import { asIsoTimestamp } from "../branded.ts";

const baseSnap = (five: number, seven: number) => ({
  five_hour: { utilization: five, resets_at: asIsoTimestamp("2026-04-27T14:00:00Z") },
  seven_day: { utilization: seven, resets_at: asIsoTimestamp("2026-05-01T00:00:00Z") },
  fetched_at: 0,
});

describe("decideUsage", () => {
  test("proceed when both below threshold", () => {
    expect(decideUsage(baseSnap(50, 50)).action).toBe("proceed");
  });

  test("five_hour at threshold pauses", () => {
    const r = decideUsage(baseSnap(95, 50));
    expect(r.action).toBe("pause");
    if (r.action === "pause") expect(r.window).toBe("five_hour");
  });

  test("seven_day at threshold escalates", () => {
    const r = decideUsage(baseSnap(50, 80));
    expect(r.action).toBe("escalate");
  });

  test("seven_day wins when both above", () => {
    expect(decideUsage(baseSnap(99, 99)).action).toBe("escalate");
  });

  test("pause adds reset buffer", () => {
    const r = decideUsage(baseSnap(99, 50), {
      ...DEFAULT_THRESHOLDS,
      resetBufferMs: 60_000,
    });
    if (r.action !== "pause") throw new Error("expected pause");
    const orig = Date.parse("2026-04-27T14:00:00Z");
    const got = Date.parse(r.until);
    expect(got - orig).toBe(60_000);
  });
});
