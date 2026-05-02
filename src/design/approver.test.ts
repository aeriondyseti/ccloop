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

function decisionOf(result: unknown): "allow" | "deny" | "passthrough" {
  if (!result || typeof result !== "object") return "passthrough";
  const r = result as Record<string, unknown>;
  if (r.continue === true) return "passthrough";
  const out = r.hookSpecificOutput as Record<string, unknown> | undefined;
  const decision = out?.permissionDecision;
  if (decision === "allow" || decision === "deny") return decision;
  return "passthrough";
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
      expect(decisionOf(result)).toBe("deny");
    });

    test("MultiEdit allows when every edit is under .ccloop/design/", async () => {
      const approver = makeDesignApprover({ cwd: CWD });
      const result = await callHook(approver, makeInput("MultiEdit", {
        edits: [
          { file_path: ".ccloop/design/spec.draft.md" },
          { file_path: ".ccloop/design/ROADMAP.md" },
        ],
      }));
      expect(decisionOf(result)).toBe("allow");
    });

    test("MultiEdit denies when ANY later edit escapes — not just the first", async () => {
      // Regression: getTargetPath used to return only edits[0].file_path,
      // letting an agent smuggle a forbidden path past the gate by
      // putting a permitted one first.
      const approver = makeDesignApprover({ cwd: CWD });
      const result = await callHook(approver, makeInput("MultiEdit", {
        edits: [
          { file_path: ".ccloop/design/spec.draft.md" }, // permitted
          { file_path: "../../etc/passwd" },             // smuggled
        ],
      }));
      expect(decisionOf(result)).toBe("deny");
    });

    test("MultiEdit denies an absolute path outside designDir", async () => {
      const approver = makeDesignApprover({ cwd: CWD });
      const result = await callHook(approver, makeInput("MultiEdit", {
        edits: [{ file_path: "/etc/passwd" }],
      }));
      expect(decisionOf(result)).toBe("deny");
    });

    test("MultiEdit with no parseable paths falls through (tool handles error)", async () => {
      const approver = makeDesignApprover({ cwd: CWD });
      const result = await callHook(approver, makeInput("MultiEdit", { edits: [] }));
      expect(decisionOf(result)).toBe("allow");
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
