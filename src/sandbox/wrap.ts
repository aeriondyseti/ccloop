/**
 * Compose a sandboxed Bash invocation per §6.5. We don't actually exec
 * here — we transform a `Bash` tool input into one the underlying
 * Bash tool can run, by prefixing the command with `bwrap` (Linux) or
 * `sandbox-exec` (macOS) configured to allow only CWD reads/writes.
 *
 * The MVP shape is intentionally narrow: the agent's own Bash tool
 * runs the command, but with the wrapper prefix in front. If the
 * sandbox binary is missing, we surface that via `unavailable`.
 */
import { existsSync } from "node:fs";

export type Platform = "linux" | "darwin" | "other";

export interface WrapInput {
  command: string;
  cwd: string;
  platform: Platform;
  /** Test seam — defaults to filesystem existence check. */
  hasBin?: (path: string) => boolean;
}

export type WrapResult =
  | { kind: "wrap"; command: string }
  | { kind: "passthrough" }
  | { kind: "unavailable"; reason: string };

const BWRAP_PATHS = ["/usr/bin/bwrap", "/bin/bwrap", "/usr/local/bin/bwrap"];

export function wrapBash(input: WrapInput): WrapResult {
  const has = input.hasBin ?? existsSync;
  if (input.platform === "linux") {
    const bwrap = BWRAP_PATHS.find(has);
    if (!bwrap) {
      return {
        kind: "unavailable",
        reason: "bwrap not found; install bubblewrap or set yolo_mode = true",
      };
    }
    return { kind: "wrap", command: bwrapCommand(bwrap, input.cwd, input.command) };
  }
  if (input.platform === "darwin") {
    return { kind: "wrap", command: sandboxExecCommand(input.cwd, input.command) };
  }
  return { kind: "passthrough" };
}

/** bwrap invocation: ro-bind the whole rootfs, then layer writable
 *  surfaces on top (tmpfs `/tmp`, RW CWD, fresh `/proc` and `/dev`).
 *  This mirrors the macOS profile's `(allow default) (deny file-write*)`
 *  shape: reads are unrestricted (so user toolchains under `$HOME`
 *  like mise/asdf/nvm/~.bun/~.cargo resolve), writes are scoped to
 *  CWD and `/tmp`. Network is allowed so `bun install`, `npm install`,
 *  etc. work — the boundary is filesystem scope, not exfiltration. */
export function bwrapCommand(bwrapBin: string, cwd: string, command: string): string {
  const args = [
    bwrapBin,
    "--ro-bind", "/", "/",
    "--proc", "/proc",
    "--dev", "/dev",
    "--tmpfs", "/tmp",
    "--bind", quote(cwd), quote(cwd),
    "--chdir", quote(cwd),
    "--die-with-parent",
    "--",
    "/bin/sh", "-c", quote(command),
  ];
  return args.join(" ");
}

/** sandbox-exec profile: deny all writes outside CWD. */
export function sandboxExecCommand(cwd: string, command: string): string {
  const profile = `(version 1)
(allow default)
(deny file-write*)
(allow file-write*
  (subpath ${doubleQuote(cwd)})
  (subpath "/private/tmp")
  (subpath "/tmp")
  (subpath "/dev"))`;
  return `sandbox-exec -p ${quote(profile)} /bin/sh -c ${quote(command)}`;
}

function quote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function doubleQuote(s: string): string {
  return `"${s.replace(/"/g, `\\"`)}"`;
}

export function detectPlatform(p: NodeJS.Platform = process.platform): Platform {
  if (p === "linux") return "linux";
  if (p === "darwin") return "darwin";
  return "other";
}
