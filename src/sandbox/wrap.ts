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

/** bwrap invocation: read-only / for system, RW for CWD, no net. */
export function bwrapCommand(bwrapBin: string, cwd: string, command: string): string {
  const args = [
    bwrapBin,
    "--ro-bind", "/usr", "/usr",
    "--ro-bind", "/lib", "/lib",
    "--ro-bind-try", "/lib64", "/lib64",
    "--ro-bind-try", "/bin", "/bin",
    "--ro-bind-try", "/sbin", "/sbin",
    "--ro-bind-try", "/etc", "/etc",
    "--proc", "/proc",
    "--dev", "/dev",
    "--tmpfs", "/tmp",
    "--bind", quote(cwd), quote(cwd),
    "--chdir", quote(cwd),
    "--unshare-net",
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
