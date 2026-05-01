import { describe, expect, test } from "bun:test";
import { FlagError, parseRunFlags } from "./flags.ts";

describe("parseRunFlags", () => {
  test("empty argv", () => {
    expect(parseRunFlags([])).toEqual({ cont: false, yes: false });
  });

  test("flags parsed", () => {
    const f = parseRunFlags([
      "--continue", "-y", "--yolo", "--max-steps", "42",
      "--cadence", "30", "--max-wall-clock", "1h",
      "--prompt", "p.md", "--no-color",
    ]);
    expect(f).toEqual({
      cont: true, yes: true, yolo: true,
      maxSteps: 42, cadence: 30, maxWallClock: "1h",
      promptPath: "p.md", noColor: true,
    });
  });

  test("removed --log-level flag is rejected as unknown", () => {
    expect(() => parseRunFlags(["--log-level", "info"])).toThrow(FlagError);
  });

  test("unknown flag errors", () => {
    expect(() => parseRunFlags(["--bogus"])).toThrow(FlagError);
  });

  test("missing value errors", () => {
    expect(() => parseRunFlags(["--max-steps"])).toThrow(/requires a value/);
  });

  test("non-integer errors", () => {
    expect(() => parseRunFlags(["--max-steps", "x"])).toThrow(/integer/);
  });
});
