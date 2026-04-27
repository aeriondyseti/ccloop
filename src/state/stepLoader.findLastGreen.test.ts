import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findLastGreenSha } from "./stepLoader.ts";
import { asSha } from "../branded.ts";

describe("findLastGreenSha", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ccloop-green-"));
    await mkdir(join(dir, "steps"), { recursive: true });
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("returns most recent successful commit_sha", async () => {
    const steps = [
      { step: 1, outcome: "success", commit_sha: "aaa" },
      { step: 2, outcome: "failure", commit_sha: "" },
      { step: 3, outcome: "success", commit_sha: "ccc" },
      { step: 4, outcome: "no-op", commit_sha: "ddd" },
    ];
    for (const s of steps) {
      const name = `${String(s.step).padStart(4, "0")}.json`;
      await writeFile(join(dir, "steps", name), JSON.stringify(s));
    }
    expect(await findLastGreenSha(join(dir, "steps"))).toBe(asSha("ccc"));
  });

  test("returns null when no successes", async () => {
    await writeFile(
      join(dir, "steps", "0001.json"),
      JSON.stringify({ step: 1, outcome: "failure", commit_sha: "" }),
    );
    expect(await findLastGreenSha(join(dir, "steps"))).toBe(null);
  });

  test("missing dir → null", async () => {
    expect(await findLastGreenSha(join(dir, "missing"))).toBe(null);
  });
});
