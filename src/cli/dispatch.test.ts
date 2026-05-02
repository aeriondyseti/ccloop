import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { route, run, pickAutoLoop } from "./dispatch.ts";
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
    await run(["help"]);
    expect(stdoutChunks.join("")).toContain("Dev-build extras");
  });

  test("--help and -h also print help", async () => {
    await run(["--help"]);
    const out = stdoutChunks.join("");
    expect(out).toContain("ccloop — Claude Code loop runner");
    expect(out).toContain("ccloop design");
    expect(out).toContain("ccloop build");
  });

  test("--debug is consumed before subcommand routing", async () => {
    // If --debug leaked into rest, parseRunFlags would throw 'unknown flag'.
    // Use --version (no flag parser) to confirm the strip happens regardless
    // of position.
    const code = await run(["--debug", "--version"]);
    expect(code).toBe(0);
  });
});

describe("route()", () => {
  test("bare argv is auto", () => {
    expect(route([])).toEqual({ kind: "auto", rest: [] });
  });
  test("flag-only argv is auto and forwards flags", () => {
    expect(route(["--yolo"])).toEqual({ kind: "auto", rest: ["--yolo"] });
  });
  test("design subcommand routes to design", () => {
    expect(route(["design", "--no-tui"])).toEqual({ kind: "design", rest: ["--no-tui"] });
  });
  test("build subcommand routes to run (alias)", () => {
    expect(route(["build", "-y"])).toEqual({ kind: "run", rest: ["-y"] });
  });
  test("run subcommand still routes to run", () => {
    expect(route(["run", "-y"])).toEqual({ kind: "run", rest: ["-y"] });
  });
  test("init routes to init", () => {
    expect(route(["init"])).toEqual({ kind: "init", rest: [] });
  });
  test("help-likes route to help", () => {
    expect(route(["--help"])).toEqual({ kind: "help" });
    expect(route(["-h"])).toEqual({ kind: "help" });
    expect(route(["help"])).toEqual({ kind: "help" });
  });
  test("version-likes route to version", () => {
    expect(route(["--version"])).toEqual({ kind: "version" });
    expect(route(["-V"])).toEqual({ kind: "version" });
  });
  test("unknown subcommand surfaces the offending token", () => {
    expect(route(["bogus"])).toEqual({ kind: "unknown", first: "bogus" });
  });
  test("debug:foo routes to debug", () => {
    expect(route(["debug:info", "--x"])).toEqual({ kind: "debug", cmd: "info", rest: ["--x"] });
  });
});

describe("pickAutoLoop()", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ccloop-route-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("missing SPEC.md → design", async () => {
    expect(await pickAutoLoop(dir)).toBe("design");
  });
  test("invalid SPEC.md (no checklist) → design", async () => {
    writeFileSync(join(dir, "SPEC.md"), "# nothing here\n");
    expect(await pickAutoLoop(dir)).toBe("design");
  });
  test("valid SPEC.md → build", async () => {
    writeFileSync(
      join(dir, "SPEC.md"),
      "# Spec\n\n- [ ] do thing\n\n## Verification Requirements\n\nIt works.\n",
    );
    expect(await pickAutoLoop(dir)).toBe("build");
  });
});
