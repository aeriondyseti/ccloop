/**
 * canUseTool approver per §6.4 / §6.5.
 *
 * - yolo_mode true: allow everything unconditionally.
 * - yolo_mode false:
 *   - File-edit tools (Edit, Write, NotebookEdit, MultiEdit) flow
 *     through the SDK's `acceptEdits` permission mode and are not
 *     re-approved here.
 *   - Bash invocations are denylist-checked, then rewritten via
 *     `wrapBash` to prepend the OS sandbox; the rewritten command is
 *     returned in `updatedInput`.
 *   - Other tools are auto-allowed unchanged.
 */
import { type Platform, detectPlatform, wrapBash } from "./wrap.ts";
import { checkDenylist } from "./denylist.ts";

export type ApproverResult =
  | { behavior: "allow"; updatedInput: Record<string, unknown> }
  | { behavior: "deny"; message: string };

export interface ApproverOptions {
  yoloMode: boolean;
  cwd: string;
  platform?: Platform;
  /** Test seam */
  hasBin?: (p: string) => boolean;
}

export function makeApprover(opts: ApproverOptions) {
  const platform = opts.platform ?? detectPlatform();

  return async function canUseTool(
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<ApproverResult> {
    if (opts.yoloMode) {
      return { behavior: "allow", updatedInput: input };
    }

    if (toolName === "Bash") {
      const command = typeof input.command === "string" ? input.command : "";
      if (command) {
        const deny = checkDenylist(command);
        if (deny) {
          return { behavior: "deny", message: deny.reason };
        }
        const wrap = wrapBash({ command, cwd: opts.cwd, platform, hasBin: opts.hasBin });
        if (wrap.kind === "unavailable") {
          return { behavior: "deny", message: wrap.reason };
        }
        if (wrap.kind === "wrap") {
          return {
            behavior: "allow",
            updatedInput: { ...input, command: wrap.command },
          };
        }
        // passthrough — non-Linux/macOS
        return { behavior: "allow", updatedInput: input };
      }
    }

    return { behavior: "allow", updatedInput: input };
  };
}
