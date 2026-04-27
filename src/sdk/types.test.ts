import { describe, expect, test } from "bun:test";
import { cacheHitRate, emptyUsage } from "./types.ts";

describe("cacheHitRate", () => {
  test("zero usage returns 0", () => {
    expect(cacheHitRate(emptyUsage())).toBe(0);
  });

  test("matches §7.5 formula", () => {
    expect(cacheHitRate({
      input_tokens: 100, output_tokens: 0,
      cache_read_input_tokens: 900, cache_creation_input_tokens: 0,
    })).toBe(0.9);
  });

  test("output and creation do not affect numerator/denominator", () => {
    expect(cacheHitRate({
      input_tokens: 50, output_tokens: 9999,
      cache_read_input_tokens: 50, cache_creation_input_tokens: 9999,
    })).toBe(0.5);
  });
});
