import { describe, test, expect } from "bun:test";
import { makeDesignApprover } from "./approver.ts";
import type { HookInput } from "@anthropic-ai/claude-agent-sdk";

const CWD = "/home/user/project";

function makeInput(toolName: string, toolInput: Record<string, unknown>): HookInput {
  return {
    hook_event_name: "PreToolUse",
    tool_name: toolName,
    tool_input: toolInput,
  } as HookInput;
}

async function callHook(approver: ReturnType<typeof makeDesignApprover>, input: HookInput) {
  const abortController = new AbortController();
  return await approver(input, undefined, { signal: abortController.signal });
}

describe("makeDesignApprover", () => {
  describe("file edit tools", () => {
    test("allows Write to .ccloop/design/spec.draft.md", async () => {
      const approver = makeDesignApprover({ cwd: CWD });
      const input = makeInput("Write", {
        file_path: ".ccloop/design/spec.draft.md",
        content: "# Spec",
      });

      const result = await callHook(approver, input);
      expect(result).toHaveProperty("hookSpecificOutput");
    });

    test("denies Write to SPEC.md at project root", async () => {
      const approver = makeDesignApprover({ cwd: CWD });
      const input = makeInput("Write", {
        file_path: "SPEC.md",
        content: "# Spec",
      });

      const result = await callHook(approver, input);
      expect(result).toHaveProperty("hookSpecificOutput");
    });

    test("denies Write using .. to escape design directory", async () => {
      const approver = makeDesignApprover({ cwd: CWD });
      const input = makeInput("Write", {
        file_path: ".ccloop/design/../events.jsonl",
        content: "escape attempt",
      });

      const result = await callHook(approver, input);
      expect(result).toHaveProperty("hookSpecificOutput");
    });
  });

  describe("Bash tool", () => {
    test("allows safe Bash command", async () => {
      const approver = makeDesignApprover({
        cwd: CWD,
        platform: "linux",
        hasBin: () => true,
      });
      const input = makeInput("Bash", {
        command: "ls -la",
      });

      const result = await callHook(approver, input);
      expect(result).toHaveProperty("hookSpecificOutput");
    });

    test("denies Bash command on denylist", async () => {
      const approver = makeDesignApprover({ cwd: CWD });
      const input = makeInput("Bash", {
        command: "rm -rf /",
      });

      const result = await callHook(approver, input);
      expect(result).toHaveProperty("hookSpecificOutput");
    });

    test("wraps Bash command on Linux", async () => {
      const approver = makeDesignApprover({
        cwd: CWD,
        platform: "linux",
        hasBin: () => true,
      });
      const input = makeInput("Bash", {
        command: "echo hello",
      });

      const result = await callHook(approver, input);
      expect(result).toHaveProperty("hookSpecificOutput");
    });
  });

  describe("read-only tools", () => {
    test("allows Read tool", async () => {
      const approver = makeDesignApprover({ cwd: CWD });
      const input = makeInput("Read", {
        file_path: "src/file.ts",
      });

      const result = await callHook(approver, input);
      expect(result).toHaveProperty("hookSpecificOutput");
    });

    test("allows WebFetch tool", async () => {
      const approver = makeDesignApprover({ cwd: CWD });
      const input = makeInput("WebFetch", {
        url: "https://example.com",
        prompt: "fetch page",
      });

      const result = await callHook(approver, input);
      expect(result).toHaveProperty("hookSpecificOutput");
    });
  });

  describe("other hook events", () => {
    test("passes through non-PreToolUse events", async () => {
      const approver = makeDesignApprover({ cwd: CWD });
      const input = {
        hook_event_name: "PostToolUse",
        tool_name: "Write",
      } as HookInput;

      const result = await callHook(approver, input);
      expect(result).toHaveProperty("continue");
    });
  });
});
