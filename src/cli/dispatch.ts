import { runInit } from "./init.ts";
import { runRun } from "./run.ts";
import { HELP_TEXT } from "./help.ts";
import { runDebugCommand } from "./debug.ts";
import { IS_DEV_BUILD, VERSION } from "../build-info.ts";

export { VERSION };

/** Strip `--debug` from anywhere in argv. Returns the cleaned argv
 *  and whether the flag was present. The flag is dev-build-only;
 *  passing it on a production install is a hard error so users get
 *  a clear "this isn't shipped" rather than silent acceptance. */
function consumeDebugFlag(argv: string[]): { argv: string[]; debug: boolean } {
  const debug = argv.includes("--debug");
  return { argv: argv.filter((a) => a !== "--debug"), debug };
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
    // The TUI keystroke logger uses its own env var so it can be
    // toggled independently; --debug turns it on by default.
    process.env.CCLOOP_TUI_DEBUG ??= "1";
  }

  const [first, ...rest] = consumed.argv;

  if (first === undefined || first === "--help" || first === "-h" || first === "help") {
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
  if (first === "--version" || first === "-V") {
    process.stdout.write(`ccloop ${VERSION}${IS_DEV_BUILD ? " (dev)" : ""}\n`);
    return 0;
  }
  if (first === "init") {
    return await runInit(rest);
  }
  if (first === "run") {
    return await runRun(rest);
  }
  if (first.startsWith("debug:")) {
    if (!IS_DEV_BUILD) {
      process.stderr.write(
        `ccloop: '${first}' is a dev-only subcommand.\n`,
      );
      return 1;
    }
    return await runDebugCommand(first.slice("debug:".length), rest);
  }

  process.stderr.write(`ccloop: unknown subcommand '${first}'\n`);
  process.stderr.write(HELP_TEXT);
  return 1;
}
