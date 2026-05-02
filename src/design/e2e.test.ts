/**
 * End-to-end tests for ccloop design.
 *
 * Covers SPEC.md "Verification Requirements" §4 and §5:
 *   §4: empty fixture — agent (mocked) walks phases, writes the
 *       draft, /accept promotes to SPEC.md and offers `ccloop build`.
 *   §5: populated fixture — agent reads the existing source files
 *       via Read/Grep and references them in the produced spec.
 *
 * The SDK is mocked with a scripted `query` that yields prebuilt SDK
 * messages. Each "step" is a thunk so it can perform real file-write
 * side effects (simulating what the real Write tool would do) before
 * the orchestrator reloads the draft after seeing a tool_use block.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { runDesignSession } from "./orchestrator.ts";
import type { IoAdapter } from "./io.ts";
import { mergeConfig, type CcloopConfig } from "../config/schema.ts";

// ===== Fixtures =====

const TEMPLATE =
  `# SPEC\n\n` +
  `Replace me.\n\n` +
  `## Scope\n\n- [ ] placeholder\n\n` +
  `## Verification Requirements\n\nIt works.\n`;

let dir: string;
let templatePath: string;
let config: CcloopConfig;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ccloop-design-e2e-"));
  templatePath = join(dir, "_template-SPEC.md");
  writeFileSync(templatePath, TEMPLATE);
  config = mergeConfig(undefined);
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// ===== Test seams =====

interface RecordingAdapter extends IoAdapter {
  log: string[];
  draftSnapshots: string[];
}

function makeAdapter(opts: { inputs?: (string | null)[]; confirms?: boolean[] }): RecordingAdapter {
  const inputs = [...(opts.inputs ?? [])];
  const confirms = [...(opts.confirms ?? [])];
  const log: string[] = [];
  const draftSnapshots: string[] = [];
  return {
    log,
    draftSnapshots,
    showAssistantText: (t) => log.push(`assistant:${t}`),
    showToolUse: (n, s) => log.push(`tool:${n}:${s}`),
    showInfo: (t) => log.push(`info:${t}`),
    showError: (t) => log.push(`error:${t}`),
    draftUpdated: (c) => draftSnapshots.push(c),
    askUser: async () => ({ selected: [] }),
    getNextInput: async () => (inputs.length > 0 ? inputs.shift() ?? null : null),
    confirm: async () => confirms.shift() ?? false,
    close: async () => undefined,
  };
}

type Step = () => SDKMessage[];

/** Build a fake SDK query that runs `steps` in order, one per call. */
function makeScriptedQuery(steps: Step[]): typeof import("@anthropic-ai/claude-agent-sdk").query {
  let i = 0;
  return (() => {
    const idx = i < steps.length ? i : steps.length - 1;
    const messages = idx >= 0 && steps[idx] ? steps[idx]!() : [];
    i++;
    async function* gen(): AsyncGenerator<SDKMessage> {
      for (const m of messages) yield m;
    }
    return gen() as never;
  }) as never;
}

function emptyResultMessage(): SDKMessage {
  return {
    type: "result",
    subtype: "success",
    session_id: "fake-session",
    num_turns: 1,
    total_cost_usd: 0,
    duration_ms: 0,
    duration_api_ms: 0,
    is_error: false,
    result: "",
    usage: {
      input_tokens: 0, output_tokens: 0,
      cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
      server_tool_use: { web_search_requests: 0 },
    } as never,
    permission_denials: [],
    modelUsage: {} as never,
    uuid: "00000000-0000-0000-0000-000000000000",
  } as never as SDKMessage;
}

function assistantMessage(content: Array<
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
>): SDKMessage {
  return {
    type: "assistant",
    session_id: "fake-session",
    parent_tool_use_id: null,
    uuid: "11111111-1111-1111-1111-111111111111",
    message: {
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: "fake",
      stop_reason: "end_turn",
      stop_sequence: null,
      content: content as never,
      usage: {
        input_tokens: 0, output_tokens: 0,
        cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
        server_tool_use: { web_search_requests: 0 },
      } as never,
    } as never,
  } as never as SDKMessage;
}

// ===== VR §4: empty fixture =====

