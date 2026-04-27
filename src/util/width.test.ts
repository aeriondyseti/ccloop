import { describe, expect, test } from "bun:test";
import { truncateToWidth, visualWidth } from "./width.ts";

describe("visualWidth", () => {
  test("ASCII: width = length", () => {
    expect(visualWidth("hello world")).toBe(11);
  });

  test("RGI emojis are 2 columns", () => {
    expect(visualWidth("✅")).toBe(2);     // U+2705
    expect(visualWidth("👍")).toBe(2);
  });

  test("bare text-style symbols are 1 column", () => {
    // These render as text-style by default (no VS16). string-width
    // counts them as 1 col, which matches well-behaved terminals.
    expect(visualWidth("✓")).toBe(1);   // U+2713 CHECK MARK
    expect(visualWidth("✗")).toBe(1);   // U+2717 BALLOT X
    expect(visualWidth("▸")).toBe(1);   // U+25B8 BLACK RIGHT-POINTING SMALL TRIANGLE
    expect(visualWidth("·")).toBe(1);
  });

  test("zero-width controls don't add to width", () => {
    expect(visualWidth("a​b")).toBe(2); // ZWSP
  });

  test("ZWJ family sequence is one cluster, 2 cols", () => {
    expect(visualWidth("👨‍👩‍👧")).toBe(2);
  });
});

describe("truncateToWidth", () => {
  test("returns input unchanged when under budget", () => {
    expect(truncateToWidth("hello", 10)).toBe("hello");
  });

  test("truncates ASCII with ellipsis fitting the budget", () => {
    expect(truncateToWidth("abcdefghij", 5)).toBe("abcd…");
  });

  test("never splits an emoji mid-cluster", () => {
    // "ab✅cd" is 6 visual cols. Cap at 4 → must stop before ✅
    // (which is 2 cols) and produce "ab…" or shorter, never half ✅.
    const out = truncateToWidth("ab✅cd", 4);
    expect(out).not.toContain("\uD83C"); // no orphaned high surrogate
    expect(visualWidth(out)).toBeLessThanOrEqual(4);
  });

  test("respects the visual-width budget for emojis", () => {
    // 5 ✅s is 10 cols; cap at 7 should fit at most 3 emojis + ellipsis (= 7).
    const out = truncateToWidth("✅✅✅✅✅", 7);
    expect(visualWidth(out)).toBeLessThanOrEqual(7);
    expect(out.endsWith("…")).toBe(true);
  });

  test("custom ellipsis width is accounted for", () => {
    const out = truncateToWidth("abcdefghij", 6, "...");
    // budget = 6 - 3 (… = "...") = 3, → "abc..."
    expect(out).toBe("abc...");
    expect(visualWidth(out)).toBe(6);
  });

  test("max <= 0 returns empty string", () => {
    expect(truncateToWidth("hello", 0)).toBe("");
    expect(truncateToWidth("hello", -1)).toBe("");
  });

  test("max smaller than ellipsis: returns prefix without ellipsis", () => {
    // budget = 1, ellipsis "…" is also width 1; must not exceed max.
    const out = truncateToWidth("abcdef", 1);
    expect(visualWidth(out)).toBeLessThanOrEqual(1);
  });
});
