# Bootstrap prompt

A starting prompt for an agentic loop (ccloop itself, once a working
build exists, or another agentic harness in the meantime) tasked with
finishing ccloop.

This prompt is meant to be the per-step prompt template. Substitute
`{{spec}}`, `{{progress}}`, `{{last_error}}`, `{{step}}` per ccloop's
own conventions, or feed it as a one-shot to a manual agent.

---

## Prompt

You are building **ccloop**, a TypeScript/Bun CLI that drives Claude
Code in a loop against a target project's `SPEC.md` until the project
is done. You are working inside the ccloop repository itself.

The build contract is `.claude/SPEC.md`. **Read it before doing
anything substantive.** It pins vocabulary, the step-loop state
machine, all schemas, and behavior contracts. Do not violate them
without surfacing the change.

The agent guardrails are `.claude/CLAUDE.md`. The fast-follow / parked
items are `ROADMAP.md` (don't implement those in MVP). The sibling
ideas are in `IDEAS.md` (ignore unless directed).

# Spec (this is ccloop's own spec, not a target project's)

{{spec}}

# Progress so far

{{progress}}

{{last_error}}

# Your task this step (#{{step}})

1. Read `.claude/SPEC.md`. If you've read it before, skim §2
   (vocabulary) and the section most relevant to today's work.
2. Read `.claude/CLAUDE.md` for hard rules. The two-SPEC.md
   distinction is the most common confusion — be careful.
3. Identify the smallest, most useful next change toward MVP. Good
   first targets, in roughly this order:
   - Project scaffolding: `package.json` (Bun-native, no build),
     `tsconfig.json`, `.gitignore` (must exclude `.ccloop/` at any
     depth), `src/index.ts` entrypoint, `bun test` working.
   - Config layer: TOML parsing, schema validation per §12.1, flag
     precedence per §12.3, CLI parser for the subcommand surface
     in §12.4.
   - State layer: `state.json` reader/writer with atomic replace,
     event-log writer, lock acquisition.
   - SDK wrapper: a single-step driver that calls `query`, drains
     the iterator, returns the `ResultMessage` per §6.3. No TUI yet.
   - Loop driver: §4's contract, including the matrix in §12.4.
   - Sandbox glue: `bwrap` / `sandbox-exec` invocation per §6.5.
   - Usage endpoint client per §7.6, with 180s memory cache.
   - TUI per §11; ink-based; render the RUNNING / PAUSED / ESCALATED
     / GUARDRAIL_TRIP / DONE states from the mockups in the conversation
     history (those mockups are the implementation contract for layout).
4. Make the change. Run `bun test` and `bun run typecheck` (or
   equivalent) so you have evidence the change is good.
5. Update `./.ccloop/progress.md` with a short note about what you
   did and what you learned. Append; do not rewrite. (Note: in
   bootstrap mode, before ccloop is running itself, this file may
   not exist — create it if needed and treat it as a working log.)
6. If — and only if — every Verification Requirement is now
   satisfied, create `./DONE.md` at the project root with a brief
   paragraph for each requirement. Do not create `DONE.md`
   speculatively.

## Verification Requirements (mirrored from the spec for convenience)

The spec's authoritative version lives in `.claude/SPEC.md` →
"Goals" + the Known Unknowns punch-list (§14). Concrete
ship-readiness conditions:

1. `ccloop init` scaffolds a working starter project from `templates/`.
2. `ccloop run` executes a real loop against a simple target SPEC,
   reads `/api/oauth/usage`, drives one or more steps, auto-commits
   per step, and exits clean on `DONE.md`.
3. `ccloop run --continue` reliably resumes a killed instance from
   `state.json` without losing prior steps.
4. The TUI renders all five states (RUNNING / PAUSED / ESCALATED /
   GUARDRAIL_TRIP / DONE) without crashes on terminals down to 80×24.
5. The sandbox path (`yolo_mode: false`) refuses obviously bad Bash
   patterns and refuses out-of-CWD writes via the OS sandbox.
6. The Known Unknowns in §14 are each closed: a value picked, the
   data captured, and the spec section updated to reflect what the
   code actually does.
7. `bun test` is green. Tests cover the loop state machine, the
   config layer, and the state-file round-trip.
8. The repo's own `.ccloop/` (if any was created during a self-test)
   is not committed.

ccloop will commit your work after this step ends. Don't run
`git commit` yourself.

---

## Notes for the operator

- This prompt assumes you'll run it via Claude Code (`claude` CLI) or
  another agentic harness, since ccloop itself isn't built yet —
  this is the bootstrap.
- If you're driving manually, just paste the prompt (rendered with
  the four substitutions, or with `{{spec}}` replaced by the contents
  of `.claude/SPEC.md`) at the start of each session.
- Once ccloop has a usable build, you can switch to running ccloop on
  itself: copy this prompt into `.ccloop/prompt.md`, set
  `[prompt].template_path = ".ccloop/prompt.md"` in `ccloop.toml`,
  and let it loop.
- The first ccloop self-run is also useful as the "first real run"
  for closing out the §14 Known Unknowns.
