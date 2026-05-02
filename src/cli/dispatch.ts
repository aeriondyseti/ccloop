import { runInit } from "./init.ts";
import { runRun } from "./run.ts";
import { runDesign } from "./design.ts";
import { HELP_TEXT } from "./help.ts";
import { runDebugCommand } from "./debug.ts";
import { IS_DEV_BUILD, VERSION } from "../build-info.ts";
import { validateSpec } from "../config/spec.ts";

export { VERSION };

/** Strip `--debug` from anywhere in argv. Returns the cleaned argv
 *  and whether the flag was present. The flag is dev-build-only;
 *  passing it on a production install is a hard error so users get
 *  a clear "this isn't shipped" rather than silent acceptance. */
function consumeDebugFlag(argv: string[]): { argv: string[]; debug: boolean } {
  const debug = argv.includes("--debug");
  return { argv: argv.filter((a) => a !== "--debug"), debug };
}

export type Route =
  | { kind: "help" }
  | { kind: "version" }
  | { kind: "init"; rest: string[] }
  | { kind: "run"; rest: string[] }
  | { kind: "design"; rest: string[] }
  | { kind: "debug"; cmd: string; rest: string[] }
  | { kind: "auto"; rest: string[] }
  | { kind: "unknown"; first: string };

/** Pure routing: argv (after --debug strip) → which action to take.
 *  `auto` means no subcommand was given and the caller must consult
 *  filesystem state to pick build vs design. */
export function route(argv: string[]): Route {
  const [first, ...rest] = argv;
  if (first === undefined) return { kind: "auto", rest: [] };
  if (first === "--help" || first === "-h" || first === "help") return { kind: "help" };
  if (first === "--version" || first === "-V") return { kind: "version" };
  if (first === "init") return { kind: "init", rest };
  if (first === "run" || first === "build") return { kind: "run", rest };
  if (first === "design") return { kind: "design", rest };
  if (first.startsWith("debug:")) return { kind: "debug", cmd: first.slice("debug:".length), rest };
  // Bare flags-only invocations (e.g. `ccloop --yolo`) auto-route too.
  if (first.startsWith("-")) return { kind: "auto", rest: argv };
  return { kind: "unknown", first };
}

/** Decide which loop a bare `ccloop` invocation should run. */
export async function pickAutoLoop(cwd: string): Promise<"build" | "design"> {
  const spec = await validateSpec(cwd);
  return spec.ok ? "build" : "design";
}

export async function run(argv: string[]): Promise<number> {
  const consumed = consumeDebugFlag(argv);
  if (consumed.debug) {
    if (!IS_DEV_BUILD) {
      process.stderr.write(
        "ccloop: --debug is only available on dev builds.\n",
      );
      return 1;
    }
    process.env.CCLOOP_DEBUG = "1";
    process.env.CCLOOP_TUI_DEBUG ??= "1";
    process.env.CCLOOP_SDK_DEBUG ??= "1";
  }

  const r = route(consumed.argv);
  switch (r.kind) {
    case "help": {
      process.stdout.write(HELP_TEXT);
      if (IS_DEV_BUILD) {
        process.stdout.write(
          "\nDev-build extras:\n" +
          "  --debug              enable debug mode for this invocation\n" +
          "  debug:<cmd>          dev-only subcommands (try `debug:info`)\n",
        );
      }
      return 0;
    }
    case "version": {
      process.stdout.write(`ccloop ${VERSION}${IS_DEV_BUILD ? " (dev)" : ""}\n`);
      return 0;
    }
    case "init":
      return await runInit(r.rest);
    case "run":
      return await runRun(r.rest);
    case "design":
      return await runDesign(r.rest);
    case "debug": {
      if (!IS_DEV_BUILD) {
        process.stderr.write(
          `ccloop: 'debug:${r.cmd}' is a dev-only subcommand.\n`,
        );
        return 1;
      }
      return await runDebugCommand(r.cmd, r.rest);
    }
    case "auto": {
      const pick = await pickAutoLoop(process.cwd());
      return pick === "build"
        ? await runRun(r.rest)
        : await runDesign(r.rest);
    }
    case "unknown": {
      process.stderr.write(`ccloop: unknown subcommand '${r.first}'\n`);
      process.stderr.write(HELP_TEXT);
      return 1;
    }
  }
}
