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
