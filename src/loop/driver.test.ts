import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runtimePaths } from "../state/paths.ts";
import { type CcloopConfig, DEFAULTS } from "../config/schema.ts";
import { freshState } from "../state/state.ts";
import { type DriverEvent, LoopDriver, isLoopStuck, renderLastError, trimToLastLines } from "./driver.ts";
import { EventBus } from "./eventBus.ts";
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
    is_error: false,
    ...p,
  };
}

describe("renderLastError", () => {
  test("empty when escalation is active or no last_failure", () => {
    const a = freshState();
    a.escalation = { reason: "x", trail: [], entered_at: "" as any };
    expect(renderLastError(a)).toBe("");

    const b = freshState();
    expect(renderLastError(b)).toBe("");
  });

  test("uses a fence longer than the longest backtick run in excerpt", () => {
    const s = freshState();
    s.last_failure = {
      category: "sdk",
      // Excerpt contains a triple-backtick code fence — naive ``` would
      // close prematurely. Output must use ≥4 backticks for both fences.
      excerpt: "Tool output:\n```\nactual error\n```\n",
    };
    const out = renderLastError(s);
    expect(out).toContain("````");
    // Excerpt body present.
    expect(out).toContain("actual error");
    // The fence count is consistent: opening and closing match.
    const fences = out.match(/`{3,}/g) ?? [];
    expect(fences.length).toBeGreaterThanOrEqual(2);
    expect(fences[0]).toBe(fences.at(-1));
  });

  test("uses minimal 3-backtick fence when excerpt has no backticks", () => {
    const s = freshState();
    s.last_failure = { category: "sdk", excerpt: "plain error message" };
    const out = renderLastError(s);
    expect(out).toContain("```\nplain error message\n```");
  });

  test("trims excerpt to the last 40 lines with an elision marker", () => {
    const s = freshState();
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`);
    s.last_failure = { category: "sdk", excerpt: lines.join("\n") };
    const out = renderLastError(s);
    expect(out).toContain("60 earlier lines elided");
    expect(out).toContain("line 100");
    expect(out).toContain("line 61");
    expect(out).not.toContain("line 60\n");
  });
});

