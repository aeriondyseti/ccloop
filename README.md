# ccloop

A two-phase tool for driving Claude Code through a software project:

1. **`ccloop design`** — interactive brainstorming agent that walks
   you from a vague idea (or an existing codebase) to a validated
   `SPEC.md`.
2. **`ccloop build`** — drives Claude Code in a loop against that
   `SPEC.md` until every Verification Requirement is satisfied and
   `./DONE.md` lands.

Bare `ccloop` auto-routes: if `./SPEC.md` exists and validates, it
runs the build loop; otherwise it runs the design loop.

## Install

```
bun install -g ccloop
```

Requires Bun ≥ 1.1, `git`, and either `bwrap` (Linux) or
`sandbox-exec` (macOS, builtin) when running with the default
sandboxed permissions.

## Quickstart — design then build

```
mkdir my-project && cd my-project
export CLAUDE_CODE_OAUTH_TOKEN=...   # via `claude setup-token`
ccloop design                        # two-pane TUI: chat + live draft
# … walk through vision → users → scope → architecture →
# … milestones → acceptance, then type /accept when ready.
# This writes ./SPEC.md.
ccloop build                         # drive the build loop
```

Or, if you already know what you're building:

```
ccloop init                # scaffolds SPEC.md + ccloop.toml
$EDITOR SPEC.md            # fill in the spec + Verification Requirements
ccloop build               # foreground loop with TUI dashboard
```

`ccloop build` is an alias for the original `ccloop run`. Press
`Ctrl-C` to stop. `ccloop build --continue` resumes from
`./.ccloop/state.json` after a kill or reboot.

`ccloop design` keyboard:

- **Tab / Shift-Tab** — switch focus between the transcript and the
  live draft pane.
- **Enter** — submit your typed input or selection.
- **Type freely** — between agent turns, your text becomes the next
  prompt.
- **`/accept`** — validate the draft, confirm, promote to
  `./SPEC.md`, and offer to launch `ccloop build`.
- **`/abort`** — exit without promoting.
- **Ctrl-C once** — graceful shutdown: the agent writes a session
  summary to `./.ccloop/design/last-session.md` so you can resume
  later. Ctrl-C twice within 2s force-quits.

Re-running `ccloop design` after Ctrl-C reuses the existing
`./.ccloop/design/spec.draft.md` as a starting point. The
conversation history isn't restored — each invocation is a fresh
agent session — but the draft on disk is the source of truth.

Once `DONE.md` exists at the project root, ccloop exits with status
0; the `./.ccloop/` directory is safe to delete after a successful
run.

## How the build loop works

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

## How the design loop works

- One in-process Anthropic Agent SDK session opened with a
  design-specific system prompt (vision → users → scope →
  architecture → milestones → acceptance) plus the current draft as
  context.
- A built-in MCP tool, `ask_user`, suspends the agent and renders an
  interactive multiple-choice widget in the TUI; users can press
  Esc to provide freeform input instead.
- Tool sandboxing is reused from the build loop:
  `Read` / `Grep` / `Glob` / `WebSearch` / `WebFetch` are
  unrestricted; `Edit` / `Write` are scoped to `./.ccloop/design/`
  only; `Bash` runs through the same `bwrap` / `sandbox-exec` wrap.
- Lifecycle events are appended to the same `./.ccloop/events.jsonl`
  the build loop writes to, so a single tail covers both phases.

Sibling artifacts the design agent may produce — `ROADMAP.md`,
`IDEAS.md`, `TECH-DEBT.md` — are promoted alongside `SPEC.md` on
`/accept` if they exist.

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
