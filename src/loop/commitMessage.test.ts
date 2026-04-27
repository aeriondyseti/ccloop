import { describe, expect, test } from "bun:test";
import { deriveCommitSubject } from "./commitMessage.ts";

describe("deriveCommitSubject", () => {
  test("empty text falls back", () => {
    expect(deriveCommitSubject("", 5)).toBe("ccloop step 5");
  });

  test("strips heading marker", () => {
    expect(deriveCommitSubject("# Added parser\n\nDetails", 1)).toBe("Added parser");
  });

  test("strips list bullet", () => {
    expect(deriveCommitSubject("- fix(parser): handle empty input", 1)).toBe(
      "fix(parser): handle empty input",
    );
  });

  test("caps at 72 chars with ellipsis", () => {
    const long = "a".repeat(120);
    const out = deriveCommitSubject(long, 1);
    expect(out.length).toBeLessThanOrEqual(72);
    expect(out.endsWith("…")).toBe(true);
  });

  test("skips blank lines", () => {
    expect(deriveCommitSubject("\n\n   \nfirst real line", 1)).toBe("first real line");
  });

  test("strips bold wrap", () => {
    expect(deriveCommitSubject("**Done**", 1)).toBe("Done");
  });
});
