/**
 * Permission gate per §6.4 / §6.5, implemented as a `PreToolUse` hook.
 *
 * The Claude Code CLI applies its own pre-checks (Bash command-prefix
 * allowlist, shell-operator denial, file-write permission gate) and
 * those run *before* `canUseTool` would. PreToolUse hooks run *before*
 * those pre-checks and can short-circuit them by returning an
 * explicit `permissionDecision`. So the hook is the only place we can
 * actually intercept things like `bun init`, heredocs, and writes to
 * `package.json` without the CLI rejecting them first.
 *
 * Behavior:
 * - yolo_mode true: every tool call is approved unchanged.
 * - yolo_mode false:
 *   - Bash invocations are denylist-checked (catastrophic patterns
 *     like `rm -rf /`, `sudo`, fork bombs); on match the hook returns
 *     `deny` with a human-readable reason so Claude can course-correct.
 *   - Bash invocations are otherwise approved with `updatedInput.command`
 *     rewritten to wrap the original command via `bwrap` (Linux) or
 *     `sandbox-exec` (macOS), scoped to allow only CWD writes/reads.
 *   - All other tools (including Edit / Write / NotebookEdit /
 *     MultiEdit) are approved unchanged. The SDK's `cwd` parameter
 *     already scopes file edits to the project root.
 */
import type {
  HookCallback,
  HookJSONOutput,
} from "@anthropic-ai/claude-agent-sdk";
import { type Platform, detectPlatform, wrapBash } from "./wrap.ts";
import { checkDenylist } from "./denylist.ts";

export interface ApproverOptions {
  yoloMode: boolean;
  cwd: string;
  platform?: Platform;
  /** Test seam */
  hasBin?: (p: string) => boolean;
}

const FILE_EDIT_TOOLS = new Set([
  "Edit", "Write", "MultiEdit", "NotebookEdit",
]);

/** Build a PreToolUse hook callback configured with the given options. */
export function makeApprover(opts: ApproverOptions): HookCallback {
  const platform = opts.platform ?? detectPlatform();

  return async function preToolUse(input): Promise<HookJSONOutput> {
    if (input.hook_event_name !== "PreToolUse") {
      return passthrough();
    }

    const toolName = input.tool_name;
    const toolInput = (input.tool_input ?? {}) as Record<string, unknown>;

    if (opts.yoloMode) {
      return allow();
    }

    if (toolName === "Bash") {
      const command = typeof toolInput.command === "string" ? toolInput.command : "";
      if (!command) return allow();

      const deny = checkDenylist(command);
      if (deny) return denyWith(deny.reason);

      const wrap = wrapBash({
        command, cwd: opts.cwd, platform, hasBin: opts.hasBin,
      });
      if (wrap.kind === "unavailable") return denyWith(wrap.reason);
      if (wrap.kind === "wrap") {
        return allow({ ...toolInput, command: wrap.command });
      }
      // passthrough — non-Linux/macOS host; no sandbox wrap available.
      return allow();
    }

    if (FILE_EDIT_TOOLS.has(toolName)) {
      // SDK `cwd` already scopes file edits to the project root. We
      // explicitly approve so the CLI's built-in file-write gate
      // doesn't reject paths it lacks an allow rule for.
      return allow();
    }

    // Read / Glob / Grep / WebFetch / etc — auto-approve.
    return allow();
  };
}

function allow(updatedInput?: Record<string, unknown>): HookJSONOutput {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      ...(updatedInput ? { updatedInput } : {}),
    },
  };
}

function denyWith(reason: string): HookJSONOutput {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  };
}

/** No-op output for hook events we don't care about. */
function passthrough(): HookJSONOutput {
  return { continue: true };
}
