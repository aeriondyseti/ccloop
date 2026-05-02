export const HELP_TEXT = `ccloop — Claude Code loop runner

Two-phase tool: \`ccloop design\` shapes a SPEC.md, \`ccloop build\`
drives a Claude Code session in a loop against it until done.

Usage:
  ccloop                  auto-route: build if SPEC.md is valid, else design
  ccloop design [flags]   interactive spec-shaping loop
  ccloop build [flags]    start or resume a build run (alias: \`run\`)
  ccloop init             scaffold SPEC.md and ccloop.toml
  ccloop --help           this help
  ccloop --version        print version

Common flags for \`ccloop build\`:
  --continue              resume an existing run; no prompt
  -y, --yes               auto-accept default-yes prompts
  --max-steps N           cap total steps in this run
  --max-wall-clock D      cap wall-clock; "8h", "30m", "1d 2h"
  --cadence N             seconds between step starts
  --yolo                  bypass tool permission scoping
  --prompt PATH           override prompt template
  --no-color              disable ANSI colors in the dashboard

Common flags for \`ccloop design\`:
  --model NAME            override [design].model
  --no-tui                plain stdio fallback (no two-pane layout)

Authentication (one of):
  CLAUDE_CODE_OAUTH_TOKEN  long-lived; generate with: claude setup-token
  claude /login            ccloop reads keychain (macOS) or
                           ~/.claude/.credentials.json automatically
  ANTHROPIC_API_KEY        billing API key

Files (in current directory):
  SPEC.md                 build target (created by \`ccloop design\` or \`init\`)
  ccloop.toml             optional: config overrides
  .ccloop/                ccloop's runtime state (deletable post-run)

Quick start in an empty directory:
  ccloop init             scaffolds SPEC.md and ccloop.toml
  $EDITOR SPEC.md         fill in the spec and Verification Requirements
  ccloop build            start the loop

Or shape a spec interactively:
  ccloop design           walks vision → users → scope → ... → acceptance
                          and writes SPEC.md when accepted
`;
