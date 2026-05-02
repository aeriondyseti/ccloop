/**
 * Smoke tests for runDesignSession.
 *
 * Mocks the SDK by injecting a fake `query` that yields a scripted
 * stream of SDK messages, and a fake IoAdapter that records the
 * presentation calls and scripts user input. The point is to verify
 * the conversation control flow (turn alternation, /accept gate,
 * /abort, validation gate) without paying for real model inference.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDesignSession } from "./orchestrator.ts";
import type { IoAdapter } from "./io.ts";
import type { CcloopConfig } from "../config/schema.ts";
import { mergeConfig } from "../config/schema.ts";
import type { AskUserInput, AskUserResult } from "../mcp/ask-user.ts";
import { makeQuietQuery } from "../sdk/sdkMessages.fixtures.ts";

interface RecordedAdapter extends IoAdapter {
  log: string[];
  draftSnapshots: string[];
  /** Queue of strings returned by getNextInput, in order. */
  inputs: (string | null)[];
  /** Queue of confirm() return values. */
  confirms: boolean[];
  /** Optional scripted ask_user replies. */
  askReplies: AskUserResult[];
}

function makeAdapter(opts: {
  inputs?: (string | null)[];
  confirms?: boolean[];
  askReplies?: AskUserResult[];
} = {}): RecordedAdapter {
  const log: string[] = [];
  const draftSnapshots: string[] = [];
  const inputs = [...(opts.inputs ?? [])];
  const confirms = [...(opts.confirms ?? [])];
  const askReplies = [...(opts.askReplies ?? [])];
  return {
    log, draftSnapshots, inputs, confirms, askReplies,
    showAssistantText(t) { log.push(`assistant:${t}`); },
    showToolUse(n, s) { log.push(`tool:${n}:${s}`); },
    showInfo(t) { log.push(`info:${t}`); },
    showError(t) { log.push(`error:${t}`); },
    draftUpdated(c) { draftSnapshots.push(c); },
    async askUser(input: AskUserInput): Promise<AskUserResult> {
      log.push(`ask:${input.question}`);
      return askReplies.shift() ?? { selected: [] };
    },
    async getNextInput() {
      if (inputs.length === 0) return null;
      const v = inputs.shift();
      return v ?? null;
    },
    async confirm(q, _def) {
      log.push(`confirm:${q}`);
      const v = confirms.shift();
      return v ?? false;
    },
    async close() { log.push("close"); },
  };
}

const TEMPLATE_CONTENT =
  `# SPEC\n\n` +
  `Replace me.\n\n` +
  `## Scope\n\n- [ ] Build the thing\n\n` +
  `## Verification Requirements\n\nIt works.\n`;

let dir: string;
let templatePath: string;
let config: CcloopConfig;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ccloop-design-"));
  templatePath = join(dir, "template-SPEC.md");
  writeFileSync(templatePath, TEMPLATE_CONTENT);
  config = mergeConfig(undefined);
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("runDesignSession", () => {
  test("user types /accept on a valid draft → outcome accepted, SPEC.md written", async () => {
    const io = makeAdapter({
      inputs: ["/accept"],
      // confirm() called twice: promote? (yes) and launch build? (no)
      confirms: [true, false],
    });
    const result = await runDesignSession({
      cwd: dir, config, io,
      queryImpl: makeQuietQuery(),
      templatePath,
    });
    expect(result.outcome).toBe("accepted");
    expect(existsSync(join(dir, "SPEC.md"))).toBe(true);
    // Promoted file matches the template content (no agent edits in this test).
    expect(readFileSync(join(dir, "SPEC.md"), "utf8")).toContain("## Verification Requirements");
    expect(io.log.some((l) => l.startsWith("info:Promoted to repo root:"))).toBe(true);
  });

  test("user types /abort → outcome aborted, no SPEC.md written", async () => {
    const io = makeAdapter({ inputs: ["/abort"] });
    const result = await runDesignSession({
      cwd: dir, config, io,
      queryImpl: makeQuietQuery(),
      templatePath,
    });
    expect(result.outcome).toBe("aborted");
    expect(existsSync(join(dir, "SPEC.md"))).toBe(false);
  });

  test("validation failure on /accept keeps the loop alive and surfaces the error", async () => {
    // Replace the template with an invalid draft (no checklist).
    writeFileSync(templatePath, "# Empty\n\nno checklist here\n");
    const io = makeAdapter({ inputs: ["/accept", "/abort"] });
    const result = await runDesignSession({
      cwd: dir, config, io,
      queryImpl: makeQuietQuery(),
      templatePath,
    });
    expect(result.outcome).toBe("aborted");
    expect(io.log.some((l) => l.startsWith("error:Draft validation failed"))).toBe(true);
    expect(existsSync(join(dir, "SPEC.md"))).toBe(false);
  });

  test("declining the promotion confirm keeps the loop alive", async () => {
    const io = makeAdapter({
      inputs: ["/accept", "/abort"],
      confirms: [false], // declined the promote prompt
    });
    const result = await runDesignSession({
      cwd: dir, config, io,
      queryImpl: makeQuietQuery(),
      templatePath,
    });
    expect(result.outcome).toBe("aborted");
    expect(existsSync(join(dir, "SPEC.md"))).toBe(false);
  });

  test("seeds the draft from templatePath if none exists", async () => {
    const io = makeAdapter({ inputs: ["/abort"] });
    await runDesignSession({
      cwd: dir, config, io,
      queryImpl: makeQuietQuery(),
      templatePath,
    });
    const draftPath = join(dir, ".ccloop", "design", "spec.draft.md");
    expect(existsSync(draftPath)).toBe(true);
    expect(readFileSync(draftPath, "utf8")).toBe(TEMPLATE_CONTENT);
    // The adapter received the initial draft via draftUpdated.
    expect(io.draftSnapshots[0]).toBe(TEMPLATE_CONTENT);
  });

  test("preserves a pre-existing draft instead of overwriting", async () => {
    const designDir = join(dir, ".ccloop", "design");
    mkdirSync(designDir, { recursive: true });
    const preexisting =
      `# Existing\n\n- [ ] keep me\n\n## Verification Requirements\n\ndone.\n`;
    writeFileSync(join(designDir, "spec.draft.md"), preexisting);
    const io = makeAdapter({ inputs: ["/abort"] });
    await runDesignSession({
      cwd: dir, config, io,
      queryImpl: makeQuietQuery(),
      templatePath,
    });
    expect(readFileSync(join(designDir, "spec.draft.md"), "utf8")).toBe(preexisting);
  });
});
