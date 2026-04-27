export const HELP_TEXT = `ccloop — Claude Code loop runner

Drives a Claude Code session in a loop against a SPEC.md until done.

Usage:
  ccloop run [flags]      start or resume a run
  ccloop init             scaffold SPEC.md and ccloop.toml
  ccloop --help           this help
  ccloop --version        print version

Common flags for \`ccloop run\`:
  --continue              resume an existing run; no prompt
  -y, --yes               auto-accept default-yes prompts
  --max-steps N           cap total steps in this run
  --max-wall-clock D      cap wall-clock; "8h", "30m", "1d 2h"
  --cadence N             seconds between step starts
  --yolo                  bypass tool permission scoping
  --prompt PATH           override prompt template
  --log-level LEVEL       debug | info | warn | error
  --no-color              disable ANSI

Authentication (one of):
  CLAUDE_CODE_OAUTH_TOKEN  long-lived; generate with: claude setup-token
  claude /login            ccloop reads keychain (macOS) or
                           ~/.claude/.credentials.json automatically
  ANTHROPIC_API_KEY        billing API key

Files (in current directory):
  SPEC.md                 required: spec to drive against
  ccloop.toml             optional: config overrides
  .ccloop/                ccloop's run state (deletable post-run)

Quick start in an empty directory:
  ccloop init             scaffolds SPEC.md and ccloop.toml
  $EDITOR SPEC.md         fill in the spec and Verification Requirements
  ccloop run              start the loop
`;
