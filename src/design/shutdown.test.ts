/**
 * Tests for the graceful-shutdown signal and its integration with
 * runDesignSession. The orchestrator is driven with a fake `query`
 * so we can assert that:
 *  - First Ctrl+C triggers a summary turn (the agent sees
 *    SHUTDOWN_SUMMARY_PROMPT) and writes last-session.md.
 *  - Second Ctrl+C aborts the SDK call mid-stream (the controller
 *    is .aborted).
 *  - Without a Ctrl+C, the orchestrator behaves normally (no
 *    summary turn, no last-session.md).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  awaitInputOrShutdown, createShutdownSignal, SHUTDOWN_SUMMARY_PROMPT,
  SHUTDOWN_TICK,
} from "./shutdown.ts";
import { runDesignSession } from "./orchestrator.ts";
import type { IoAdapter } from "./io.ts";
import type { CcloopConfig } from "../config/schema.ts";
import { mergeConfig } from "../config/schema.ts";
import { fakeResultMessage } from "../sdk/sdkMessages.fixtures.ts";

const TEMPLATE =
  `# Spec\n\n- [ ] thing\n\n## Verification Requirements\n\nIt works.\n`;

let dir: string;
let templatePath: string;
let config: CcloopConfig;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ccloop-shutdown-"));
  templatePath = join(dir, "template.md");
  writeFileSync(templatePath, TEMPLATE);
  config = mergeConfig(undefined);
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function makeAdapter(opts: { inputs?: (string | null)[]; confirms?: boolean[] } = {}): IoAdapter & { calls: string[] } {
  const inputs = [...(opts.inputs ?? [])];
  const confirms = [...(opts.confirms ?? [])];
  const calls: string[] = [];
  return {
    calls,
    showAssistantText: (t) => calls.push(`assistant:${t}`),
    showToolUse: (n) => calls.push(`tool:${n}`),
    showInfo: (t) => calls.push(`info:${t}`),
    showError: (t) => calls.push(`error:${t}`),
    draftUpdated: () => undefined,
    askUser: async () => ({ selected: [] }),
    getNextInput: async () => (inputs.length > 0 ? inputs.shift() ?? null : null),
    confirm: async () => confirms.shift() ?? false,
    close: async () => undefined,
  };
}

/** Records every prompt the SDK is invoked with, then yields a single
 *  empty result so the orchestrator advances. */
function makeRecordingQuery(seenPrompts: string[]): typeof import("@anthropic-ai/claude-agent-sdk").query {
  return ((args: { prompt: string }) => {
    seenPrompts.push(args.prompt);
    async function* gen(): AsyncGenerator<SDKMessage> {
      yield fakeResultMessage();
    }
    return gen() as never;
  }) as never;
}

describe("ShutdownSignal", () => {
  test("requestGraceful is idempotent and resolves whenRequested()", async () => {
    const sd = createShutdownSignal();
    expect(sd.requested).toBe(false);
    sd.requestGraceful();
    sd.requestGraceful(); // second call is a no-op
    expect(sd.requested).toBe(true);
    await sd.whenRequested(); // should resolve immediately
  });

  test("forceAbort flips abortSignal and is idempotent", () => {
    const sd = createShutdownSignal();
    expect(sd.abortSignal.aborted).toBe(false);
    sd.forceAbort();
    sd.forceAbort();
    expect(sd.abortSignal.aborted).toBe(true);
  });

  test("awaitInputOrShutdown returns the input when it wins the race", async () => {
    const sd = createShutdownSignal();
    const result = await awaitInputOrShutdown(Promise.resolve("hello"), sd);
    expect(result).toBe("hello");
  });

  test("awaitInputOrShutdown returns SHUTDOWN_TICK when shutdown wins", async () => {
    const sd = createShutdownSignal();
    let resolveInput!: (v: string | null) => void;
    const inputPromise = new Promise<string | null>((r) => { resolveInput = r; });
    const racePromise = awaitInputOrShutdown(inputPromise, sd);
    sd.requestGraceful();
    const result = await racePromise;
    expect(result).toBe(SHUTDOWN_TICK);
    resolveInput(null); // cleanup
  });

  test("awaitInputOrShutdown short-circuits if shutdown was already requested", async () => {
    const sd = createShutdownSignal();
    sd.requestGraceful();
    let resolved = false;
    const inputPromise = new Promise<string | null>(() => { /* never resolves */ });
    const result = await awaitInputOrShutdown(inputPromise, sd);
    expect(result).toBe(SHUTDOWN_TICK);
    expect(resolved).toBe(false);
  });
});