describe("ccloop design — empty fixture", () => {
  test("agent edits draft → user /accept → SPEC.md promoted, build offered", async () => {
    const draftPath = join(dir, ".ccloop", "design", "spec.draft.md");
    const finishedDraft =
      `# Empty Project\n\n` +
      `## Vision\n\nSomething useful.\n\n` +
      `## Users\n\nDevelopers.\n\n` +
      `## Scope\n\n- [ ] core\n- [ ] tests\n\n` +
      `## Architecture\n\nBun + TypeScript.\n\n` +
      `## Milestones\n\n- [ ] M1\n\n` +
      `## Verification Requirements\n\nAll milestones complete.\n`;

    const queryImpl = makeScriptedQuery([
      // Turn 1: agent emits a Write tool_use that mutates the draft.
      () => {
        // Side effect: simulate the real Write tool by writing the file.
        mkdirSync(join(dir, ".ccloop", "design"), { recursive: true });
        writeFileSync(draftPath, finishedDraft);
        return [
          assistantMessage([
            { type: "text", text: "Drafting the spec." },
            { type: "tool_use", id: "t1", name: "Write", input: {
              file_path: ".ccloop/design/spec.draft.md",
              content: finishedDraft,
            } },
          ]),
          emptyResultMessage(),
        ];
      },
    ]);

    const io = makeAdapter({
      inputs: ["/accept"],
      confirms: [true, true], // promote? yes; launch build? yes
    });

    const result = await runDesignSession({
      cwd: dir, config, io, queryImpl, templatePath,
    });

    expect(result.outcome).toBe("accepted");
    const promoted = join(dir, "SPEC.md");
    expect(existsSync(promoted)).toBe(true);
    const promotedContent = readFileSync(promoted, "utf8");
    expect(promotedContent).toContain("## Vision");
    expect(promotedContent).toContain("## Verification Requirements");
    // Build offer surfaces in the transcript.
    expect(io.log.some((l) => l.includes("ccloop build"))).toBe(true);
    // Agent's first edit visible as a tool_use in the transcript.
    expect(io.log.some((l) => l.startsWith("tool:Write"))).toBe(true);
  });
});

// ===== VR §5: populated fixture =====

describe("ccloop design — populated fixture", () => {
  test("agent reads existing source files and references them in the draft", async () => {
    // Seed the fixture with existing source files.
    writeFileSync(
      join(dir, "main.ts"),
      `export function hello() { return "world"; }\n`,
    );
    writeFileSync(
      join(dir, "README.md"),
      `# legacy-tool\n\nA tiny utility for greeting.\n`,
    );

    const draftPath = join(dir, ".ccloop", "design", "spec.draft.md");
    const referencingDraft =
      `# legacy-tool — v2\n\n` +
      `## Vision\n\nRebuild the legacy ${"`main.ts`"} hello() utility with proper TypeScript types ` +
      `and a CLI wrapper, replacing the bare README.md description.\n\n` +
      `## Users\n\nThe single developer using this in scripts.\n\n` +
      `## Scope\n\n- [ ] CLI wrapper around hello()\n- [ ] Migrate existing main.ts\n\n` +
      `## Architecture\n\nBun, single-file CLI, no deps.\n\n` +
      `## Milestones\n\n- [ ] M1: parity with current main.ts\n\n` +
      `## Verification Requirements\n\nUnit tests pass; CLI wraps hello().\n`;

    const queryImpl = makeScriptedQuery([
      () => {
        mkdirSync(join(dir, ".ccloop", "design"), { recursive: true });
        writeFileSync(draftPath, referencingDraft);
        return [
          // Read tool calls (transcript-only — no side effect needed).
          assistantMessage([
            { type: "text", text: "Surveying the existing codebase." },
            { type: "tool_use", id: "r1", name: "Read", input: { file_path: "main.ts" } },
            { type: "tool_use", id: "r2", name: "Read", input: { file_path: "README.md" } },
            { type: "tool_use", id: "g1", name: "Grep", input: { pattern: "hello" } },
            { type: "tool_use", id: "w1", name: "Write", input: {
              file_path: ".ccloop/design/spec.draft.md",
              content: referencingDraft,
            } },
          ]),
          emptyResultMessage(),
        ];
      },
    ]);

    const io = makeAdapter({
      inputs: ["/accept"],
      confirms: [true, false], // promote? yes; launch build? no
    });

    const result = await runDesignSession({
      cwd: dir, config, io, queryImpl, templatePath,
    });

    expect(result.outcome).toBe("accepted");
    const promoted = readFileSync(join(dir, "SPEC.md"), "utf8");
    expect(promoted).toContain("main.ts");
    expect(promoted).toContain("README.md");
    expect(promoted).toContain("## Verification Requirements");
    // Read/Grep tool uses surfaced to the transcript.
    expect(io.log.some((l) => l.startsWith("tool:Read:main.ts"))).toBe(true);
    expect(io.log.some((l) => l.startsWith("tool:Read:README.md"))).toBe(true);
    expect(io.log.some((l) => l.startsWith("tool:Grep:hello"))).toBe(true);
  });
});
