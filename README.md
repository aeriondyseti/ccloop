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

1. **First real self-run.** Point ccloop at a small target spec
   (e.g. `templates/SPEC.md`'s Markdown-to-plaintext converter) with
   a live `CLAUDE_CODE_OAUTH_TOKEN` and confirm it drives steps,
   commits per step, polls `/api/oauth/usage`, and exits clean on
   `DONE.md`. Capture whatever breaks.
2. **Close out the §14 Known Unknowns** in `.claude/SPEC.md` from
   that run: actual prompt-cache hit rate, real
   `/api/oauth/usage` response shape under load, real
   `stop_reason` distribution per step, real
   pause-then-resume timing across the 5h window boundary.
3. **`run --continue` with a dirty tree.** Currently MVP refuses;
   §10.4 wants a recovery-commit policy so a kill mid-step doesn't
   strand the user. Decide and implement.
4. **TUI dogfood pass.** Render the four non-RUNNING states
   (PAUSED, ESCALATED, GUARDRAIL_TRIP, DONE) on an 80×24 terminal,
   compare to the spec mockups, fix layout drift. Verify the
   escalation hotkeys (`c` / `r` / `e` / `q`) work in a real
   terminal, not just unit tests.
5. **Sandbox empirical check.** Confirm `bwrap` actually denies
   out-of-CWD writes for the Bash tool on a current Linux setup;
   confirm the denylist patterns match what Claude Code emits in
   practice. macOS `sandbox-exec` deferred until someone tests it.
6. **`ccloop init` polish.** Verify the scaffolded `ccloop.toml`
   and `SPEC.md` produce a runnable project with no manual edits
   beyond filling in the spec body.
7. **CI + npm publish.** Add `.github/workflows/ci.yml` with a
   `test` job (typecheck + `bun test`) gating a `publish` job:
   `dev` → `npm publish --tag dev` (auto-versioned), `main` →
   `npm publish --tag latest` + git tag + GitHub Release. Wire
   `dev` as the integration branch per the project's branching
   flow.
8. **README usage examples that actually run.** Replace the current
   Quickstart's hand-wavy paths with copy-pasteable commands
   verified against the post-self-run binary.

`ROADMAP.md` parks everything deliberately scoped out of 1.0
(planning system, container sandboxing, daemon mode, remote mode,
`gh` integration, monetary budget guardrails, etc.).
