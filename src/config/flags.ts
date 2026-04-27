export interface RunFlags {
  cont: boolean;
  yes: boolean;
  maxSteps?: number;
  maxWallClock?: string;
  cadence?: number;
  yolo?: boolean;
  promptPath?: string;
  logLevel?: string;
  noColor?: boolean;
}

export class FlagError extends Error {}

function takeValue(name: string, argv: string[], i: number): string {
  const v = argv[i + 1];
  if (v === undefined || v.startsWith("--")) {
    throw new FlagError(`flag ${name} requires a value`);
  }
  return v;
}

function parseInt10(name: string, raw: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    throw new FlagError(`flag ${name} expects an integer, got '${raw}'`);
  }
  return n;
}

export function parseRunFlags(argv: string[]): RunFlags {
  const flags: RunFlags = { cont: false, yes: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    switch (a) {
      case "--continue":
        flags.cont = true;
        break;
      case "-y":
      case "--yes":
        flags.yes = true;
        break;
      case "--yolo":
        flags.yolo = true;
        break;
      case "--no-color":
        flags.noColor = true;
        break;
      case "--max-steps":
        flags.maxSteps = parseInt10(a, takeValue(a, argv, i++));
        break;
      case "--max-wall-clock":
        flags.maxWallClock = takeValue(a, argv, i++);
        break;
      case "--cadence":
        flags.cadence = parseInt10(a, takeValue(a, argv, i++));
        break;
      case "--prompt":
        flags.promptPath = takeValue(a, argv, i++);
        break;
      case "--log-level":
        flags.logLevel = takeValue(a, argv, i++);
        break;
      default:
        throw new FlagError(`unknown flag '${a}'`);
    }
  }
  return flags;
}