describe("trimToLastLines", () => {
  test("returns input unchanged when under cap", () => {
    expect(trimToLastLines("a\nb\nc", 10)).toBe("a\nb\nc");
  });
  test("keeps last N lines and prepends an elision header", () => {
    const out = trimToLastLines("1\n2\n3\n4\n5", 2);
    expect(out).toBe("… (3 earlier lines elided)\n4\n5");
  });
  test("maxLines=0 collapses to empty", () => {
    expect(trimToLastLines("anything", 0)).toBe("");
  });
});

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

  test("checkDoneTransition `forStep` overrides the emitted event step", async () => {
    // Regression: post-cadence done detection used `state.current_step`
    // which had already been incremented past the step that did the
    // work. The events.jsonl `done` line and notify summary then
    // attributed the achievement to a step that never ran.
    await writeFile(join(dir, "DONE.md"), "all green");
    const paths = runtimePaths(dir);
    const events: DriverEvent[] = [];
    const bus = new EventBus<DriverEvent>();
    bus.subscribe((e: DriverEvent) => { events.push(e); });
    const driver = new LoopDriver(dir, paths, cfg, bus, {
      runStep: async () => mkResult(),
      headSha: async () => asSha("abc123"),
      headDiffHash: async () => null,
      autoCommit: async () => ({ committed: false, sha: asSha("abc123"), subject: "" }),
    });
    const state = await driver.loadOrInitState();
    state.current_step = 13; // pretend stepOnce just incremented us
    await driver.checkDoneTransition(state, /* forStep */ 12);
    const doneEvts = events.filter((e) => e.type === "done");
    expect(doneEvts.length).toBe(1);
    expect(doneEvts[0]?.step).toBe(12);
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

  test("step_timeout watchdog aborts a hung runStep and records step_timeout", async () => {
    cfg.claude.step_timeout_seconds = 1; // 1s
    const paths = runtimePaths(dir);
    let aborted = false;
    const driver = new LoopDriver(dir, paths, cfg, undefined, {
      runStep: async (input) => {
        // Simulate the SDK hanging on a stalled stream until aborted.
        await new Promise<void>((_, reject) => {
          input.abortController?.signal.addEventListener("abort", () => {
            aborted = true;
            reject(new Error("aborted"));
          });
        });
        // Unreachable — abort always fires before this point.
        return mkResult();
      },
      headSha: async () => asSha(""),
      headDiffHash: async () => null,
      autoCommit: async () => ({ committed: false, sha: asSha(""), subject: "" }),
    });
    const state = await driver.loadOrInitState();
    const start = Date.now();
    const status = await driver.stepOnce(state);
    const elapsed = Date.now() - start;
    expect(aborted).toBe(true);
    expect(elapsed).toBeLessThan(3000);
    expect(status.kind).toBe("ran");
    if (status.kind === "ran") expect(status.outcome).toBe("failure");
    expect(state.last_failure?.category).toBe("step_timeout");
    expect(state.consecutive_failures).toBe(1);
  });

  test("watchdog firing during a successful step does not corrupt classification", async () => {
    // Race: timer fires (sets watchdogTimedOut + aborts), but the
    // SDK completes the in-flight message before noticing the
    // abort. runStep returns success. The unconditional
    // post-try override used to flip success → step_timeout failure
    // — corrupting the audit trail for a step that actually worked.
    cfg.claude.step_timeout_seconds = 1;
    const paths = runtimePaths(dir);
    const driver = new LoopDriver(dir, paths, cfg, undefined, {
      runStep: async (input) => {
        // Simulate watchdog firing AFTER N ms while we're still
        // running, then completing successfully despite the abort.
        await new Promise((r) => setTimeout(r, 1100));
        // SDK didn't notice / didn't propagate the abort; happy
        // result returned anyway.
        return mkResult();
      },
      headSha: async () => asSha("x"),
      headDiffHash: async () => null,
      autoCommit: async () => ({ committed: true, sha: asSha("x"), subject: "" }),
    });
    const state = await driver.loadOrInitState();
    const status = await driver.stepOnce(state);
    expect(status.kind).toBe("ran");
    if (status.kind === "ran") expect(status.outcome).toBe("success");
    expect(state.last_failure).toBeNull();
  });

  test("step_timeout=0 disables the watchdog", async () => {
    cfg.claude.step_timeout_seconds = 0;
    const paths = runtimePaths(dir);
    const driver = new LoopDriver(dir, paths, cfg, undefined, {
      runStep: async () => mkResult(),
      headSha: async () => asSha(""),
      headDiffHash: async () => null,
      autoCommit: async () => ({ committed: true, sha: asSha("x"), subject: "" }),
    });
    const state = await driver.loadOrInitState();
    const status = await driver.stepOnce(state);
    expect(status.kind).toBe("ran");
    if (status.kind === "ran") expect(status.outcome).toBe("success");
  });

  test("recordSdkInitFailure emits step_failed and updates state", async () => {
    const paths = runtimePaths(dir);
    const events: DriverEvent[] = [];
    const bus = new EventBus<DriverEvent>();
    bus.subscribe((e: DriverEvent) => { events.push(e); });
    const driver = new LoopDriver(dir, paths, cfg, bus, {
      runStep: async () => mkResult(),
      headSha: async () => asSha(""),
      headDiffHash: async () => null,
      autoCommit: async () => ({ committed: false, sha: asSha(""), subject: "" }),
    });
    const state = await driver.loadOrInitState();
    const f = await driver.recordSdkInitFailure(state, "model overloaded: 529");
    expect(f.category).toBe("sdk_init");
    expect(state.consecutive_failures).toBe(1);
    expect(state.last_failure?.excerpt).toContain("overloaded");
    const failed = events.filter((e) => e.type === "step_failed");
    expect(failed.length).toBe(1);
  });

  test("gate failure blocks commit and records gate failure", async () => {
    cfg.loop.gate_command = "exit 1"; // any non-empty triggers the gate
    const paths = runtimePaths(dir);
    let committed = false;
    const driver = new LoopDriver(dir, paths, cfg, undefined, {
      runStep: async () => mkResult(),
      headSha: async () => asSha(""),
      headDiffHash: async () => null,
      autoCommit: async () => {
        committed = true;
        return { committed: true, sha: asSha("x"), subject: "" };
      },
      runGate: async () => ({ ok: false, exitCode: 7, excerpt: "tests failed", timedOut: false }),
    });
    const state = await driver.loadOrInitState();
    const status = await driver.stepOnce(state);
    expect(committed).toBe(false);
    expect(status.kind).toBe("ran");
    if (status.kind === "ran") expect(status.outcome).toBe("failure");
    expect(state.last_failure?.category).toBe("gate");
    expect(state.last_failure?.excerpt).toBe("tests failed");
  });

  test("gate skipped when gate_command is empty", async () => {
    const paths = runtimePaths(dir);
    let gateRan = false;
    const driver = new LoopDriver(dir, paths, cfg, undefined, {
      runStep: async () => mkResult(),
      headSha: async () => asSha("x"),
      headDiffHash: async () => null,
      autoCommit: async () => ({ committed: true, sha: asSha("x"), subject: "" }),
      runGate: async () => {
        gateRan = true;
        return { ok: true, exitCode: 0, excerpt: "", timedOut: false };
      },
    });
    const state = await driver.loadOrInitState();
    await driver.stepOnce(state);
    expect(gateRan).toBe(false);
  });

  test("failed step records last_failure for next prompt", async () => {
    const paths = runtimePaths(dir);
    const driver = new LoopDriver(dir, paths, cfg, undefined, {
      runStep: async () =>
        mkResult({ subtype: "error_during_execution", errors: ["boom: tests failed"] }),
      headSha: async () => asSha(""),
      headDiffHash: async () => null,
      autoCommit: async () => ({ committed: false, sha: asSha(""), subject: "" }),
    });
    const state = await driver.loadOrInitState();
    await driver.stepOnce(state);
    expect(state.last_failure).not.toBeNull();
    expect(state.last_failure?.excerpt.length).toBeGreaterThan(0);
  });

  test("3 consecutive low cache-hit-rate steps emits cache_warning once", async () => {
    const paths = runtimePaths(dir);
    // 100 fresh input + 0 cached read + 0 creation → rate = 0.0 < 0.5.
    const lowCacheUsage = { ...emptyUsage(), input_tokens: 100 };
    const events: DriverEvent[] = [];
    const bus = new EventBus<DriverEvent>();
    bus.subscribe((e: DriverEvent) => { events.push(e); });
    const driver = new LoopDriver(dir, paths, cfg, bus, {
      runStep: async () => mkResult({ usage: lowCacheUsage, session_id: asSessionId("s1") }),
      headSha: async () => asSha("a"),
      headDiffHash: async () => null,
      autoCommit: async () => ({ committed: true, sha: asSha("a"), subject: "s" }),
    });
    const state = await driver.loadOrInitState();
    await driver.stepOnce(state);
    await driver.stepOnce(state);
    await driver.stepOnce(state);
    const warnings = events.filter((e) => (e as { type: string }).type === "cache_warning");
    expect(warnings).toHaveLength(1);
    expect((warnings[0] as { streak?: number } | undefined)?.streak).toBe(3);
    expect(state.cache_low_streak).toBe(3);

    // 4th low step shouldn't re-emit; streak keeps climbing.
    await driver.stepOnce(state);
    expect(events.filter((e) => (e as { type: string }).type === "cache_warning")).toHaveLength(1);
    expect(state.cache_low_streak).toBe(4);

    // A high-rate step resets the streak.
    const highCacheUsage = { ...emptyUsage(), input_tokens: 10, cache_read_input_tokens: 990 };
    // Rebuild driver so runStep returns the high-rate result.
    const driver2 = new LoopDriver(dir, paths, cfg, bus, {
      runStep: async () => mkResult({ usage: highCacheUsage, session_id: asSessionId("s1") }),
      headSha: async () => asSha("b"),
      headDiffHash: async () => null,
      autoCommit: async () => ({ committed: true, sha: asSha("b"), subject: "s" }),
    });
    await driver2.stepOnce(state);
    expect(state.cache_low_streak).toBe(0);
  });

  test("context_overflow rotates the session", async () => {
    const paths = runtimePaths(dir);
    const driver = new LoopDriver(dir, paths, cfg, undefined, {
      runStep: async () => mkResult({
        subtype: "success", is_error: true,
        final_text: "Prompt is too long",
        session_id: asSessionId("poisoned"),
      }),
      headSha: async () => asSha("a"),
      headDiffHash: async () => null,
      autoCommit: async () => ({ committed: false, sha: asSha(""), subject: "" }),
    });
    const state = await driver.loadOrInitState();
    state.session_id = asSessionId("poisoned");
    state.steps_since_session_reset = 7;
    await driver.stepOnce(state);
    expect(state.session_id).toBeNull();
    expect(state.steps_since_session_reset).toBe(0);
    expect(state.last_failure?.category).toBe("context_overflow");
  });

  test("max_steps_per_session resets session_id after the cap", async () => {
    cfg.claude.max_steps_per_session = 2;
    const paths = runtimePaths(dir);
    const driver = new LoopDriver(dir, paths, cfg, undefined, {
      runStep: async () => mkResult({ session_id: asSessionId("alive") }),
      headSha: async () => asSha("a"),
      headDiffHash: async () => null,
      autoCommit: async () => ({ committed: true, sha: asSha("a"), subject: "s" }),
    });
    const state = await driver.loadOrInitState();
    await driver.stepOnce(state);
    expect(state.session_id).toBe(asSessionId("alive"));
    expect(state.steps_since_session_reset).toBe(1);
    await driver.stepOnce(state);
    // 2nd step hit the cap → session cleared, counter reset.
    expect(state.session_id).toBeNull();
    expect(state.steps_since_session_reset).toBe(0);
  });

  test("context_rotate_threshold proactively rotates when input tokens cross watermark", async () => {
    cfg.claude.context_rotate_threshold = 0.90;
    cfg.claude.max_steps_per_session = 0; // disable step cap so threshold path is exclusive
    const paths = runtimePaths(dir);
    // 200K window × 0.90 = 180K. Set input usage above that.
    const heavyUsage = { ...emptyUsage(), input_tokens: 185_000, output_tokens: 100 };
    const events: DriverEvent[] = [];
    const bus = new EventBus<DriverEvent>();
    bus.subscribe((e: DriverEvent) => { events.push(e); });
    const driver = new LoopDriver(dir, paths, cfg, bus, {
      runStep: async () => mkResult({ session_id: asSessionId("hot"), usage: heavyUsage }),
      headSha: async () => asSha("a"),
      headDiffHash: async () => null,
      autoCommit: async () => ({ committed: true, sha: asSha("a"), subject: "s" }),
    });
    const state = await driver.loadOrInitState();
    await driver.stepOnce(state);
    expect(state.session_id).toBeNull();
    expect(state.steps_since_session_reset).toBe(0);
    const rot = events.find((e) => e.type === "session_rotated");
    expect(rot).toBeDefined();
    if (rot && rot.type === "session_rotated") {
      expect(rot.reason).toBe("context_threshold");
      expect(rot.context_tokens).toBe(185_000);
      expect(rot.context_window).toBe(200_000);
    }
  });

  test("proactive rotation captures a session summary into state.rotation_summary", async () => {
    cfg.claude.max_steps_per_session = 1; // rotate after step 1
    const paths = runtimePaths(dir);
    let summarizeCalls = 0;
    const driver = new LoopDriver(dir, paths, cfg, undefined, {
      runStep: async () => mkResult({ session_id: asSessionId("hot") }),
      headSha: async () => asSha("a"),
      headDiffHash: async () => null,
      autoCommit: async () => ({ committed: true, sha: asSha("a"), subject: "s" }),
      summarizeSession: async (input) => {
        summarizeCalls += 1;
        expect(input.resumeSessionId).toBe(asSessionId("hot"));
        return "Did vision phase. Drafting users next.";
      },
    });
    const state = await driver.loadOrInitState();
    await driver.stepOnce(state);
    expect(summarizeCalls).toBe(1);
    expect(state.session_id).toBeNull();
    expect(state.rotation_summary).toBe("Did vision phase. Drafting users next.");
  });

  test("rotation_summary is consumed once: the next step renders + clears it", async () => {
    // Disable rotation triggers so the test isolates the consume path.
    cfg.claude.max_steps_per_session = 0;
    cfg.claude.context_rotate_threshold = 0;
    const paths = runtimePaths(dir);
    const prompts: string[] = [];
    const driver = new LoopDriver(dir, paths, cfg, undefined, {
      runStep: async (input) => {
        prompts.push(input.prompt);
        return mkResult({ session_id: asSessionId("alive") });
      },
      headSha: async () => asSha("a"),
      headDiffHash: async () => null,
      autoCommit: async () => ({ committed: true, sha: asSha("a"), subject: "s" }),
    });
    const state = await driver.loadOrInitState();
    state.rotation_summary = "carry-over context here";
    await driver.stepOnce(state);
    // Rendered into step 1's prompt; field cleared after consumption.
    expect(prompts[0]).toContain("carry-over context here");
    expect(state.rotation_summary).toBeNull();
    await driver.stepOnce(state);
    // Step 2 saw no summary because step 1 consumed it.
    expect(prompts[1]).not.toContain("carry-over context here");
  });

  test("context_overflow rotation does NOT call summarize (session is wedged)", async () => {
    const paths = runtimePaths(dir);
    let summarizeCalls = 0;
    const driver = new LoopDriver(dir, paths, cfg, undefined, {
      runStep: async () => mkResult({
        is_error: true,
        final_text: "Prompt is too long",
      }),
      headSha: async () => asSha(""),
      headDiffHash: async () => null,
      autoCommit: async () => ({ committed: false, sha: asSha(""), subject: "" }),
      summarizeSession: async () => { summarizeCalls += 1; return "should not happen"; },
    });
    const state = await driver.loadOrInitState();
    state.session_id = asSessionId("poisoned");
    await driver.stepOnce(state);
    expect(state.session_id).toBeNull();
    expect(summarizeCalls).toBe(0);
    expect(state.rotation_summary).toBeNull();
  });

  test("context_rotate_threshold below watermark keeps session", async () => {
    cfg.claude.context_rotate_threshold = 0.90;
    cfg.claude.max_steps_per_session = 0;
    const paths = runtimePaths(dir);
    const lightUsage = { ...emptyUsage(), input_tokens: 10_000, output_tokens: 100 };
    const driver = new LoopDriver(dir, paths, cfg, undefined, {
      runStep: async () => mkResult({ session_id: asSessionId("alive"), usage: lightUsage }),
      headSha: async () => asSha("a"),
      headDiffHash: async () => null,
      autoCommit: async () => ({ committed: true, sha: asSha("a"), subject: "s" }),
    });
    const state = await driver.loadOrInitState();
    await driver.stepOnce(state);
    expect(state.session_id).toBe(asSessionId("alive"));
  });

  test("context_rotate_threshold=0 disables proactive rotation", async () => {
    cfg.claude.context_rotate_threshold = 0;
    cfg.claude.max_steps_per_session = 0;
    const paths = runtimePaths(dir);
    const heavyUsage = { ...emptyUsage(), input_tokens: 199_000, output_tokens: 100 };
    const driver = new LoopDriver(dir, paths, cfg, undefined, {
      runStep: async () => mkResult({ session_id: asSessionId("ignored"), usage: heavyUsage }),
      headSha: async () => asSha("a"),
      headDiffHash: async () => null,
      autoCommit: async () => ({ committed: true, sha: asSha("a"), subject: "s" }),
    });
    const state = await driver.loadOrInitState();
    await driver.stepOnce(state);
    expect(state.session_id).toBe(asSessionId("ignored"));
  });

  test("max_steps_per_session=0 disables the cap", async () => {
    cfg.claude.max_steps_per_session = 0;
    const paths = runtimePaths(dir);
    const driver = new LoopDriver(dir, paths, cfg, undefined, {
      runStep: async () => mkResult({ session_id: asSessionId("alive") }),
      headSha: async () => asSha("a"),
      headDiffHash: async () => null,
      autoCommit: async () => ({ committed: true, sha: asSha("a"), subject: "s" }),
    });
    const state = await driver.loadOrInitState();
    for (let i = 0; i < 5; i++) await driver.stepOnce(state);
    expect(state.session_id).toBe(asSessionId("alive"));
    expect(state.steps_since_session_reset).toBe(5);
  });

  test("step with zero token usage does not move cache streak", async () => {
    const paths = runtimePaths(dir);
    const driver = new LoopDriver(dir, paths, cfg, undefined, {
      runStep: async () => mkResult(),
      headSha: async () => asSha("x"),
      headDiffHash: async () => null,
      autoCommit: async () => ({ committed: true, sha: asSha("x"), subject: "s" }),
    });
    const state = await driver.loadOrInitState();
    await driver.stepOnce(state);
    expect(state.cache_low_streak).toBe(0);
  });

  test("successful step clears last_failure", async () => {
    const paths = runtimePaths(dir);
    let nthCall = 0;
    const driver = new LoopDriver(dir, paths, cfg, undefined, {
      runStep: async () => {
        nthCall += 1;
        return nthCall === 1
          ? mkResult({ subtype: "error_during_execution", errors: ["boom"] })
          : mkResult({ session_id: asSessionId("s2") });
      },
      headSha: async () => asSha("abc"),
      headDiffHash: async () => "hash",
      autoCommit: async () => ({ committed: true, sha: asSha("abc"), subject: "subj" }),
    });
    const state = await driver.loadOrInitState();
    await driver.stepOnce(state);
    expect(state.last_failure).not.toBeNull();
    await driver.stepOnce(state);
    expect(state.last_failure).toBeNull();
  });
});
