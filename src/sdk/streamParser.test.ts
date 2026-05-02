import { describe, expect, test } from "bun:test";
import {
  StreamParser, summarizeToolInput, excerptToolResult,
} from "./streamParser.ts";

const TS = "2026-04-27T20:00:00.000Z";

describe("StreamParser", () => {
  test("assistant text block → assistant_text turn event", () => {
    const p = new StreamParser();
    const out = p.consume({
      type: "assistant",
      message: {
        content: [{ type: "text", text: "Hello world" }],
      },
    }, TS);
    expect(out).toEqual([
      { kind: "assistant_text", text: "Hello world", ts: TS },
    ]);
  });

  test("assistant thinking block → thinking turn event", () => {
    const p = new StreamParser();
    const out = p.consume({
      type: "assistant",
      message: {
        content: [{ type: "thinking", thinking: "let me reconsider" }],
      },
    }, TS);
    expect(out).toEqual([
      { kind: "thinking", text: "let me reconsider", ts: TS },
    ]);
  });

  test("empty thinking block is skipped", () => {
    const p = new StreamParser();
    const out = p.consume({
      type: "assistant",
      message: {
        content: [{ type: "thinking", thinking: "   " }],
      },
    }, TS);
    expect(out).toEqual([]);
  });

  test("assistant tool_use block → tool_use turn event", () => {
    const p = new StreamParser();
    const out = p.consume({
      type: "assistant",
      message: {
        content: [{
          type: "tool_use", id: "tu_1", name: "Bash",
          input: { command: "bun test" },
        }],
      },
    }, TS);
    expect(out).toEqual([
      { kind: "tool_use", tool: "Bash", summary: "bun test", ts: TS },
    ]);
  });

  test("tool_result block pairs with prior tool_use by id", () => {
    const p = new StreamParser();
    p.consume({
      type: "assistant",
      message: {
        content: [{
          type: "tool_use", id: "tu_42", name: "Read",
          input: { file_path: "/x/foo.ts" },
        }],
      },
    }, TS);
    const out = p.consume({
      type: "user",
      message: {
        content: [{
          type: "tool_result", tool_use_id: "tu_42",
          content: "file contents here",
          is_error: false,
        }],
      },
    }, TS);
    expect(out).toEqual([
      { kind: "tool_result", tool: "Read", ok: true, excerpt: "file contents here", ts: TS },
    ]);
  });

  test("tool_result with is_error=true marks ok=false", () => {
    const p = new StreamParser();
    p.consume({
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "x", name: "Bash", input: {} }] },
    }, TS);
    const out = p.consume({
      type: "user",
      message: {
        content: [{
          type: "tool_result", tool_use_id: "x",
          content: "boom", is_error: true,
        }],
      },
    }, TS);
    expect(out[0]?.kind).toBe("tool_result");
    if (out[0]?.kind === "tool_result") expect(out[0].ok).toBe(false);
  });

  test("empty/whitespace text blocks are skipped", () => {
    const p = new StreamParser();
    const out = p.consume({
      type: "assistant",
      message: { content: [{ type: "text", text: "   \n  " }] },
    }, TS);
    expect(out).toEqual([]);
  });

  test("TodoWrite tool_use emits both tool_use and todo_state events", () => {
    const p = new StreamParser();
    const out = p.consume({
      type: "assistant",
      message: {
        content: [{
          type: "tool_use", id: "tu_99", name: "TodoWrite",
          input: { todos: [
            { content: "Read SPEC", status: "completed", activeForm: "Reading SPEC" },
            { content: "Write tests", status: "in_progress", activeForm: "Writing tests" },
            { content: "Ship it", status: "pending" },
          ] },
        }],
      },
    }, TS);
    expect(out.length).toBe(2);
    expect(out[0]?.kind).toBe("tool_use");
    expect(out[1]).toEqual({
      kind: "todo_state",
      ts: TS,
      todos: [
        { content: "Read SPEC", status: "completed", activeForm: "Reading SPEC" },
        { content: "Write tests", status: "in_progress", activeForm: "Writing tests" },
        { content: "Ship it", status: "pending" },
      ],
    });
  });

  test("TodoWrite with malformed input falls back to bare tool_use", () => {
    const p = new StreamParser();
    const out = p.consume({
      type: "assistant",
      message: {
        content: [{
          type: "tool_use", id: "tu_1", name: "TodoWrite",
          input: { /* missing todos */ },
        }],
      },
    }, TS);
    // Only the generic tool_use event — todo_state silently skipped.
    expect(out.length).toBe(1);
    expect(out[0]?.kind).toBe("tool_use");
  });

  test("TodoWrite skips items with invalid status", () => {
    const p = new StreamParser();
    const out = p.consume({
      type: "assistant",
      message: {
        content: [{
          type: "tool_use", id: "x", name: "TodoWrite",
          input: { todos: [
            { content: "good", status: "pending" },
            { content: "bad-status", status: "frobnicating" },
            { content: "", status: "pending" }, // empty content
          ] },
        }],
      },
    }, TS);
    const todoEv = out.find((e) => e.kind === "todo_state");
    expect(todoEv && todoEv.kind === "todo_state" ? todoEv.todos.length : -1).toBe(1);
  });

  test("ignores result/system message types", () => {
    const p = new StreamParser();
    expect(p.consume({ type: "result", subtype: "success" }, TS)).toEqual([]);
    expect(p.consume({ type: "system", session_id: "s" }, TS)).toEqual([]);
  });

  test("non-object inputs return []", () => {
    const p = new StreamParser();
    expect(p.consume(null, TS)).toEqual([]);
    expect(p.consume("hi", TS)).toEqual([]);
    expect(p.consume(42, TS)).toEqual([]);
  });
});

