import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runtimePaths } from "../state/paths.ts";
import { type CcloopConfig, DEFAULTS } from "../config/schema.ts";
import { freshState } from "../state/state.ts";
import { LoopDriver, isLoopStuck } from "./driver.ts";
import type { StepResult } from "../sdk/types.ts";
import { emptyUsage } from "../sdk/types.ts";
import { asSessionId, asSha } from "../branded.ts";

function mkResult(p: Partial<StepResult> = {}): StepResult {
  return {
    subtype: "success",
    stop_reason: "end_turn",
    num_turns: 1,
    total_cost_usd: 0.01,
    duration_ms: 1000,
    usage: emptyUsage(),
    session_id: asSessionId("sess-1"),
    final_text: "Did the thing",
    errors: [],
    ...p,
  };
}

describe("isLoopStuck", () => {
  test("less than n same hashes → false", () => {
    expect(isLoopStuck(["a", "a"], 3)).toBe(false);
  });
  test("n same hashes in a row → true", () => {
    expect(isLoopStuck(["a", "a", "a"], 3)).toBe(true);
  });
  test("mixed tail → false", () => {
    expect(isLoopStuck(["a", "a", "b"], 3)).toBe(false);
  });
  test("n=1 disables", () => {
    expect(isLoopStuck(["a"], 1)).toBe(false);
  });
});

describe("LoopDriver.stepOnce", () => {
  let dir: string;
  let cfg: CcloopConfig;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ccloop-driver-"));
    await writeFile(
      join(dir, "SPEC.md"),
      `# Spec\n\n- [ ] one\n\n## Verification Requirements\n\n1. tests pass\n`,
    );
    cfg = structuredClone(DEFAULTS);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("DONE.md triggers done state", async () => {
    await writeFile(join(dir, "DONE.md"), "all green");
    const paths = runtimePaths(dir);
    const driver = new LoopDriver(dir, paths, cfg, undefined, {
      runStep: async () => { throw new Error("should not run"); },
      headSha: async () => asSha("abc123"),
      headDiffHash: async () => null,
      autoCommit: async () => ({ committed: false, sha: asSha("abc123"), subject: "" }),
    });
    const state = await driver.loadOrInitState();
    const status = await driver.stepOnce(state);
    expect(status.kind).toBe("done");
  });

  test("guardrail trip on max_steps", async () => {
    cfg.loop.max_steps = 5;
    const paths = runtimePaths(dir);
    const driver = new LoopDriver(dir, paths, cfg, undefined, {
      runStep: async () => mkResult(),
      headSha: async () => asSha(""),
      headDiffHash: async () => null,
      autoCommit: async () => ({ committed: false, sha: asSha(""), subject: "" }),
    });
    const state = freshState();
    state.current_step = 6;
    const status = await driver.stepOnce(state);
    expect(status.kind).toBe("guardrail_trip");
  });

  test("successful step commits and advances state", async () => {
    const paths = runtimePaths(dir);
    let committed = false;
    const driver = new LoopDriver(dir, paths, cfg, undefined, {
      runStep: async () => mkResult({ session_id: asSessionId("s2") }),
      headSha: async () => asSha("deadbeef"),
      headDiffHash: async () => "hash-1",
      autoCommit: async () => {
        committed = true;
        return { committed: true, sha: asSha("deadbeef"), subject: "subj" };
      },
    });
    const state = await driver.loadOrInitState();
    const status = await driver.stepOnce(state);
    expect(committed).toBe(true);
    expect(status.kind).toBe("ran");
    if (status.kind === "ran") expect(status.outcome).toBe("success");
    expect(state.current_step).toBe(2);
    expect(state.session_id).toBe(asSessionId("s2"));
    expect(state.consecutive_failures).toBe(0);
    expect(state.diff_hashes_recent).toEqual(["hash-1"]);
  });

  test("no-op commit increments no_progress_count", async () => {
    const paths = runtimePaths(dir);
    const driver = new LoopDriver(dir, paths, cfg, undefined, {
      runStep: async () => mkResult(),
      headSha: async () => asSha("x"),
      headDiffHash: async () => null,
      autoCommit: async () => ({ committed: false, sha: asSha("x"), subject: "subj" }),
    });
    const state = await driver.loadOrInitState();
    await driver.stepOnce(state);
    expect(state.no_progress_count).toBe(1);
  });

  test("3 SDK errors → escalated", async () => {
    cfg.failure.consecutive_failures_before_escalation = 3;
    const paths = runtimePaths(dir);
    const driver = new LoopDriver(dir, paths, cfg, undefined, {
      runStep: async () =>
        mkResult({ subtype: "error_during_execution", errors: ["boom"] }),
      headSha: async () => asSha(""),
      headDiffHash: async () => null,
      autoCommit: async () => ({ committed: false, sha: asSha(""), subject: "" }),
    });
    const state = await driver.loadOrInitState();
    let last;
    for (let i = 0; i < 3; i++) {
      last = await driver.stepOnce(state);
    }
    expect(last?.kind).toBe("escalated");
    expect(state.consecutive_failures).toBe(3);
  });

  test("loop_detected after N identical diffs", async () => {
    cfg.failure.loop_detection_repeats = 3;
    const paths = runtimePaths(dir);
    const driver = new LoopDriver(dir, paths, cfg, undefined, {
      runStep: async () => mkResult(),
      headSha: async () => asSha("x"),
      headDiffHash: async () => "same-hash",
      autoCommit: async () => ({ committed: true, sha: asSha("x"), subject: "subj" }),
    });
    const state = await driver.loadOrInitState();
    let final;
    for (let i = 0; i < 3; i++) {
      final = await driver.stepOnce(state);
    }
    expect(state.state).toBe("escalated");
    expect(state.escalation?.reason).toMatch(/loop_detected/);
    expect(final?.kind).toBe("escalated");
  });

  test("refusal classified as failure", async () => {
    const paths = runtimePaths(dir);
    const driver = new LoopDriver(dir, paths, cfg, undefined, {
      runStep: async () => mkResult({ stop_reason: "refusal" }),
      headSha: async () => asSha(""),
      headDiffHash: async () => null,
      autoCommit: async () => ({ committed: false, sha: asSha(""), subject: "" }),
    });
    const state = await driver.loadOrInitState();
    await driver.stepOnce(state);
    expect(state.consecutive_failures).toBe(1);
  });
});
