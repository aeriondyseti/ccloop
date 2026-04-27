import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRecentSteps } from "./stepLoader.ts";

describe("loadRecentSteps", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ccloop-steps-"));
    await mkdir(join(dir, "steps"), { recursive: true });
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("missing dir → empty", async () => {
    expect(await loadRecentSteps(join(dir, "missing"))).toEqual([]);
  });

  test("returns sorted tail by limit", async () => {
    for (const n of [1, 2, 3, 4, 5, 6, 7]) {
      const name = `${String(n).padStart(4, "0")}.json`;
      await writeFile(join(dir, "steps", name), JSON.stringify({ step: n }));
    }
    const r = await loadRecentSteps(join(dir, "steps"), 3);
    expect(r.map((x) => x.step)).toEqual([5, 6, 7]);
  });

  test("malformed entries skipped", async () => {
    await writeFile(join(dir, "steps", "0001.json"), "{not json}");
    await writeFile(join(dir, "steps", "0002.json"), JSON.stringify({ step: 2 }));
    const r = await loadRecentSteps(join(dir, "steps"));
    expect(r).toHaveLength(1);
    expect(r[0]?.step).toBe(2);
  });
});
