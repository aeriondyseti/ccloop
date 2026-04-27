import { describe, expect, test } from "bun:test";
import {
  formatBar, formatCost, formatCountdown, formatDuration,
  formatPct, formatTokens,
} from "./format.ts";

describe("format", () => {
  test("durations", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(45_000)).toBe("45s");
    expect(formatDuration(125_000)).toBe("2m 5s");
    expect(formatDuration(3_725_000)).toBe("1h 2m");
    expect(formatDuration(90_000_000)).toBe("1d 1h");
  });
  test("cost", () => {
    expect(formatCost(0)).toBe("$0.00");
    expect(formatCost(0.0034)).toBe("$0.0034");
    expect(formatCost(1.234)).toBe("$1.23");
  });
  test("tokens", () => {
    expect(formatTokens(950)).toBe("950");
    expect(formatTokens(12_500)).toBe("12.5k");
    expect(formatTokens(2_345_000)).toBe("2.35M");
  });
  test("pct", () => {
    expect(formatPct(0)).toBe("0%");
    expect(formatPct(0.5)).toBe("50%");
    expect(formatPct(0.91)).toBe("91%");
  });
  test("bar", () => {
    expect(formatBar(0, 4)).toBe("░░░░");
    expect(formatBar(100, 4)).toBe("████");
    expect(formatBar(50, 4)).toBe("██░░");
    expect(formatBar(150, 4)).toBe("████"); // clamped
  });
  test("countdown", () => {
    const t = "2026-04-27T15:00:00Z";
    expect(formatCountdown(t, Date.parse(t) - 30_000)).toBe("30s");
    expect(formatCountdown(t, Date.parse(t) + 1)).toBe("now");
  });
});