describe("runDesignSession with shutdown", () => {
  test("first Ctrl+C swaps in the summary prompt as the next agent turn", async () => {
    const seenPrompts: string[] = [];
    const io = makeAdapter({ inputs: ["hello world"] });
    const sd = createShutdownSignal();
    // Trigger graceful shutdown after the first SDK turn completes
    // but before the user-input wait resolves. We simulate by tripping
    // it before the second iteration via an intercepted getNextInput.
    const origGetNext = io.getNextInput;
    io.getNextInput = async () => {
      sd.requestGraceful();
      // Return null so the loop falls through if the race somehow
      // chooses the input branch — should not happen because
      // requestGraceful() trips first.
      return await origGetNext();
    };
    const result = await runDesignSession({
      cwd: dir, config, io, queryImpl: makeRecordingQuery(seenPrompts),
      templatePath, shutdown: sd,
    });
    expect(result.outcome).toBe("aborted");
    // Two SDK calls: the initial seed prompt, then the summary prompt.
    expect(seenPrompts.length).toBe(2);
    expect(seenPrompts[1]).toBe(SHUTDOWN_SUMMARY_PROMPT);
    expect(io.calls.some((c) => c.includes("Session summary written"))).toBe(true);
  });

  test("forceAbort during SDK call surfaces as aborted, not error", async () => {
    const seenPrompts: string[] = [];
    const io = makeAdapter({ inputs: [null] });
    const sd = createShutdownSignal();
    // Build a fake query that throws an AbortError-shaped object.
    const queryImpl = (() => {
      async function* gen() {
        sd.forceAbort();
        const err = new Error("aborted");
        err.name = "AbortError";
        throw err;
      }
      return gen();
    }) as never;
    const result = await runDesignSession({
      cwd: dir, config, io, queryImpl, templatePath, shutdown: sd,
    });
    expect(result.outcome).toBe("aborted");
    expect(io.calls.some((c) => c.startsWith("error:"))).toBe(false);
  });

  test("summary turn produces a non-empty last-session.md on disk (VR §6)", async () => {
    const seenPrompts: string[] = [];
    const lastSessionPath = join(dir, ".ccloop", "design", "last-session.md");
    const summaryBody =
      "## Session summary\n\nDecisions: x. Open questions: y. Left off at: z.\n";
    const io = makeAdapter({});
    const sd = createShutdownSignal();

    // Trip graceful shutdown immediately so the very first wait for
    // user input fast-paths into the summary turn.
    sd.requestGraceful();

    // Scripted SDK: the second invocation (the summary turn) writes
    // the last-session.md file as the real Write tool would.
    const queryImpl = ((args: { prompt: string }) => {
      seenPrompts.push(args.prompt);
      const isSummaryTurn = args.prompt === SHUTDOWN_SUMMARY_PROMPT;
      async function* gen() {
        if (isSummaryTurn) {
          mkdirSync(join(dir, ".ccloop", "design"), { recursive: true });
          writeFileSync(lastSessionPath, summaryBody);
        }
        yield fakeResultMessage();
      }
      return gen() as never;
    }) as never;

    const result = await runDesignSession({
      cwd: dir, config, io, queryImpl, templatePath, shutdown: sd,
    });

    expect(result.outcome).toBe("aborted");
    expect(seenPrompts).toContain(SHUTDOWN_SUMMARY_PROMPT);
    expect(existsSync(lastSessionPath)).toBe(true);
    const written = readFileSync(lastSessionPath, "utf8");
    expect(written.length).toBeGreaterThan(0);
    expect(written).toBe(summaryBody);
  });

  test("happy path without shutdown does not invoke the summary prompt", async () => {
    const seenPrompts: string[] = [];
    const io = makeAdapter({ inputs: ["/abort"] });
    await runDesignSession({
      cwd: dir, config, io, queryImpl: makeRecordingQuery(seenPrompts),
      templatePath,
    });
    expect(seenPrompts.length).toBe(1);
    expect(seenPrompts[0]).not.toBe(SHUTDOWN_SUMMARY_PROMPT);
  });
});
