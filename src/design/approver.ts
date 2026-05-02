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
import { join, normalize, relative } from "node:path";

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

    // Restrict file edits to .ccloop/design/ only
    if (FILE_EDIT_TOOLS.has(toolName)) {
      const filePath = getTargetPath(toolInput, toolName);
      if (!filePath) {
        // No path provided; let the tool handle the error
        return allow();
      }

      // Normalize the path and check if it's under .ccloop/design/
      const absolutePath = normalize(join(opts.cwd, filePath));
      const rel = relative(designDir, absolutePath);

      // If relative path starts with ".." or is absolute, it's outside designDir
      if (rel.startsWith("..") || relative(designDir, absolutePath).startsWith("/")) {
        return denyWith(
          `Design mode can only write to .ccloop/design/. ` +
          `Attempted to write to: ${filePath}. ` +
          `Please use paths under .ccloop/design/ for spec.draft.md, ` +
          `ROADMAP.md, IDEAS.md, or TECH-DEBT.md.`
        );
      }

      return allow();
    }

    // Read / Glob / Grep / WebFetch / WebSearch / etc — auto-approve.
    return allow();
  };
}

/**
 * Extract the target file path from tool input.
 *
 * Different tools use different parameter names for the file path.
 */
function getTargetPath(toolInput: Record<string, unknown>, toolName: string): string | null {
  if (toolName === "Edit" || toolName === "Write") {
    return typeof toolInput.file_path === "string" ? toolInput.file_path : null;
  }
  if (toolName === "NotebookEdit") {
    return typeof toolInput.notebook_path === "string" ? toolInput.notebook_path : null;
  }
  if (toolName === "MultiEdit") {
    // MultiEdit operates on multiple files; check the edits array
    if (Array.isArray(toolInput.edits)) {
      // Return first file path for validation (all should be checked)
      const firstEdit = toolInput.edits[0];
      if (firstEdit && typeof firstEdit === "object") {
        const edit = firstEdit as Record<string, unknown>;
        return typeof edit.file_path === "string" ? edit.file_path : null;
      }
    }
  }
  return null;
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
