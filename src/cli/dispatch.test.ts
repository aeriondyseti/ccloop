import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { run } from "./dispatch.ts";
import { IS_DEV_BUILD } from "../build-info.ts";

/**
 * These tests run from the working tree, so IS_DEV_BUILD is true —
 * we exercise the dev-build branches. The "rejects on production"
 * branch is exercised in isolation by build-info.test.ts via the
 * pure isDevBuild() predicate.
 */
describe("dispatch (dev build)", () => {
  let stderrChunks: string[];
  let stdoutChunks: string[];
  let origErr: typeof process.stderr.write;
  let origOut: typeof process.stdout.write;

  beforeEach(() => {
    stderrChunks = [];
    stdoutChunks = [];
    origErr = process.stderr.write.bind(process.stderr);
    origOut = process.stdout.write.bind(process.stdout);
    process.stderr.write = ((chunk: string) => { stderrChunks.push(String(chunk)); return true; }) as typeof process.stderr.write;
    process.stdout.write = ((chunk: string) => { stdoutChunks.push(String(chunk)); return true; }) as typeof process.stdout.write;
    delete process.env.CCLOOP_DEBUG;
    delete process.env.CCLOOP_TUI_DEBUG;
  });
  afterEach(() => {
    process.stderr.write = origErr;
    process.stdout.write = origOut;
  });

  test("guard precondition: tests run on a dev build", () => {
    expect(IS_DEV_BUILD).toBe(true);
  });

  test("--debug sets CCLOOP_DEBUG and CCLOOP_TUI_DEBUG", async () => {
    // Pair with a benign subcommand so the dispatcher doesn't fall
    // through to the unknown-subcommand branch.
    await run(["--debug", "--version"]);
    expect(process.env.CCLOOP_DEBUG).toBe("1");
    expect(process.env.CCLOOP_TUI_DEBUG).toBe("1");
  });

  test("--debug doesn't override an explicit CCLOOP_TUI_DEBUG=0", async () => {
    process.env.CCLOOP_TUI_DEBUG = "0";
    await run(["--debug", "--version"]);
    expect(process.env.CCLOOP_TUI_DEBUG).toBe("0");
    expect(process.env.CCLOOP_DEBUG).toBe("1");
  });

  test("debug:info prints version + dev-build status", async () => {
    const code = await run(["debug:info"]);
    expect(code).toBe(0);
    const out = stdoutChunks.join("");
    expect(out).toContain("dev-build:");
    expect(out).toContain("version:");
  });

  test("unknown debug:foo errors", async () => {
    const code = await run(["debug:nope"]);
    expect(code).toBe(1);
    expect(stderrChunks.join("")).toMatch(/unknown command 'debug:nope'/);
  });

  test("--version prints (dev) tag on dev builds", async () => {
    await run(["--version"]);
    expect(stdoutChunks.join("")).toMatch(/\(dev\)/);
  });

  test("help shows dev-build extras section", async () => {
    await run([]);
    expect(stdoutChunks.join("")).toContain("Dev-build extras");
  });

  test("--debug is consumed before subcommand routing", async () => {
    // If --debug leaked into rest, parseRunFlags would throw 'unknown flag'.
    // Use --version (no flag parser) to confirm the strip happens regardless
    // of position.
    const code = await run(["--debug", "--version"]);
    expect(code).toBe(0);
  });
});
