import { describe, test, expect } from "bun:test";
import { DESIGN_PHASES, DESIGN_ARTIFACT_PATHS, DEFAULT_DESIGN_CONFIG } from "./constants.ts";

describe("DESIGN_PHASES", () => {
  test("contains all six phases in linear order", () => {
    expect(DESIGN_PHASES).toEqual([
      "vision",
      "users",
      "scope",
      "architecture",
      "milestones",
      "acceptance",
    ]);
  });

  test("is readonly array", () => {
    expect(Array.isArray(DESIGN_PHASES)).toBe(true);
    expect(DESIGN_PHASES.length).toBe(6);
  });
});

describe("DESIGN_ARTIFACT_PATHS", () => {
  test("contains all required artifact paths", () => {
    expect(DESIGN_ARTIFACT_PATHS.draft).toBe("./.ccloop/design/spec.draft.md");
    expect(DESIGN_ARTIFACT_PATHS.roadmap).toBe("./.ccloop/design/ROADMAP.md");
    expect(DESIGN_ARTIFACT_PATHS.ideas).toBe("./.ccloop/design/IDEAS.md");
    expect(DESIGN_ARTIFACT_PATHS.techDebt).toBe("./.ccloop/design/TECH-DEBT.md");
    expect(DESIGN_ARTIFACT_PATHS.lastSession).toBe("./.ccloop/design/last-session.md");
  });

  test("all paths start with ./.ccloop/design/", () => {
    const paths = Object.values(DESIGN_ARTIFACT_PATHS);
    for (const path of paths) {
      expect(path.startsWith("./.ccloop/design/")).toBe(true);
    }
  });
});

describe("DEFAULT_DESIGN_CONFIG", () => {
  test("has sensible defaults", () => {
    expect(DEFAULT_DESIGN_CONFIG.model).toBe("claude-opus-4-20250514");
    expect(DEFAULT_DESIGN_CONFIG.max_turns).toBe(100);
    expect(DEFAULT_DESIGN_CONFIG.effort).toBe("high");
  });
});
