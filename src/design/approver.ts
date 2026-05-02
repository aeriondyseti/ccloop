/**
 * Permission gate for design loop, implemented as a PreToolUse hook.
 *
 * Restricts file writes to .ccloop/design/ only while allowing reads
 * anywhere in CWD. Reuses the build loop's sandbox infrastructure for
 * Bash command wrapping.
 *
 * Behavior:
 * - Edit/Write/MultiEdit/NotebookEdit: Only allowed if the target path
 *   is under .ccloop/design/. Paths outside this directory are denied
 *   with a clear error message.
 * - Bash: Sandboxed using the same wrap mechanism as the build loop
 *   (bwrap/sandbox-exec). Denylist-checked for catastrophic patterns.
 * - Read/Grep/Glob: Allowed anywhere in CWD (read-only tools)
 * - WebSearch/WebFetch: Allowed (research tools)
 * - ask_user: Allowed (provided via MCP server, not a built-in tool)
 */

import type {
  HookCallback,
  HookJSONOutput,
} from "@anthropic-ai/claude-agent-sdk";
import { type Platform, detectPlatform, wrapBash } from "../sandbox/wrap.ts";
import { checkDenylist } from "../sandbox/denylist.ts";
import { join, normalize, relative, sep } from "node:path";

export interface DesignApproverOptions {
  cwd: string;
  platform?: Platform;
  /** Test seam */
  hasBin?: (p: string) => boolean;
}

const FILE_EDIT_TOOLS = new Set([
  "Edit", "Write", "MultiEdit", "NotebookEdit",
]);

/**
 * Build a PreToolUse hook callback for design mode.
 *
 * Restricts file writes to .ccloop/design/ directory.
 */
export function makeDesignApprover(opts: DesignApproverOptions): HookCallback {
  const platform = opts.platform ?? detectPlatform();
  const designDir = normalize(join(opts.cwd, ".ccloop", "design"));

  return async function preToolUse(input): Promise<HookJSONOutput> {
    if (input.hook_event_name !== "PreToolUse") {
      return passthrough();
    }

    const toolName = input.tool_name;
    const toolInput = (input.tool_input ?? {}) as Record<string, unknown>;

    // Sandbox Bash commands
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
      const paths = getTargetPaths(toolInput, toolName);
      // Empty list = no path supplied; let the tool error out itself.
      if (paths.length === 0) return allow();
      // Every path must land under designDir. MultiEdit can carry
      // many; the agent can otherwise smuggle a forbidden path past
      // the gate by putting a permitted one first.
      for (const filePath of paths) {
        const absolutePath = normalize(join(opts.cwd, filePath));
        const rel = relative(designDir, absolutePath);
        if (rel === "" || (!rel.startsWith("..") && !rel.startsWith(".." + sep))) {
          continue;
        }
        return denyWith(
          `Design mode can only write to .ccloop/design/. ` +
          `Attempted to write to: ${filePath}. ` +
          `Please use paths under .ccloop/design/ for spec.draft.md, ` +
          `ROADMAP.md, IDEAS.md, or TECH-DEBT.md.`,
        );
      }
      return allow();
    }

    // Read / Glob / Grep / WebFetch / WebSearch / etc — auto-approve.
    return allow();
  };
}

/** Every file path the tool wants to touch. MultiEdit can name many;
 *  the gate must check all of them. Returns [] if no path is parseable
 *  so the caller falls through to letting the tool itself handle the
 *  malformed input. */
function getTargetPaths(toolInput: Record<string, unknown>, toolName: string): string[] {
  if (toolName === "Edit" || toolName === "Write") {
    return typeof toolInput.file_path === "string" ? [toolInput.file_path] : [];
  }
  if (toolName === "NotebookEdit") {
    return typeof toolInput.notebook_path === "string" ? [toolInput.notebook_path] : [];
  }
  if (toolName === "MultiEdit") {
    if (!Array.isArray(toolInput.edits)) return [];
    const out: string[] = [];
    for (const edit of toolInput.edits) {
      if (edit && typeof edit === "object") {
        const fp = (edit as Record<string, unknown>).file_path;
        if (typeof fp === "string") out.push(fp);
      }
    }
    // Also check `file_path` on the input itself if MultiEdit carries
    // it at the top level (some SDK shapes do).
    if (typeof toolInput.file_path === "string") out.push(toolInput.file_path);
    return out;
  }
  return [];
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