describe("summarizeToolInput", () => {
  test("Bash uses command", () => {
    expect(summarizeToolInput("Bash", { command: "ls -la" })).toBe("ls -la");
  });
  test("Edit/Write/Read use file_path", () => {
    expect(summarizeToolInput("Edit", { file_path: "/x" })).toBe("/x");
    expect(summarizeToolInput("Write", { file_path: "/y" })).toBe("/y");
    expect(summarizeToolInput("Read", { file_path: "/z" })).toBe("/z");
  });
  test("collapses internal whitespace and caps length", () => {
    const long = "a ".repeat(200);
    const out = summarizeToolInput("Bash", { command: long });
    expect(out.length).toBeLessThanOrEqual(100);
    expect(out).not.toContain("\n");
  });
  test("falls back to JSON for unknown tool", () => {
    expect(summarizeToolInput("MysteryTool", { foo: "bar" }))
      .toContain("foo");
  });
  test("Bash unwraps bwrap / sandbox-exec wrappers for display", () => {
    // Regression: the sandbox approver prefixes Bash commands with
    // bwrap / sandbox-exec so the actual user command was buried
    // deep in the wrapped string and got truncated off the end of
    // the 100-char dashboard summary. The unwrap restores the
    // user-recognisable form.
    const wrapped =
      "bwrap --ro-bind / / --proc /proc --dev /dev --tmpfs /tmp --bind '/p' '/p' --chdir '/p' --die-with-parent -- /bin/sh -c 'bun test'";
    expect(summarizeToolInput("Bash", { command: wrapped })).toBe("bun test");
    const macWrapped =
      `sandbox-exec -p '(version 1)(allow default)(deny file-write*)(allow file-write*)' /bin/sh -c 'echo hi'`;
    expect(summarizeToolInput("Bash", { command: macWrapped })).toBe("echo hi");
    // Already-unwrapped commands pass through unchanged.
    expect(summarizeToolInput("Bash", { command: "ls -la" })).toBe("ls -la");
  });
});

describe("excerptToolResult", () => {
  test("plain string returns first non-empty line", () => {
    expect(excerptToolResult("\n\nfirst\nsecond")).toBe("first");
  });
  test("array of blocks finds first text block", () => {
    expect(excerptToolResult([
      { type: "image" },
      { type: "text", text: "hello there" },
    ])).toBe("hello there");
  });
  test("caps to 200 chars", () => {
    const huge = "x".repeat(500);
    expect(excerptToolResult(huge).length).toBe(200);
  });
});
