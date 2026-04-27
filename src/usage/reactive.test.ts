import { describe, expect, test } from "bun:test";
import { parseRateLimitError } from "./reactive.ts";
import { asIsoTimestamp } from "../branded.ts";

const NOW = Date.parse("2026-04-27T12:00:00Z");
const opts = {
  defaultPauseSeconds: 3600,
  now: () => NOW,
};

describe("parseRateLimitError", () => {
  test("explicit weekly escalates", () => {
    const r = parseRateLimitError("weekly limit reached", opts);
    expect(r.kind).toBe("escalate");
  });

  test("explicit 5h pauses with parsed reset", () => {
    const r = parseRateLimitError(
      "5h session limit; resets at 2026-04-27T13:30:00Z",
      opts,
    );
    expect(r.kind).toBe("pause");
    if (r.kind === "pause") expect(r.until).toBe(asIsoTimestamp("2026-04-27T13:30:00.000Z"));
  });

  test("ambiguous reset > 12h escalates", () => {
    const r = parseRateLimitError(
      "rate limited; resets at 2026-04-29T00:00:00Z",
      opts,
    );
    expect(r.kind).toBe("escalate");
  });

  test("ambiguous reset within 12h pauses", () => {
    const r = parseRateLimitError(
      "rate limited; resets at 2026-04-27T15:00:00Z",
      opts,
    );
    expect(r.kind).toBe("pause");
  });

  test("relative 'in 30 minutes' parsed", () => {
    const r = parseRateLimitError("rate limited, retry in 30 minutes", opts);
    expect(r.kind).toBe("pause");
    if (r.kind === "pause") {
      const got = Date.parse(r.until) - NOW;
      expect(got).toBe(30 * 60 * 1000);
    }
  });

  test("no parseable reset uses default pause", () => {
    const r = parseRateLimitError("rate limited", { ...opts, defaultPauseSeconds: 60 });
    expect(r.kind).toBe("pause");
    if (r.kind === "pause") {
      const got = Date.parse(r.until) - NOW;
      expect(got).toBe(60_000);
    }
  });
});
