# ccloop

Drives Claude Code in a loop against a project's `SPEC.md` until the
project is done.

ccloop watches `./DONE.md` as its terminal signal: Claude creates that
file when every Verification Requirement in the spec is satisfied, and
ccloop exits clean.

## Install

```
bun install -g ccloop
```

Requires Bun ≥ 1.1, `git`, and either `bwrap` (Linux) or
`sandbox-exec` (macOS, builtin) when running with the default
sandboxed permissions.

## Quickstart

```
mkdir my-project && cd my-project
ccloop init                # scaffolds SPEC.md and ccloop.toml
$EDITOR SPEC.md            # describe the project + Verification Requirements
export CLAUDE_CODE_OAUTH_TOKEN=...   # via `claude setup-token`
ccloop run                 # foreground loop with TUI dashboard
```

Press `Ctrl-C` to stop. `ccloop run --continue` resumes from
`./.ccloop/state.json` after a kill or reboot.

Once `DONE.md` exists at the project root, ccloop exits with status
0; the `./.ccloop/` directory is safe to delete after a successful
run.

## How it works

- Each ccloop **step** is one Anthropic Agent SDK `query` call.
  ccloop renders a prompt with the spec, the cross-step
  `progress.md` scratchpad, the previous step's error if any, and
  the step number.
- After every step, ccloop auto-commits the working tree, writes a
  step record under `./.ccloop/steps/`, appends to
  `./.ccloop/events.jsonl`, persists `./.ccloop/state.json`
  atomically, and sleeps until the next cadence tick.
- ccloop polls Anthropic's `/api/oauth/usage` endpoint to pause on
  five-hour-cap exhaustion and escalate on weekly-cap exhaustion.
- After N consecutive step failures (3 by default), ccloop escalates
  and notifies via push / webhook if configured.

See `ccloop.toml` for tuning knobs.

## Status

Pre-1.0. The core loop, state machine, sandboxing, and TUI are in
place; rough edges remain around prompt-cache observation, the
escalation key controls, and CLI inspection commands. See
`ROADMAP.md`.
