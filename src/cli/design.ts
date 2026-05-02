/**
 * `ccloop design` entry point.
 *
 * Stub: full orchestrator lands in src/design/orchestrator.ts. This file
 * remains the CLI-shaped wrapper that parses argv, prints the banner, and
 * delegates to the orchestrator. For now it surfaces a clear "not yet
 * implemented" message so the dispatch wiring is testable end-to-end.
 */

export async function runDesign(argv: string[]): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(DESIGN_HELP);
    return 0;
  }
  process.stderr.write(
    "ccloop design: orchestrator not yet wired up.\n" +
    "Tracking: ./SPEC.md item `ccloop design subcommand`.\n",
  );
  return 1;
}

export const DESIGN_HELP = `ccloop design — interactive spec-shaping loop

Drives an agent through vision → users → scope → architecture →
milestones → acceptance, producing a validated SPEC.md ready for the
build loop.

Usage:
  ccloop design [flags]

Flags:
  --model NAME            override [design].model from ccloop.toml
  --no-tui                plain stdio fallback (no two-pane layout)
  -h, --help              this help

Output paths:
  ./.ccloop/design/spec.draft.md     in-progress draft
  ./.ccloop/design/last-session.md   summary on graceful exit
  ./SPEC.md                          written on accept + promote
`;
