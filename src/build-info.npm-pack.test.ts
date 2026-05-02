/**
 * Tarball-content guarantees for the published npm package.
 *
 * Runs `npm pack --dry-run --json` from the repo root and asserts:
 *   - no `*.test.ts` / `*.test.tsx` files ship
 *   - no dev-only modules ship (src/cli/debug.ts, src/sdk/debugDump.ts)
 *   - core entrypoints DO ship (src/index.ts, src/cli/dispatch.ts, etc.)
 *
 * The runtime guards (IS_DEV_BUILD, CCLOOP_SDK_DEBUG) keep dev paths
 * unreachable on production installs even if a tarball did slip; this
 * test is the packaging-side guarantee.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

interface NpmPackEntry {
  files: Array<{ path: string; size: number }>;
}

const REPO_ROOT = join(import.meta.dir, "..");

let files: string[] = [];

beforeAll(() => {
  // npm pack --dry-run is the only way to know what would actually
  // ship; cache the result across all assertions in this file rather
  // than spawning npm three times for the same output.
  const out = spawnSync("npm", ["pack", "--dry-run", "--json"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  if (out.status !== 0) throw new Error(`npm pack failed: ${out.stderr}`);
  const parsed = JSON.parse(out.stdout) as NpmPackEntry[];
  if (parsed.length === 0) throw new Error("npm pack produced no entries");
  files = parsed[0]!.files.map((f) => f.path);
});

describe("npm tarball contents", () => {
  test("ships no test files", () => {
    expect(files.filter((p) => /\.test\.(ts|tsx)$/.test(p))).toEqual([]);
  });

  test("ships no dev-only modules", () => {
    expect(
      files.filter((p) => p === "src/cli/debug.ts" || p === "src/sdk/debugDump.ts"),
    ).toEqual([]);
  });

  test("ships no test-fixture modules", () => {
    expect(files.filter((p) => /\.fixtures\.ts$/.test(p))).toEqual([]);
  });

  test("ships core entrypoints", () => {
    for (const required of [
      "package.json",
      "README.md",
      "src/index.ts",
      "src/cli/dispatch.ts",
      "src/cli/run.ts",
      "src/sdk/runStep.ts",
      "templates/SPEC.md",
      "templates/ccloop.toml",
    ]) {
      expect(files).toContain(required);
    }
  });
});
