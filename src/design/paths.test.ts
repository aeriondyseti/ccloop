import { describe, test, expect } from "bun:test";
import { getDesignPaths, getDesignDir } from "./paths.ts";
import { join } from "node:path";

describe("getDesignPaths", () => {
  test("returns paths under .ccloop/design/", () => {
    const cwd = "/home/user/project";
    const paths = getDesignPaths(cwd);

    expect(paths.draft).toBe(join(cwd, ".ccloop", "design", "spec.draft.md"));
    expect(paths.roadmap).toBe(join(cwd, ".ccloop", "design", "ROADMAP.md"));
    expect(paths.ideas).toBe(join(cwd, ".ccloop", "design", "IDEAS.md"));
    expect(paths.techDebt).toBe(join(cwd, ".ccloop", "design", "TECH-DEBT.md"));
    expect(paths.lastSession).toBe(join(cwd, ".ccloop", "design", "last-session.md"));
  });

  test("handles relative cwd", () => {
    const cwd = "./my-project";
    const paths = getDesignPaths(cwd);

    expect(paths.draft).toBe(join(cwd, ".ccloop", "design", "spec.draft.md"));
  });

  test("handles cwd with trailing slash", () => {
    const cwd = "/home/user/project/";
    const paths = getDesignPaths(cwd);

    // join normalizes the path
    expect(paths.draft).toBe(join(cwd, ".ccloop", "design", "spec.draft.md"));
  });
});

describe("getDesignDir", () => {
  test("returns .ccloop/design/ directory path", () => {
    const cwd = "/home/user/project";
    const dir = getDesignDir(cwd);

    expect(dir).toBe(join(cwd, ".ccloop", "design"));
  });
});

