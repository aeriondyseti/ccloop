# ccloop Roadmap

Post-MVP ideas. Nothing here is committed; this is a parking lot for things
deliberately scoped out of the initial build.

## Fast-Follow (next after MVP)

- **Revisit progress source: SPEC checklist vs. Claude's TODO.**
  Once the MVP has been used on a couple real projects, decide whether
  to drop the mandatory SPEC.md checklist and source the dashboard's
  progress panel from Claude's live `TodoWrite` state instead. Open
  questions: does TodoWrite state survive fresh-session boundaries?
  Is the live operational view more useful than the static
  user-authored one, or are both worth showing? Decide empirically.

- **Context management.** Smarter handling of what Claude sees per
  iteration: PROGRESS.md compaction / summarization, selective
  inclusion of prior iteration records, repo-digest refresh strategy,
  budget-aware context trimming. MVP keeps this naive (full
  PROGRESS.md, full SPEC.md, every iteration); this item upgrades it.

- **Project planning system.** A separate mode (or sibling tool) that
  authors / refines `SPEC.md` itself — interactive spec elicitation,
  checklist generation from a high-level goal, decomposition of large
  goals into shippable milestones. ccloop-the-loop stays narrowly an
  executor; the planner is its upstream. Decision pending on whether
  this ships as `ccloop plan` or as a distinct binary.

## Post-MVP

- **First-class API-key auth path.** MVP supports
  `ANTHROPIC_API_KEY` as a fallback but optimizes for the
  `CLAUDE_CODE_OAUTH_TOKEN` (Claude Code subscription) path. If the
  ecosystem shifts back toward direct API billing, surface API-key
  auth as a peer (cost dashboards, budget guardrails calibrated to
  per-token pricing, etc.).

- **Monetary budget guardrails.** Re-introduce `max_budget_usd`
  (run-level) and `max_budget_per_step_usd` (per-step / SDK
  `maxBudgetUsd`). Off in MVP because the optimized auth path is
  flat-rate subscription, where dollar caps don't model what the
  user actually cares about. Belongs back in once API-key auth is
  first-class, or as an opt-in for users who want spend signals
  even on subscription.

- **Move off the undocumented `/api/oauth/usage` endpoint.** If
  Anthropic publishes a stable usage API, switch to it. If they
  remove this one, fall back to ccusage's JSONL parsing. Track
  upstream changes.

- **Container-sandboxed runs.** Investigate spinning up a Linux VM
  (Lima / Colima / Docker) preinstalled with ccloop and the project's
  toolchain, copying or initializing the project inside, and running
  the whole loop in there. Replaces per-Bash sandboxing
  (bwrap / sandbox-exec) with a single hard isolation boundary at
  ccloop-instance level. Open questions: cold-start cost, how the
  user inspects/interacts with the running container, how artifacts
  come back out (commit + git push? bind mount?), how we handle
  authenticated tools (Anthropic OAuth, gh, npm credentials) safely
  inside the box.

- **Daemon mode.** Detach from the terminal, survive shell close,
  manage via `ccloop status` / `ccloop attach` / `ccloop stop`
  subcommands. MVP runs foreground only.
- **Remote mode.** Run ccloop on a server / VM / container with a
  remotely accessible status surface (web dashboard or SSH-friendly
  status command). MVP runs locally only.
- **`gh` CLI integration.** On `ccloop init` (or via a flag / config field),
  optionally create a GitHub remote via `gh repo create`, set the upstream,
  and push the initial commit. Needs design around auth assumptions
  (`gh auth status`), naming (derive from CWD?), and visibility
  (public vs. private default).

- **Expanded DONE screen with step-by-step transcript review.** Today
  the DONE screen shows the final commit SHA and rolling stats. Make
  it the entrypoint for a richer post-mortem: navigate step-by-step
  through the run, with each step exposing its full Now-pane
  transcript (assistant prose, tool uses, tool results), commit
  subject + diff, duration / cost / cache stats, and any failures or
  retries. Open questions: source of truth — accumulate from
  `stream_chunk` events into per-step transcript files
  (`.ccloop/steps/NNNN.transcript.md`) at end-of-step, vs. read the
  SDK's `~/.claude/projects/<proj>/<sid>.jsonl` lazily; navigation
  model — keys (←/→, j/k?), or a step picker; interaction with
  ESCALATED's revert flow (probably share the step picker UI).

- **First-class brownfield SPEC implementation.** MVP is greenfield-
  shaped: `ccloop init` assumes an empty (or near-empty) tree, the
  matrix refuses non-greenfield starts unless `--continue` is set,
  the prompt template implicitly tells Claude it's scaffolding from
  scratch, and DONE detection is "ship it once the checklist is
  done" rather than "ship the focused change." Brownfield support
  needs: (1) a startup matrix that accepts a populated repo without
  treating it as dirty-tree recovery, (2) a prompt template variant
  that orients Claude inside an existing codebase (pointers to
  CLAUDE.md / READMEs / module layout, ground rules about not
  rewriting unrelated code), (3) SPEC conventions for change-shaped
  work (acceptance criteria + test plan, not just checklist
  scaffolding), (4) likely a separate "review-mode" iteration shape
  where the loop converges on a passing test/lint signal rather than
  a `DONE.md` sentinel. Decide whether this is a config flag
  (`[run].mode = "brownfield"`) or implicit from project state.
