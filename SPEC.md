# SPEC

> Build target: the **design loop** — a sibling to ccloop's existing
> build loop. The design loop is an interactive brainstorming agent
> that takes a partially-formed idea (or an empty repo, or an
> existing codebase) and produces a validated `SPEC.md` ready for
> the build loop to consume. ccloop becomes a two-phase tool:
> `ccloop design` shapes the spec, `ccloop build` executes it.

## Vocabulary

Pinned terms used by this spec:

- **Design session** — one invocation of `ccloop design`. Interactive,
  human-in-the-loop. Not a "run" (the build loop's term).
- **Phase** — a stage in the design conversation: vision → users →
  scope → architecture → milestones → acceptance. Linear in MVP.
- **Draft** — the in-progress spec at `./.ccloop/design/spec.draft.md`.
- **Promote** — copy the draft to `./SPEC.md` after user accept and
  successful `validateSpec`.
- **`ask_user`** — a custom MCP tool the design agent calls to ask
  the user a structured multiple-choice question. ccloop's host
  process intercepts it and renders the prompt in the TUI.

## Scope

- [x] **Shared TUI components.** Extract reusable Ink components from
      the existing build-loop TUI: header (state · cost · tokens ·
      cwd), cost/cache strip, sandbox indicator, focusable-pane
      primitives. Move to `src/tui/shared/`. Build loop continues to
      work unchanged after extraction.
- [x] **`ask_user` MCP tool.** Implement an in-process MCP server
      exposing one tool, `ask_user`, with input schema `{ question,
      options: [{label, description}], multi_select?: boolean }`.
      Tool invocation suspends the agent, renders an interactive
      multiple-choice widget in the TUI (arrow keys + Enter; Esc to
      provide freeform input), returns the user's selection(s) as
      the tool result.
- [x] **`ccloop design` subcommand.** New verb in the CLI. Starts a
      design session: loads or creates `./.ccloop/design/spec.draft.md`
      seeded from `templates/SPEC.md`, opens a single SDK `query`
      session with the design system prompt, runs until user accepts
      or aborts.
- [x] **Sandboxed agent tools.** The design agent gets:
      `Read`/`Grep`/`Glob` (read-only, anywhere in CWD),
      `Edit`/`Write` (path-restricted to `./.ccloop/design/` only —
      reuse the build-loop's permission hook),
      `Bash` (sandboxed via the same bind-mount mechanism the build
      loop uses; read-only commands suffice but enforcement is by
      sandbox, not allowlist),
      `WebSearch`/`WebFetch`,
      and the `ask_user` MCP tool.
- [x] **Two-pane TUI layout.** Left pane: chat transcript (assistant
      prose, tool-use summaries, user replies, `ask_user` widget when
      active). Right pane: live render of `spec.draft.md`,
      auto-scrolling to the most recently edited region. Header strip
      across the top reuses shared components and shows usage / cost
      / cache hit rate. Both panes focusable (Tab cycles), scrollable.
- [x] **Linear phase scaffolding.** System prompt + per-phase prompt
      fragments walk the agent through vision → users → scope →
      architecture → milestones → acceptance. The agent is told to
      complete each phase before advancing. No phase-hopping in MVP.
- [x] **Sibling artifacts.** Beyond `spec.draft.md`, the agent may
      also write `./.ccloop/design/ROADMAP.md` (explicit non-goals /
      future scope), `./.ccloop/design/IDEAS.md` (parking-lot ideas),
      and `./.ccloop/design/TECH-DEBT.md` (intentional shortcuts /
      known gaps baked into the design). All three are optional;
      promotion copies whichever exist alongside `SPEC.md` to the
      repo root.
- [x] **Acceptance + validation gate.** When the user signals accept
      (slash command `/accept` or via an `ask_user`-driven prompt),
      ccloop runs the existing checklist parser / `validateSpec` on
      the draft. If it fails, surface the errors in the TUI and stay
      in the loop. If it passes, prompt the user one more time
      ("promote draft to ./SPEC.md?"); on confirm, copy draft +
      sibling artifacts, then offer to launch `ccloop build`.
- [x] **Resume model.** On re-invocation, if `./.ccloop/design/spec.draft.md`
      exists, load it as the starting state. Conversation history is
      **not** restored — each invocation is a fresh SDK session.
      Agent system prompt includes the current draft as context.
- [x] **Graceful shutdown.** Single Ctrl+C: send a final agent turn
      asking it to summarize the conversation into
      `./.ccloop/design/last-session.md` (decisions made, open
      questions, where the conversation left off), then exit cleanly.
      Second Ctrl+C within 2 seconds: hard-kill, draft preserved
      as-is, no summary written.
- [x] **Bare `ccloop` auto-routing.** When invoked with no
      subcommand: if `./SPEC.md` exists and passes `validateSpec`,
      run the build loop; otherwise, run the design loop. Explicit
      `ccloop design` and `ccloop build` always honor the verb
      regardless of state.
- [x] **Configuration.** `ccloop.toml` gains a `[design]` section.
      MVP keys: `model` (defaults to Claude Opus, independently
      configurable from `[build].model`), `max_turns` (per `query`
      call; default generous since this is interactive). CLI flags:
      `--model`, `--no-tui` (plain-stdio fallback for non-TTY
      environments — chat only, no live draft pane).
- [x] **Lifecycle events.** Emit to `./.ccloop/events.jsonl` (same
      file the build loop uses): `design_session_start`,
      `design_phase_enter`, `ask_user_asked`, `ask_user_answered`,
      `draft_edit`, `design_session_accept`, `design_session_abort`,
      `design_session_end`. Event records include phase, turn count,
      cost, cache rate.
- [x] **Tests.** Unit tests for: `ask_user` MCP tool input/output
      contract, draft sandbox enforcement (writes outside
      `./.ccloop/design/` rejected), promote-on-accept flow,
      validation-gate failure path, resume-with-existing-draft,
      auto-routing logic, graceful-shutdown summary writer. TUI
      integration test: render two-pane layout, focus cycling,
      `ask_user` widget keyboard handling. Coverage target same as
      build loop.
- [x] **Documentation.** Update `README.md` with the two-phase model
      and a `ccloop design` quickstart. Update `.claude/CLAUDE.md` to
      reflect that `./SPEC.md` may now exist at the repo root (the
      "no SPEC.md at root" assertion is no longer load-bearing post
      this feature). Add a `## Design loop` section to
      `.claude/SPEC.md` linking to the relevant code under
      `src/design/`.

## Verification Requirements

When all of these are satisfied, write `DONE.md` at the project root
with one paragraph per item explaining how it's met.

1. All SPEC.md checkboxes complete.
2. All tests pass (`bun test`).
3. Typecheck passes (`bun run typecheck` or equivalent).
4. `ccloop design` can be run end-to-end against an empty fixture
   directory: agent walks the user through phases, draft is written,
   `validateSpec` passes on the produced draft, promotion creates
   `./SPEC.md` and offers `ccloop build`.
5. `ccloop design` can be run end-to-end against a fixture directory
   containing existing source files: agent reads relevant files via
   `Read`/`Grep` and references them in the produced spec.
6. Graceful shutdown produces a non-empty `last-session.md` summary.
7. Build loop's existing test suite still passes after shared-TUI
   extraction (no regressions).
