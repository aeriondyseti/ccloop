import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runtimePaths } from "../state/paths.ts";
import { DEFAULTS } from "../config/schema.ts";
import { LoopDriver } from "./driver.ts";
import { runGit } from "./git.ts";
import { emptyUsage } from "../sdk/types.ts";
import { asSessionId } from "../branded.ts";

describe("integration: stepOnce with real git", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ccloop-int-"));
    await runGit(["init", "--quiet"], dir);
    await runGit(["config", "user.email", "x@y"], dir);
    await runGit(["config", "user.name", "ccloop"], dir);
    await runGit(["commit", "--allow-empty", "-m", "init"], dir);
    await writeFile(
      join(dir, "SPEC.md"),
      `- [ ] one\n## Verification Requirements\n\n1. tests pass\n`,
    );
    await runGit(["add", "SPEC.md"], dir);
    await runGit(["commit", "-m", "add spec"], dir);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("successful step writes state, step record, events, and commits", async () => {
    const paths = runtimePaths(dir);
    const driver = new LoopDriver(dir, paths, DEFAULTS, undefined, {
      runStep: async () => {
        // Side-effect: actually create a file so autoCommit has something.
        await writeFile(join(dir, "out.txt"), "hi");
        return {
          subtype: "success", stop_reason: "end_turn", num_turns: 1,
          total_cost_usd: 0.01, duration_ms: 100, usage: emptyUsage(),
          session_id: asSessionId("sess-1"), final_text: "Wrote out.txt", errors: [], is_error: false,
        };
      },
    });
    const state = await driver.loadOrInitState();
    const status = await driver.stepOnce(state);
    expect(status.kind).toBe("ran");
    if (status.kind === "ran") expect(status.outcome).toBe("success");
    expect(state.current_step).toBe(2);
    expect(state.session_id).toBe(asSessionId("sess-1"));

    expect(existsSync(paths.state)).toBe(true);
    expect(existsSync(paths.events)).toBe(true);
    expect(existsSync(join(paths.steps, "0001.json"))).toBe(true);

    const recText = await readFile(join(paths.steps, "0001.json"), "utf8");
    const rec = JSON.parse(recText);
    expect(rec.outcome).toBe("success");
    expect(rec.commit_sha).toMatch(/^[a-f0-9]{40}$/);
    expect(rec.commit_subject).toBe("Wrote out.txt");

    const events = (await readFile(paths.events, "utf8"))
      .trim().split("\n").map((l) => JSON.parse(l));
    const types = events.map((e) => e.type);
    expect(types).toContain("step_start");
    expect(types).toContain("step_end");
  });
});
