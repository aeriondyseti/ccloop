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

Pre-1.0. The bones are in: config layer, state layer, SDK wrapper,
sandbox glue, usage-endpoint client, loop driver / orchestrator /
guardrails / escalation, ink-based TUI, and the `init` / `run` /
`run --continue` subcommands. `bun test` runs 180+ tests green;
`tsc --noEmit` is clean.

What hasn't been validated end-to-end yet is the only thing that
matters: **driving a real Claude Code session in a loop against a
real target spec until `DONE.md` lands.** Until that's done, every
piece below is theoretically wired but empirically unproven.

### Remaining for 1.0

1. **First real self-run** against a small target spec, confirming
   the loop drives steps, commits per step, polls `/api/oauth/usage`,
   and exits clean on `DONE.md`.
2. **Close out the §14 Known Unknowns** in `.claude/SPEC.md` from
   the data captured during that run.
3. **TUI dogfood pass** — render the four non-RUNNING states on
   80×24, fix layout drift, verify escalation hotkeys in a real
   terminal.
4. **Sandbox empirical check** — confirm `bwrap` / denylist actually
   block what they're supposed to under a live Claude Code session.
5. **`ccloop init` polish** — scaffolded project must be runnable
   with no manual edits beyond filling in the spec body.
6. **npm Trusted Publisher setup** on npmjs.com, plus creating the
   `dev` branch and protecting `main`. (CI workflow itself is done;
   see `.github/workflows/ci.yml`.)
7. **README quickstart re-verification** — copy-paste-runnable
   against the post-self-run binary.

Step-by-step instructions for executing all of these — including
prerequisites for a fresh machine — are in
[`RELEASE-CHECKLIST.md`](./RELEASE-CHECKLIST.md).

`ROADMAP.md` parks everything deliberately scoped out of 1.0
(planning system, container sandboxing, daemon mode, remote mode,
`gh` integration, monetary budget guardrails, etc.).
