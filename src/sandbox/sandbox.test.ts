import { describe, expect, test } from "bun:test";
import { checkDenylist } from "./denylist.ts";
import { wrapBash, bwrapCommand, sandboxExecCommand } from "./wrap.ts";
import { makeApprover } from "./approver.ts";

describe("denylist", () => {
  test("rm -rf / blocked", () => {
    expect(checkDenylist("rm -rf /")).not.toBe(null);
    expect(checkDenylist("rm -rf /*")).not.toBe(null);
  });
  test("sudo blocked", () => {
    expect(checkDenylist("sudo apt install foo")).not.toBe(null);
  });
  test("fork bomb blocked", () => {
    expect(checkDenylist(":(){:|:&};:")).not.toBe(null);
  });
  test("normal commands allowed", () => {
    expect(checkDenylist("ls -la")).toBe(null);
    expect(checkDenylist("rm -rf node_modules")).toBe(null);
    expect(checkDenylist("git commit -m x")).toBe(null);
  });
});

describe("wrapBash", () => {
  test("linux without bwrap → unavailable", () => {
    const r = wrapBash({
      command: "ls", cwd: "/x", platform: "linux", hasBin: () => false,
    });
    expect(r.kind).toBe("unavailable");
  });

  test("linux with bwrap → wrap", () => {
    const r = wrapBash({
      command: "ls", cwd: "/x", platform: "linux",
      hasBin: (p) => p === "/usr/bin/bwrap",
    });
    expect(r.kind).toBe("wrap");
    if (r.kind === "wrap") {
      expect(r.command).toContain("bwrap");
      expect(r.command).toContain("--unshare-net");
      expect(r.command).toContain("'ls'");
    }
  });

  test("darwin → wrap with sandbox-exec", () => {
    const r = wrapBash({
      command: "ls", cwd: "/x", platform: "darwin",
    });
    expect(r.kind).toBe("wrap");
    if (r.kind === "wrap") expect(r.command).toContain("sandbox-exec");
  });

  test("other → passthrough", () => {
    const r = wrapBash({
      command: "ls", cwd: "/x", platform: "other",
    });
    expect(r.kind).toBe("passthrough");
  });

  test("bwrap quotes safely", () => {
    const cmd = bwrapCommand("/usr/bin/bwrap", "/p", "echo 'hi'");
    expect(cmd).toContain("--bind '/p' '/p'");
  });

  test("sandbox-exec profile mentions cwd", () => {
    const cmd = sandboxExecCommand("/path/to/proj", "echo hi");
    expect(cmd).toContain("/path/to/proj");
    expect(cmd).toContain("deny file-write*");
  });
});

/** Build a PreToolUse hook input shaped like what the SDK gives us. */
function preToolUseInput(toolName: string, toolInput: Record<string, unknown>) {
  return {
    hook_event_name: "PreToolUse" as const,
    tool_name: toolName,
    tool_input: toolInput,
    tool_use_id: "tu_test",
    cwd: "/x",
    session_id: "s",
    transcript_path: "/x/.claude/transcript.jsonl",
  };
}

const HOOK_OPTS = { signal: new AbortController().signal };

/** Pull the PreToolUse-shaped sub-output regardless of which union arm we got. */
function specific(out: unknown): {
  permissionDecision?: "allow" | "deny" | "ask";
  permissionDecisionReason?: string;
  updatedInput?: Record<string, unknown>;
} {
  if (!out || typeof out !== "object") return {};
  const o = out as Record<string, unknown>;
  const hs = o.hookSpecificOutput as Record<string, unknown> | undefined;
  return (hs ?? {}) as ReturnType<typeof specific>;
}

describe("makeApprover (PreToolUse hook)", () => {
  test("yolo allows everything unchanged", async () => {
    const approve = makeApprover({ yoloMode: true, cwd: "/x" });
    const out = await approve(preToolUseInput("Bash", { command: "rm -rf /" }), undefined, HOOK_OPTS);
    expect(specific(out).permissionDecision).toBe("allow");
    expect(specific(out).updatedInput).toBeUndefined();
  });

  test("non-yolo Bash gets wrapped on linux+bwrap", async () => {
    const approve = makeApprover({
      yoloMode: false, cwd: "/x", platform: "linux",
      hasBin: (p) => p === "/usr/bin/bwrap",
    });
    const out = await approve(preToolUseInput("Bash", { command: "ls" }), undefined, HOOK_OPTS);
    expect(specific(out).permissionDecision).toBe("allow");
    expect(String(specific(out).updatedInput?.command)).toContain("bwrap");
  });

  test("non-yolo Bash blocked by denylist", async () => {
    const approve = makeApprover({
      yoloMode: false, cwd: "/x", platform: "linux",
      hasBin: () => true,
    });
    const out = await approve(preToolUseInput("Bash", { command: "sudo halt" }), undefined, HOOK_OPTS);
    expect(specific(out).permissionDecision).toBe("deny");
    expect(specific(out).permissionDecisionReason).toMatch(/sudo/);
  });

  test("non-bash tools allowed unchanged", async () => {
    const approve = makeApprover({
      yoloMode: false, cwd: "/x", platform: "linux", hasBin: () => true,
    });
    const out = await approve(preToolUseInput("Read", { file_path: "/x/foo" }), undefined, HOOK_OPTS);
    expect(specific(out).permissionDecision).toBe("allow");
    expect(specific(out).updatedInput).toBeUndefined();
  });

  test("edit tools allowed unchanged — cwd already scopes them", async () => {
    const approve = makeApprover({
      yoloMode: false, cwd: "/x", platform: "darwin",
    });
    for (const tool of ["Edit", "Write", "NotebookEdit", "MultiEdit"]) {
      const out = await approve(
        preToolUseInput(tool, { file_path: "/x/f", content: "c" }),
        undefined, HOOK_OPTS,
      );
      expect(specific(out).permissionDecision).toBe("allow");
      expect(specific(out).updatedInput).toBeUndefined();
    }
  });

  test("missing bwrap on linux denies with explanation", async () => {
    const approve = makeApprover({
      yoloMode: false, cwd: "/x", platform: "linux", hasBin: () => false,
    });
    const out = await approve(preToolUseInput("Bash", { command: "ls" }), undefined, HOOK_OPTS);
    expect(specific(out).permissionDecision).toBe("deny");
    expect(specific(out).permissionDecisionReason).toMatch(/bwrap/);
  });

  test("Bash with shell operators / heredocs is allowed (wrapped) — the CLI's own pre-check is bypassed by the hook", async () => {
    const approve = makeApprover({
      yoloMode: false, cwd: "/x", platform: "darwin",
    });
    const out = await approve(
      preToolUseInput("Bash", { command: "cat <<'EOF' > package.json\n{}\nEOF" }),
      undefined, HOOK_OPTS,
    );
    expect(specific(out).permissionDecision).toBe("allow");
    expect(String(specific(out).updatedInput?.command)).toContain("sandbox-exec");
  });

  test("non-PreToolUse events pass through without a decision", async () => {
    const approve = makeApprover({ yoloMode: false, cwd: "/x", platform: "darwin" });
    const out = await approve(
      // @ts-expect-error — synthetic PostToolUse-shaped input for the test
      { hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: {}, tool_use_id: "x" },
      undefined, HOOK_OPTS,
    );
    expect(specific(out).permissionDecision).toBeUndefined();
  });
});
