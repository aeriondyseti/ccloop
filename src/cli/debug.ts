/**
 * Dev-only subcommands. Reachable as `ccloop debug:<name>` only on
 * dev builds (see `build-info.ts`); the dispatcher refuses these on
 * production installs.
 *
 * Pattern: each subcommand is a small async function in COMMANDS.
 * Add new ones here. Keep them dependency-light — these run on
 * developer workstations, not in user shells, so prefer clarity
 * over robustness.
 */
import { IS_DEV_BUILD, VERSION } from "../build-info.ts";

type DebugCommand = (argv: string[]) => Promise<number> | number;

const COMMANDS: Record<string, DebugCommand> = {
  info: cmdInfo,
};

export async function runDebugCommand(
  name: string,
  argv: string[],
): Promise<number> {
  const cmd = COMMANDS[name];
  if (!cmd) {
    process.stderr.write(
      `ccloop debug: unknown command 'debug:${name}'. ` +
      `Available: ${Object.keys(COMMANDS).map((n) => `debug:${n}`).join(", ")}\n`,
    );
    return 1;
  }
  return await cmd(argv);
}

function cmdInfo(): number {
  const lines = [
    `version:       ${VERSION}`,
    `dev-build:     ${IS_DEV_BUILD}`,
    `entrypoint:    ${import.meta.url}`,
    `cwd:           ${process.cwd()}`,
    `bun:           ${process.versions.bun ?? "(not bun)"}`,
    `CCLOOP_DEBUG:     ${process.env.CCLOOP_DEBUG ?? "(unset)"}`,
    `TUI_DEBUG:        ${process.env.CCLOOP_TUI_DEBUG ?? "(unset)"}`,
    `SDK_DEBUG:        ${process.env.CCLOOP_SDK_DEBUG ?? "(unset)"}`,
  ];
  process.stdout.write(lines.join("\n") + "\n");
  return 0;
}
