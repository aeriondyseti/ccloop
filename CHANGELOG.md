# Changelog

All notable changes to ccloop. Newest at the top.

## Unreleased

### Removed
- **`.claude/SPEC.md` §15 design-loop pointer section.** The internal
  build contract spec rules say "don't edit `.claude/SPEC.md` unless
  the feature genuinely changes the contract." The §15 I added during
  the autonomous loop was a code map / pointer doc that violates the
  rule — its content reads as living documentation, not a contract
  change. The forward-looking notes (phase tracking, history resume)
  moved to `ROADMAP.md` where they belong.
- **Never-fired `design_phase_enter` event.** The emitter exposed
  `phaseEnter()` and the `EventType` union listed
  `design_phase_enter`, but the orchestrator doesn't track phase
  transitions, so the event never fired in production. Removed the
  emitter method, the event type, and the now-unused
  `DesignSessionState` enum. SPEC.md updated to call out phase
  tracking as future work; the dogfood spec's "Lifecycle events"
  checkbox now lists the events that actually fire.
- **Dead `src/design/session.ts` module.** The session-metadata
  persistence helpers (`saveSessionMetadata`,
  `loadSessionMetadataIfExists`, `isSessionResumable`, etc.) were
  exported from `src/design/index.ts` and tested in isolation, but
  no production code path called them — the orchestrator's
  resume-by-draft-on-disk pattern (`initializeDraft` is a no-op when
  `spec.draft.md` exists) covers SPEC's "Resume model" requirement
  without a session.json file. Drops the file, its test, the
  associated `DesignSessionState` and `DesignSessionMetadata` types,
  and `DESIGN_SESSION_METADATA_PATH` / `getDesignSessionMetadataPath`.
  If/when conversation-history persistence ships, it'll need a
  different shape anyway.

### Fixed
- **Design events properly typed; `as any` casts removed.** The
  design event emitter cast every `type` string to `any` and every
  `run_id` to `"" as any` to bypass `EventBase`'s closed `EventType`
  union and `RunId` brand. The right fix is to extend `EventType`
  with the design lifecycle variants and widen `EventBase.run_id`
  to `RunId | ""` (design sessions don't carry a run id). All seven
  emitter methods now type-check without escape hatches; the JSONL
  payload is unchanged. Also drops a stale `nowIso` import while in
  the file.
- **`forceAbort()` now reliably aborts the SDK in `runDesignSession`.**
  The orchestrator was passing `input.abortController` to the SDK, so
  if a caller supplied a `shutdown` signal but no separate
  `abortController` (or two unrelated controllers), the second Ctrl+C
  would trip the shutdown's internal AC but the SDK call would
  continue to natural completion. `ShutdownSignal` now exposes its
  underlying `abortController`, and the orchestrator threads that
  through `buildSdkOptions` unconditionally.
- **`ccloop design` Ctrl+C dead-window and missing SIGTERM.** Two
  related signal-handling bugs in the design CLI:
  - A second Ctrl+C arriving more than 2 s after the first silently
    no-op'd, leaving users stuck if a summary turn outran the
    force-quit window. The handler now resets `firstAt` after the
    window elapses and re-announces the prompt so the next press
    still has a route out.
  - SIGTERM (the standard graceful-stop signal in Docker / systemd)
    was not handled at all; the process would hard-exit without the
    summary write. The handler is now bound to both SIGINT and
    SIGTERM, matching `ccloop run` / `ccloop build`.
- **`ccloop design` template path resolution in published npm
  install.** `initializeDraft` resolved its default template path via
  `__dirname`, which Bun polyfills in dev but is not the idiomatic
  ESM form and resolves wrong against bundled distributions. Replaced
  with `import.meta.dir`, matching the rest of the codebase
  (`build-info.ts`, `init.ts`).
- **Forward-compat for legacy `state.json` after the rotation-summary
  field landed.** `validateState` defaults all new optional fields to
  null/0 on read of pre-feature state files; `rotation_summary` was
  added without an entry, so existing `.ccloop/state.json` files
  would deserialize with `rotation_summary: undefined`. The driver's
  `?? ""` guard at the consumption site masked the immediate issue,
  but the type contract says `string | null`. Added the default
  alongside the others.
- **Design-mode `MultiEdit` sandbox bypass.** `getTargetPath` only
  returned the first edit's `file_path`, so an agent could escape the
  `.ccloop/design/` write boundary by placing a permitted path first
  in `edits[]` and a forbidden one in any later element. The check
  now iterates every edit and denies if any path lies outside
  `designDir`. Adds the regression test that was missing.

### Changed
- **`claude.max_turns_per_step` default 50 → 20.** Each ccloop step
  drains the SDK's per-query inner-turn budget; tool_result blocks
  from every turn live forever in the resumed session. At 50 turns
  per step a single step routinely persisted ~150 KB of tool_result
  content (49 calls observed in one real run). 20 caps that at
  ~60 KB without throttling productive work — most steps need far
  fewer turns; ones that genuinely need more should rotate the
  session sooner anyway. Existing installs with `ccloop.toml` left
  on the default will see the new value; users who relied on the
  previous 50 should set `[claude].max_turns_per_step = 50` in their
  config to opt back in.
- **`{{last_error}}` line cap.** The `last_failure.excerpt` field is
  already capped to 1024 visual columns by `capExcerpt`, but
  `string-width` counts newlines as zero-width — a dense stack
  trace could clear the column cap and still drag in 50+ lines that
  live forever in the resumed session. `renderLastError` now also
  trims to the last 40 lines with an "(N earlier lines elided)"
  marker before fencing.

### Added
- **`ccloop design` subcommand.** A sibling to the build loop: an
  interactive brainstorming agent that walks the user from a vague
  idea (or an existing codebase) through vision → users → scope →
  architecture → milestones → acceptance and produces a validated
  `./SPEC.md` ready for the build loop to consume. Two-pane Ink TUI
  (transcript + live `spec.draft.md`) with focus cycling, an
  `ask_user` MCP widget for structured multi-choice questions, and
  freeform between-turn input. Sandboxed file writes are restricted
  to `./.ccloop/design/` via a PreToolUse hook reusing the build
  loop's bwrap / sandbox-exec infrastructure for Bash. Graceful
  Ctrl+C runs a final summary turn that writes
  `./.ccloop/design/last-session.md`; second Ctrl+C within 2 s
  force-quits. Slash commands `/accept` (validate → confirm →
  promote → offer `ccloop build`) and `/abort`. New `[design]`
  section in `ccloop.toml`; CLI flags `--model`, `--no-tui`. Falls
  back to a stdio adapter when `[design].enable_tui = false` or
  stdin/stdout aren't TTYs.
- **`ccloop build` subcommand alias for `ccloop run`.** Symmetric
  with `ccloop design`. Both `run` and `build` continue to work.
- **Bare-`ccloop` auto-routing.** Invoking `ccloop` with no
  subcommand consults `validateSpec` in CWD: a valid `./SPEC.md`
  routes to the build loop, otherwise to the design loop. Explicit
  `ccloop design` and `ccloop build` always honor the verb. Prints
  help only on `--help` / `-h` / `help`.
- **Session compaction on rotation.** The proactive rotation paths
  (step-cap and context-threshold) now summarize the expiring SDK
  session before clearing it. A one-shot query
  (`src/sdk/summarize.ts`) asks the model for a 300-word
  self-summary of goal, in-flight work, decisions, and gotchas; the
  result lands in `state.rotation_summary` and is rendered into the
  next step's prompt under a "Picking up from a rotated session"
  heading via the new `{{rotation_summary}}` template slot. The
  field is cleared after one consumption so subsequent steps don't
  replay the same summary. Reactive `context_overflow` rotations
  still skip summarization — the wedged session can't answer.
  Replaces the hard-rotate tech debt that lost in-flight context
  every time the loop crossed a rotation threshold.
- **Surface Claude's TodoWrite plan in the build TUI.** The
  `StreamParser` now extracts a `TodoWrite` tool_use's `input.todos`
  array into a typed `todo_state` turn event in addition to the
  generic `tool_use` event. The projector pulls the latest snapshot
  into `view.claudeTodos`; the header shows a compact
  "todos N/M (in-flight item)" segment alongside the SPEC checklist
  count, and the transcript renders each TodoWrite call as a styled
  list block (▢ pending / ◐ in-flight / ✓ done) so the operator can
  watch the agent's working plan evolve. Distinct from the static
  SPEC checklist — that's the user's target; this is the agent's
  in-flight working memory.
- **Operator pause** (`p` to toggle while RUNNING / OPERATOR_PAUSED).
  Per-instance, in-memory; not durable — restarting ccloop resumes
  running. Distinct from rate-limit pauses (which set
  `state.state = "paused"` and persist to `state.json`); operator
  pause is layered on top of a healthy run via the new
  `pauseGate.ts` utility and a corresponding `OPERATOR_PAUSED` TUI
  state. The orchestrator parks at the top of the next loop
  iteration when the gate is set, so pressing `p` mid-step lets the
  in-flight step + cadence sleep complete naturally before pausing
  — no work is interrupted. New durable events
  `operator_pause_enter` / `operator_pause_exit` write to
  `events.jsonl` so the wake-up recap can attribute idle time
  correctly. New hook `usePauseKey` in `tui/shared/hooks.tsx`;
  Dashboard's RUNNING controls hint now leads with `p pause` and
  the OPERATOR_PAUSED hint with `p resume`. The pause hotkey is
  gated to RUNNING / OPERATOR_PAUSED only.
- **SDK debug dump** (`CCLOOP_SDK_DEBUG=1`, auto-set by `--debug`).
  When enabled, `runStep` writes per-step artifacts under
  `.ccloop/sdk-debug/step-<NNNN>/`: `input-<attempt>.json` (rendered
  prompt, `resume` session id, the full SDK `Options` object —
  functions and `AbortController` references stringified for clean
  JSON), `stream-<attempt>.jsonl` (one line per SDK message:
  assistant, tool_use, tool_result, partial, system, result), and
  `result.json` (the aggregated `StepResult`). Continuation chains
  produce additional `input-N.json` / `stream-N.jsonl` pairs.
  A `.gitignore` (`*\n`) is created in the dump root the first time
  it's used so dumps never get committed accidentally. Fully
  best-effort — file errors don't break the step. Primary use: the
  "prompt is too long" hunt that revealed the resumed-session
  context-overflow path. Useful one-liners: `wc -l
  .ccloop/sdk-debug/step-<N>/stream-0.jsonl` (turn count), `jq -c
  'select(.type=="assistant") | .message.usage' stream-0.jsonl`
  (per-turn token growth), `grep -l prompt_too_long
  .ccloop/sdk-debug/step-*/result.json` (every step that hit the
  limit). New `step?: number` field on `RunStepInput` labels the
  dump dir; `LoopDriver.stepOnce` passes `state.current_step`.
  `debug:info` reports the new env var alongside `CCLOOP_DEBUG` and
  `CCLOOP_TUI_DEBUG`.
- **Auto-rotate the SDK session on context overflow.** The Anthropic
  Agent SDK responds to a context-window-too-large request with a
  *synthetic* assistant message (`subtype: "success"`, `is_error:
  true`, `model: "<synthetic>"`, `result: "Prompt is too long"`,
  `duration_api_ms: 0`) — the request never hit the API. Without
  detection, ccloop classified this as a successful step (no commit
  because `final_text` was the error string), preserved
  `state.session_id`, and re-resumed the same poisoned session every
  step until escalation. `StepResult` now carries `is_error: boolean`
  pulled from the SDK's terminal `result` message; `classifyStep`
  routes `is_error` results matching `/prompt is too long|context
  .*(too long|exceed|overflow)|input is too long/i` to a new
  `context_overflow` failure category and other `is_error` cases to
  generic `sdk`. `LoopDriver.stepOnce` clears `state.session_id` and
  resets `steps_since_session_reset` on `context_overflow` so the
  next step starts a fresh session — the prompt template already
  tells the model to reload `SPEC.md` and `.ccloop/progress.md` from
  disk on a fresh session, so the run self-heals at a cost of one
  extra turn instead of escalating. Discovered via the new SDK
  debug dump (see below) on a real step-12 run.

### Changed
- **Ink 5 → 6 and React 18 → 19**, plus matching `@types/react` bump.
  The driver was a long-running TUI flicker on log/now updates that
  resisted every Ink-5-level mitigation: `ink-scroll-view` was not
  the cause (swapping to a plain Box + tail-slice didn't help);
  raising the tick rate from 250ms to 1000ms didn't reduce flicker
  proportionally; even ticks where rendered output bytes were
  identical produced visible repaints. Root cause: Ink 5 writes the
  full frame on every `rerender()` regardless of diff (clear region
  + rewrite), and there was no protocol-level synchronization with
  the terminal. Ink 6 ships the actual fix: synchronized output
  (DEC mode 2026, automatic in supporting terminals — Kitty,
  WezTerm, Ghostty, recent Konsole / iTerm2 — buffers writes
  between begin/end markers so the frame swap is atomic),
  `incrementalRendering` (only emits ANSI for changed lines),
  `maxFps` (built-in throttle, default 30 — supersedes our manual
  cadence), and opt-in React 19 concurrent rendering. All three are
  enabled at the `render()` call in `cli/run.ts`. Also fixes the
  character-width handling issues we'd been seeing. The
  skip-if-unchanged guard around `ink.rerender()` is kept as
  belt-and-suspenders since it still avoids React reconciliation on
  no-op ticks. React 19 typing change (`useRef<T>(null)` returning
  `RefObject<T | null>`) propagated through `useScrollKeys` /
  `useAutoTail` ref types — only behavioral surface beyond the new
  Ink options. Default `flexShrink={0}` added to `Pane` (with
  `NowPane` keeping `flexShrink={1}`) so a tall streaming pane no
  longer pushes sibling panes off-screen as content grows.
  Resolves the long-standing TUI flicker (was tracked in
  `TECH-DEBT.md`, now moved to that file's "Resolved" section).

### Refactor (simplify pass)
- Replaced `unknown` / `Record<string, unknown>` casts in the SDK
  iterator hot path with the SDK's actual exported types (`SDKMessage`,
  `SDKAssistantMessage`, `SDKResultMessage`, `Options`,
  `NonNullableUsage`). `runStep`'s message loop now narrows on
  `msg.type` instead of cast-and-pray; `accumulateUsage` takes
  `NonNullableUsage` directly and the previous defensive `numberOr`
  helper was removed (the typed fields are already numbers).
  `extractText` typed against the SDK's content-block discriminated
  union. `buildSdkOptions` returns `Options`. Same cleanup in
  `debugDump.ts` (`SdkDebugSink.message: SDKMessage`,
  `finish: StepResult`, attempt payload's `options: Options`).
  No behavior change; future SDK shape drifts now surface as
  typecheck errors at compile time rather than silent wrong access
  at runtime.

### Added
- **`escalation_resolved` event** captures the operator's choice at
  the escalation menu (`continue` / `revert` / `edit_spec` /
  `quit`). Previously the events log showed `escalate` then later
  `step_start` events with no record of what the operator did to
  recover — answering "what did I do at 2am to bring this back"
  required diffing git history against state.json. Recap now
  reports `escalations resolved: 2 continue, 1 revert` when at
  least one escalation occurred. SPEC §11.5 table updated.
  `handleEscalation`'s return type widened from `"continue" |
  "quit"` to the full action set so the call site can record it.
- **Gate command** (`loop.gate_command`, default empty): an optional
  shell command run after each successful step, before auto-commit.
  Non-zero exit or timeout records the step as a `gate` failure
  (new failure category, SPEC §9.1) and skips the commit; the
  captured output is fed into the next prompt's `last_error` block
  so Claude can course-correct rather than committing a regression
  Claude didn't notice. Bounded by `loop.gate_timeout_seconds`
  (default 300s) and run in a fresh process group so a hung
  pipeline kills cleanly. Common values: `"bun run typecheck"`,
  `"bun run typecheck && bun test"`. Closes the long-standing gap
  where Claude's "all green" claim was the only signal ccloop had.
- **Heartbeat ping** (`notify.heartbeat_url`, default empty): POST
  to a liveness URL after every step (any outcome) and on done.
  Designed for healthchecks.io-style endpoints so an off-device
  monitor can alert when ccloop stops sending pings overnight.
  Best-effort with a 10s timeout per ping; not rate-limited locally.
  Body is a small JSON envelope (run id, step, outcome, state, ts).
- **Wake-up recap**: when running `--continue` against an existing
  `.ccloop/`, ccloop prints a one-screen overnight summary to stderr
  before the alt-screen TUI takes over. Surfaces last activity time,
  step counts by outcome, top failure categories, last commit
  subject, and escalation/pause counts. Lands in scrollback once
  ccloop exits, so an operator returning in the morning sees what
  happened without round-tripping to `events.jsonl`.

### Added
- **Per-step watchdog** (`claude.step_timeout_seconds`, default
  1800s/30min, 0 disables): hard wall-clock cap on a single step's
  SDK call. Without it, a stalled mid-stream network read had no
  ceiling — the SDK has no native iterator deadline, so an
  overnight run could silently hang until SIGINT. The watchdog
  aborts via the same controller used for SIGINT, synthesizes a
  failed step result so the audit trail (step record, events log,
  next prompt's `last_error`, recap) carries the timeout, and
  routes through normal `step_timeout` failure-category handling
  (new failure category, SPEC §9.1) so the orchestrator's
  consecutive-failures escalation logic catches a sustained hang
  cluster rather than treating each one as a bare SDK init failure.

### Refactor (simplify pass)
- Startup parallelizes three independent reads via `Promise.all`
  in `cli/run.ts`: `loadRecentEvents` (always), `loadRecentSteps`
  (resume-only), and `readChecklist` (always). Previously
  serialized; saves measurable ms on resume. Same change dedupes
  a duplicate `readChecklist` call — SPEC.md was being read
  twice on resume, once for the wake-up recap and again for the
  dashboard's `cachedChecklist` initial value. Now the parallel
  read populates both.
- `notify()` fires push and webhook channels in parallel via
  `Promise.all`. Previously sequential awaits meant a misconfigured
  URL hitting the 10s timeout serialized both, doubling
  worst-case shutdown latency on `notify_on_done` and escalation
  paths to 20s. Rate-limit state is now stamped at attempt-start
  (before the await) so concurrent `notify()` invocations would
  see consistent state — orchestrator only calls it sequentially
  today, but the safety belongs in the function. New regression
  test sleeps 100ms inside each fakeFetch and asserts the total
  elapsed is under 300ms (generous CI-jitter bound).
- `validateSpec` and the dashboard/recap checklist counter now
  share `parseChecklist` as the single source of truth. `validateSpec`'s
  bespoke regex only accepted `-` bullets while `parseChecklist`
  (used by the TUI header and wake-up recap) accepted any GFM
  task-list shape. A user with `* [ ] foo` items would see
  checklist progress in the dashboard but `ccloop run` would
  refuse to start with "no checklist." New regression test
  exercises `*`, `+`, and numbered bullets.
- `nowBuffer` (live SDK stream pane) now appends in-place via
  `push` instead of `[...nowBuffer, e.turn]`. The spread was O(n²)
  across a step's lifetime; a heavy step emitting thousands of
  stream chunks would re-allocate and copy the whole buffer on
  each one. Dashboard isn't memoized — it re-renders from `view`
  identity on every tick, not from `nowContent` identity — so
  in-place push is safe.
- `headDiffHash` discards `git diff` stderr at the kernel
  (`stderr: "ignore"`) instead of buffering the whole stream into
  memory just to drain the pipe. We never read stderr — exit code
  is the only signal — so the prior `Response(proc.stderr).text()`
  was the same in-memory buffering risk we removed for stdout.
- `headDiffHash` streams `git diff` stdout directly into the
  sha256 hasher instead of buffering the full output via the
  general-purpose `runGit`. A step that accidentally commits a
  large `node_modules` or `dist/` (a real Claude failure mode)
  produces a multi-MB diff; the prior path materialized the whole
  thing in memory just to compute one hash. Same 120s timeout
  applies. New regression test runs against a 5 MB diff.
- Removed dead `unit !== "h"` clause in `parseRateLimitError`'s
  `unitToMs` — a string starting with `"m"` can never equal
  `"h"`, so the second condition was always true.

### Removed
- Pruned four `EventType` variants that were declared but never
  emitted: `validation_ok`, `validation_failed`, `tool_call`,
  `compact_boundary`. The first two had a chicken-and-egg problem
  (validation runs before state.json is loaded → no `run_id`);
  `tool_call` would balloon `events.jsonl` with per-tool detail
  the dashboard already shows live in the Now pane; the SDK
  exposes no signal for `compact_boundary`. SPEC §11.5 table
  rewritten to match what ccloop actually emits — including the
  newer `usage_degraded`, `cache_warning`, and `recovery_commit`
  rows that had been added without a SPEC update. Honesty in the
  contract beats aspirational completeness.
- `--log-level` flag. It was parsed and documented in `--help` but
  never actually wired anywhere; users passing it expected log
  filtering but got silence. Now rejected as an unknown flag —
  better to surface the gap than to lie about supporting it.
  Implementing real level-based filtering would need substantial
  plumbing through events.jsonl + bus subscribers; out of scope
  here.

### Fixed
- Dashboard now shows the user-recognisable Bash command instead of
  the sandbox wrapper. The PreToolUse approver rewrites Bash
  commands as `bwrap --ro-bind / / --proc /proc ... -- /bin/sh -c
  '<inner>'` (Linux) or `sandbox-exec -p '...' /bin/sh -c
  '<inner>'` (macOS); the streamParser was reading the rewritten
  string, so the dashboard's "now" pane truncated the wrapper
  prefix at 100 chars and the actual command never made it
  on-screen. `summarizeToolInput` now unwraps the known wrapper
  shapes for display, leaving execution semantics untouched.
- Per-step watchdog no longer corrupts a successful step's
  classification. If the timer fired (set `watchdogTimedOut` and
  aborted the controller) but the SDK happened to complete its
  in-flight message before noticing the abort, `runStep` returned
  success — yet the unconditional post-try override flipped the
  classification to a `step_timeout` failure, recording a
  successful step in the audit trail as a timeout. The override
  now keys on a separate `timedOutAndAborted` flag set only on
  the catch branch where we actually synthesized the timeout
  result. Regression test simulates the race and asserts the
  `outcome: "success"` survives the watchdog fire.
- Locally rate-limited notifications no longer emit
  `notification_sent` events with `ok: false`. The 1/min/channel
  local throttle is ccloop-side suppression, not a channel
  failure; last week's recap "N notify failures" surface was
  conflating "we throttled ourselves" with "the on-call webhook
  is broken." `NotifyResult` now carries an optional
  `rateLimited: true` flag, and `fireNotification` skips emission
  for those results. New `notify` test asserts the flag is set on
  the suppressed second call within a 60s window.
- `headDiffHash` swallows spawn / stream-read / `proc.exited`
  errors and returns `null` instead of letting them propagate. Any
  unexpected git failure mid-read (broken pipe, killed process,
  reader stream error) used to bubble up through `driver.stepOnce`
  and get recorded as a spurious `sdk_init` failure, contributing
  toward a false escalation. The diff hash is just an input to the
  `loop_detected` heuristic — a missing entry delays detection by a
  step, which is far preferable to escalating the run.
- Post-cadence DONE detection now reports the correct step number
  in `events.jsonl` and the notify summary. When `DONE.md` was
  created during step N's successful execution, the
  post-cadence-sleep done check fired *after* `state.current_step`
  was already incremented to N+1, so the durable `done` event
  attributed the achievement to step N+1 — a step that never ran.
  The recap reads step records (which carry the correct step
  number) so the recap was right; only the events log + notify
  summary disagreed. `checkDoneTransition` now takes an optional
  `forStep` override; the orchestrator passes `current_step - 1`
  on the post-cadence path.
- `--no-color` now actually disables ANSI colors. The flag was
  parsed and listed in `--help` but never read. Setting
  `NO_COLOR=1` in the env at startup makes Ink (and any other
  chalk-aware writer) honor it.

### Changed
- `claude.max_steps_per_session` default raised from `0` (always
  resume) to `30`. Overnight runs accumulate ~5KB of conversation
  history per step on resume; with the prior default a 200K
  context window filled in ~40 steps and started producing
  "context too long" errors mid-run with no operator input. A
  periodic reset bounds context growth — Claude re-reads SPEC.md
  and progress.md from disk on the first step of the new session.
  Set to `0` explicitly to opt back into the prior behaviour. The
  template comment recommended 25-50 for overnight runs but the
  default contradicted it; this aligns them.

### Added
- **`recovery_commit` event** emitted whenever the §10.4 recovery
  commit fires (dirty tree on resume — the prior process died
  mid-step). New event type carries `commit_sha` and
  `commit_subject`. Recap pairs it with the prior-crash warning:
  the operator now sees both `N prior instances did not exit
  cleanly` and `recovery commit XXXX picked up unsaved work from
  prior crash` together, so they know what was salvaged from the
  prior process's dirty tree without inspecting git log by hand.
- **Prior-crash detection in the recap.** With the new
  `instance_start`/`instance_exit` events, the recap can now flag
  an unpaired `instance_start` (process died before its `finally`
  could fire — SIGKILL, OOM, machine reboot). The current instance
  is expected to be unpaired; anything more renders as
  `warning: N prior instances did not exit cleanly`. Catches the
  silent overnight crash that previously left the operator
  thinking the run had simply made less progress than expected.
- **Recap surfaces failed notifications and multi-instance runs.**
  Wake-up recap now reads the new `notification_sent` events and
  counts `ok: false` entries — a webhook channel that silently
  rejected alerts overnight is now visible as `N notify failures`
  in the recap's events line. Recap also prints
  `instances: N (this resume continues prior runs)` when the
  current resume is at least the second instance, so the operator
  can tell "single 8h run" apart from "8 × 1h `--continue` resumes"
  without parsing events.jsonl by hand. Single-instance runs skip
  the line to avoid noise on the typical case.
- **`instance_start` and `instance_exit` events** now emitted to
  `events.jsonl` per SPEC §11.5. Both event types were declared
  but never produced; without them, post-mortem tooling can't tell
  "single 8h run" from "8 × 1h `--continue` resumes" — the recap
  reads the events log for context. `instance_start` carries
  `ccloop_version`, `cwd`, and `git_sha` (HEAD at startup);
  `instance_exit` carries `reason` (mapped from exit code:
  `done` / `escalated` / `guardrail_trip` / `sigint` / etc.) and
  `exit_code`. Best-effort emission so a log-write failure can't
  prevent a clean shutdown. Rendered in the dashboard log pane
  and stderr echo.
- **`notification_sent` event** now actually emitted, closing a
  long-standing SPEC §11.5 gap. The event type was in the
  `EventType` enum but no code path emitted it; an on-call webhook
  that silently 502'd overnight gave the operator no signal that
  the channel was broken. `fireNotification` now emits one durable
  event per channel attempted (push and/or webhook), with `ok`,
  `status`, and `error` fields. Surfaced in the dashboard log
  pane and stderr echo as `notify <channel>: ok (200)` or
  `notify <channel>: failed (502)`.
- **SPEC.md checklist progress** surfaced in the live dashboard
  header and the wake-up recap. `parseChecklist(text)` counts
  `- [ ]` / `- [x]` items (also `*`, `+`, numbered bullets;
  case-insensitive `[X]`; ignores fenced code blocks). The
  starter `templates/SPEC.md` already promised "ccloop renders it
  on the dashboard so you can watch progress" — this lands the
  surface. Header shows `checklist 7/12` (green when complete);
  recap adds `checklist: 7/12 done (58%)` so an operator returning
  in the morning sees overnight progress at a glance. SPEC.md is
  re-read on each `step_end` event, not on every TUI tick — the
  dashboard reflects whatever Claude just ticked off without
  polling.
- **Remote-mutation denylist**: Bash sandbox denylist now refuses
  `git push --force` / `-f` / `--force-with-lease`, `git push
  <remote> +ref` shorthand, and `npm`/`yarn`/`pnpm`/`bun publish`.
  Network was unrestricted by design (build tools need it), but
  destructive remote operations had no guard — an overnight run
  could have rewritten remote history or published a package
  before the operator woke up. Regular `git push` (non-force) is
  still allowed; operators who want the destructive paths can
  enable `yolo_mode` or run on a worktree without push credentials.
  SPEC §6.5 updated. New denylist test file covers both refused
  and allowed shapes.

### Fixed
- Non-TTY mode (`nohup ccloop run > log.txt 2>&1 &`, CI, stdout
  redirected) now skips the entire TUI machinery, not just the
  alt-screen escape codes. Ink was previously still repainting the
  dashboard frame to stdout 4× per second, which polluted the log
  file with re-rendered frames. The Ink mount, the 250ms render
  tick, and the menu-key reader are all skipped when
  `process.stdout.isTTY` is false. Each durable event line now
  echoes to stderr instead so the log file has some progress
  signal beyond the startup recap. Escalation / guardrail-trip
  auto-quit (no way to read menu keys without raw mode); the
  operator resumes via `--continue` after addressing the cause.
- Alt-screen escape codes (`\x1b[?1049h`, hide-cursor, etc.) are
  no longer emitted when stdout isn't a TTY. For an overnight run
  detached via `nohup ccloop run > log.txt 2>&1 &`, the prior
  behaviour wrote raw control sequences into the log file —
  invisible noise that confuses log viewers (some interpret them,
  some show literal `^[[?1049h`). The dashboard is invisible in
  non-TTY mode anyway; events.jsonl and the wake-up recap are the
  durable surfaces there.
- Default prompt template no longer contradicts itself on where
  the commit subject comes from. The prior text said "End your
  response with a one-line summary…" while ccloop's commit-subject
  derivation takes the FIRST non-blank line. Claude that followed
  "End your response" put the summary last; the first line ended
  up as a preamble like "I'll add /healthz" or "Looking at the
  spec…", and that's what landed in the git log. Now the prompt
  says "Begin your response" with explicit framing that the first
  line IS the commit subject.
- Heartbeat now also fires during pause refresh (every ~60s while
  waiting out a rate-limit window) with outcome `"paused"`. Without
  this, a 5-hour pause silenced ccloop's heartbeats — an off-device
  healthchecks.io-style monitor with a multi-minute grace period
  would alarm "ccloop went silent" overnight even though the run
  was healthily waiting for the window to clear. Pings stay
  fire-and-forget so a misconfigured URL doesn't slow the refresh
  loop. Regression test sets `state.pause` and verifies a
  paused-state heartbeat lands within the test window.
- Orchestrator-emitted events (`pause_enter`, `pause_exit`,
  `escalate`, `usage_degraded`) now land in `events.jsonl`, not
  just the in-memory bus. Previously only driver-emitted events
  were durable; an overnight run that paused for rate-limit and
  crashed before resuming had no record of the pause in the
  durable log, so the wake-up recap's pause/escalation counts
  silently underreported. Two writers to the same append-only
  JSONL file is fine on POSIX (each `appendFile` is atomic for
  small lines). Regression test verifies an escalate event
  written by the usage-gate path appears on disk.
- `validateState` now rejects `NaN` / `Infinity` in numeric fields.
  `typeof NaN === "number"`, so a hand-edited or upstream-corrupted
  `state.json` with e.g. `"current_step": NaN` previously passed
  validation and silently broke the loop driver — guardrail
  comparisons against NaN are always false, so the run could
  proceed past `max_steps` indefinitely.
- Dashboard's `averageCacheHitRate` no longer includes step records
  with zero token usage. `step_timeout` and other synthesized
  failure records carry empty usage and a 0 cache_hit_rate; the
  prior unfiltered mean dragged the displayed average toward 0 on
  overnight runs that survived a few hangs even though the real
  cache behaviour was healthy. Now averages over only steps that
  actually called the model.
- User-initiated cancellation (SIGINT) during a step's SDK call no
  longer records a spurious `sdk_init` failure. The SDK throws
  AbortError out of its stream iterator on abort; the orchestrator
  caught it as a "genuine surprise" and bumped
  `consecutive_failures`. Two prior real failures + a clean Ctrl+C
  would silently tip the run into ESCALATED, so the next
  `--continue` dropped the user into the escalation menu instead of
  letting them resume. The catch branch now short-circuits to
  `cancelled` when `abortSignal.aborted` is set.
- Heartbeat now fires-and-forgets instead of awaiting completion.
  An unreachable or typo'd `heartbeat_url` previously cost up to
  10s (the per-request timeout) on every step; for a 4-min cadence
  and 200 steps that's ~33min of stall on an overnight run. The
  ping's synchronous prelude still runs before control returns
  (so test observers that record into shared state during the
  fetch still see the call), but the orchestrator no longer blocks
  on the network round-trip. New regression test proves a hung
  host does not throttle step iteration.
- SDK-init failures (the orchestrator's `try/catch` around
  `driver.stepOnce`) now emit a `step_failed` event to both the bus
  and `events.jsonl`. Previously these failures only bumped the
  `consecutive_failures` counter — the TUI events pane stayed silent
  and the wake-up recap couldn't surface a burst of overnight 5xx
  / "model overloaded" hits without round-tripping to `state.json`.
  The new `LoopDriver.recordSdkInitFailure` method centralizes the
  state mutation + event emission; the orchestrator delegates to it.
  Wake-up recap also now lists "N sdk_init failures" alongside the
  escalation/pause counts.
- `NotifyEnvelope.trail` accepts a builder function (`() =>
  Promise<unknown[]>`) so the trail is constructed lazily, only when
  the webhook channel is actually about to fire. The orchestrator's
  `fireNotification` now passes the builder directly. Previously
  `loadRecentSteps` ran on every `fireNotification` call regardless
  of whether a webhook was configured or rate-limited — a small
  per-step waste on the more common push-only configuration.

### Refactor (simplify pass)
- Extracted `atomicWriteFile(path, body)` to `src/util/atomic.ts`;
  `writeState` and `writeStepRecord` both use it instead of
  re-implementing the tmp+rename pattern.
- Collapsed `validateState`'s three near-identical
  state⇒info-object guards into a small lookup table — adding a
  new `RunStateName` with a companion field is now a one-line edit.
- `clearSessionForReorientation` helper in `escalation.ts` replaces
  duplicated 3-line + comment blocks in the revert/edit_spec
  branches of `handleEscalation`.
- Named the magic `"continue"` continuation prompt as
  `CONTINUATION_PROMPT` in `runStep.ts` so the SDK's keyword is
  greppable.
- `loadRecentEvents` now tail-reads the events.jsonl (64 KB initial
  window, doubles up to file size) instead of loading the whole
  file. Avoids a multi-MB read on multi-day `--continue` resumes.

### Fixed
- `runStep` checks `input.abortController.signal.aborted` between
  pause_turn continuation calls. Without this, a SIGINT mid-step
  could trigger a fresh SDK invocation just to have it immediately
  tear down — wasted setup latency. Now bails cleanly with the
  prior call's `pause_turn` stop reason, which the orchestrator's
  abort handling already accommodates.

### Added
- `claude.max_continuations_per_step` is now actually wired up. When
  the SDK returns `stop_reason: "pause_turn"`, `runStep` calls the
  SDK again with the same session and `prompt: "continue"`, capped
  by the config value (default 5; `0` disables). Usage, turn count,
  and assistant-text aggregate across continuation calls; the final
  `stop_reason` is the last call's. Previously each `pause_turn`
  produced a half-finished ccloop step with its own commit and
  cadence sleep — fragmenting Claude's work and adding extra commits
  that didn't reflect natural task boundaries. `runStep` gained a
  `queryImpl` test seam so the new branch is covered without hitting
  the live SDK.

### Tests
- Added an integration test asserting an escalation webhook's
  `trail` field contains the seeded step records (step number,
  outcome, commit subject). Catches a regression in the trail
  build path that was previously untested.

### Added
- Webhook notification envelopes now include a populated `trail` —
  the last five step summaries (`step`, `outcome`, `subject`,
  optional `failure {category, excerpt}`, `cost_usd`,
  `cache_hit_rate`). Previously `trail` was always `[]`. Lets a
  webhook consumer (Slack bot, custom dispatcher, …) show the
  operator recent run context for the escalation without round-
  tripping back to the dashboard. Best-effort: any read failure
  silently degrades to an empty trail.

### Changed
- Dashboard cadence-wait label changed from `cadence X/Ys` to
  `next step in Ns (X/Y)`. The countdown is what the operator
  actually wants to know at a glance overnight; the X/Y stays as
  context.

### Fixed
- `UsageClient.refresh` now bounds each fetch with a 10s
  `AbortSignal.timeout` (override via `UsageClientOptions.timeoutMs`).
  Same pattern applied earlier to notify and git: a hung
  `/api/oauth/usage` endpoint would otherwise stall the orchestrator's
  pre-step usage gate every step. Timeouts surface as
  `network_error: "timeout after Nms"` so the rest of the loop's
  degrade-to-reactive logic kicks in cleanly.

### Fixed
- `renderLastError` (the `{{last_error}}` block in the next step's
  prompt) now picks a code-fence length one longer than the longest
  backtick run in the failure excerpt. A tool-output excerpt that
  legitimately contained ` ``` ` would previously close the prompt's
  markdown fence prematurely, breaking subsequent prompt structure
  for Claude. Default minimum fence length is still 3.

### Added
- `claude.model` and `claude.fallback_model` config fields wire
  through to the Agent SDK's `model` / `fallbackModel` options.
  Empty strings (default) preserve the SDK's defaults. The fallback
  is the overnight-resilience knob: when Anthropic returns 5xx /
  overload on the primary model, the SDK retries on the fallback
  rather than letting the failure bubble into a `consecutive_failures`
  escalation.
- `claude.effort` is now actually wired to the Agent SDK. Mapped to
  the SDK's `maxThinkingTokens`: `low=4000`, `medium=12000`,
  `high=24000`, `xhigh=64000`. Unrecognized values leave the SDK on
  its own default. Closes the dead-config gap flagged in the prior
  iteration. Default config (`xhigh`) now produces a 64k thinking
  budget instead of the SDK's silent default — runs going forward
  may show different cost / thinking-token usage in the dashboard.

### Fixed
- `validateState` enforces cross-field invariants: `state="paused"`
  requires non-null `pause`, `state="escalated"` requires non-null
  `escalation`, `state="guardrail_trip"` requires non-null
  `guardrail_trip`. A hand-edited or partially-written `state.json`
  with the mode flag flipped but the info object missing would
  previously slip through validation and the orchestrator's defensive
  `state.state === "paused" && state.pause` checks would silently
  advance as if running.

### Changed
- Default prompt template tightened for overnight runs:
  - Tells Claude that its first non-blank line becomes the auto-commit
    subject — encourages a short conventional summary like
    \`feat(api): add /healthz\` instead of a reasoning recap.
  - Asks Claude to tick off completed SPEC checklist items
    (\`- [x]\`) so the spec stays current as work lands.
  - Asks for a one-or-two-line progress.md note that captures the
    *why* and any non-obvious thing the next step should know
    (flaky test, deferred decision, half-finished refactor) — not
    just a recap of what changed.
  - "Skim the tail of progress.md" rather than the whole file —
    overnight progress.md grows long; the recent tail is what
    matters for orientation.

### Fixed
- `DriverEvent.step_failed.category` is now typed as `FailureCategory`
  rather than bare `string`, so a misspelled category at any emit site
  fails at compile time. Type-only change; runtime unaffected.

### Fixed
- `mergeConfig` rejects out-of-band `failure.*` thresholds at startup:
  `consecutive_failures_before_escalation` and `no_progress_threshold`
  must be ≥ 1, `loop_detection_repeats` must be ≥ 2. A `0` value used
  to escalate on the very first failure / first no-op / etc., which
  could brick a long run on transient blips.

### Fixed
- `mergeConfig` now rejects an unparseable `loop.max_wall_clock` at
  startup with a clear error pointing at the bad value. Previously
  any string `parse-duration` returned `null` for (typo, missing
  unit) silently disabled the wall-clock guardrail for the whole
  run — the most common overnight failure of "the loop never
  stopped" was fed by exactly this footgun. Empty string still
  disables explicitly.

### Fixed
- `mergeConfig` range-checks key numeric fields and throws clear
  `ConfigError`s for out-of-band values: `claude.max_turns_per_step`
  must be ≥ 1, `claude.max_steps_per_session` and `loop.max_steps`
  must be ≥ 0, `loop.target_cadence_seconds` must be ≥ 0, the two
  utilization thresholds must be in [0, 100], and every
  `failure.backoff` entry must be a non-negative number. Previously
  bogus values silently became "feature off" or stuck-loop
  conditions overnight.

### Fixed
- `validateState` now rejects an unknown value in `state.state`. A
  corrupt or hand-edited `state.json` with `state: "garbage"` would
  previously silently run as if "running" — the orchestrator's
  switches simply skipped the unknown value. Now the load fails
  loudly with a clear "must be one of …" error.

### Docs
- `templates/ccloop.toml` now flags `max_continuations_per_step` as
  not yet wired up. The MVP treats `pause_turn` as a successful step
  and resumes in the next ccloop step rather than auto-continuing
  in-step; tuning this knob currently has no effect. Honest doc
  beats silent dead config.

### Fixed
- Escalation `r` (revert) and `e` (edit spec) now clear
  `state.session_id`, forcing a fresh SDK session for the next step.
  The resumed session's prior context would otherwise still describe
  the rolled-back changes / pre-edit spec — Claude's mental state
  diverging from the actual working tree. The plain `c` (continue)
  path still resumes the session unchanged.

### Fixed
- `resetForContinue` (the `c` key after escalation) now clears
  `state.last_failure`. The next step's prompt would otherwise still
  carry a `{{last_error}}` block describing the failure the operator
  just acknowledged, misleading Claude about the current state.

### Fixed
- `autoCommit` now distinguishes "Claude made no changes" (true no-op)
  from "Claude committed its own work mid-step" (HEAD advanced, tree
  clean). The driver passes the pre-step HEAD; if autoCommit sees a
  clean tree but an advanced HEAD, it surfaces a real commit using
  Claude's own subject. Previously a productive Claude-self-commit
  step was misclassified as no-op, contributing to a false
  `no_progress` escalation after enough such steps in a row.

### Added
- Dashboard log pane prefills from `events.jsonl` on `--continue`
  startup (last `LOG_CAP=500` events). Previously the pane opened
  blank and stayed blank until the next step fired, leaving the
  operator with no overnight context. Malformed lines are skipped;
  missing file is benign.

### Fixed
- Escalation triggered during a pause-wait (mid-pause usage refresh
  crosses the 7-day threshold) now fires the push/webhook
  notification and emits the `escalate` event from inside
  `waitOutPause` itself, then short-circuits the orchestrator's main
  loop. Previously the function returned `"woke"` and relied on the
  next pre-flight to notice the new state and notify; an abort or a
  different gate decision in between could drop the notification
  entirely. Overnight, this is the most likely escalation path.

### Added
- Dashboard surfaces the cache low-streak visually: when
  `state.cache_low_streak >= 3` the cache hit rate text turns yellow
  and gains a `(low N×)` suffix. Pairs with the existing
  `cache_warning` log line so the operator notices the issue without
  scrolling the log.

### Changed (behavior break)
- `prompt.template_path` pointing at a non-existent file now throws
  at startup with a clear error instead of silently falling back to
  the embedded default. The silent fallback was a footgun: a typo'd
  `template_path` would invisibly use the default for an entire
  overnight run. Empty `template_path` still resolves to the default.

### Fixed
- `writeStepRecord` is now atomic (tmp file + rename), matching
  `writeState`. A kill / crash mid-write previously left a partial
  `.ccloop/steps/NNNN.json`. The projector skips malformed records,
  so the symptom was silent data loss rather than a crash, but the
  fix is cheap and removes the data-loss path.
- `EventType` union in `state/events.ts` now lists `cache_warning`,
  matching the value the driver actually emits to `events.jsonl`.
  Type drift only — no runtime behavior change.

### Fixed
- `runGit` invocations now bound by a 120s timeout (override per-call
  via `runGit(args, cwd, { timeoutMs })`). A hung pre-commit hook,
  stale `.git/index.lock`, or unresponsive network filesystem can no
  longer stall the orchestrator overnight — the process is SIGKILL'd
  and the result returned with `timedOut: true` and a synthesized
  stderr.

### Fixed
- Notify push/webhook calls now bound each request with a 10s
  `AbortSignal.timeout` (override via `NotifyOptions.timeoutMs`). A
  hung notification host can no longer stall the orchestrator's main
  loop — overnight, an unreachable push_url could previously block
  escalation indefinitely. Timeouts surface as
  `error: "timeout after Nms"` on the `NotifyResult`.

### Fixed
- TUI log-pane formatter renders `cache_warning` events instead of
  silently dropping them. Dashboard now shows lines like
  `12:04:31  cache hit rate 32% for 3 steps in a row` when the
  SPEC §11 warning fires.

### Fixed
- Escalation notifications no longer append a stale `last_failure`
  excerpt when the escalation cause is unrelated to step failures
  (guardrail trips, reactive rate-limit, usage-gate forecasts, repeated
  SDK init failures whose reason already carries the message). The
  failure-detail suffix is now opt-in per call site, on for the
  consecutive-failures path and off elsewhere — the prior wording
  could mislead the operator about which signal actually drove the
  escalation.
- SDK throw path in the orchestrator now records `state.last_failure`
  with category `sdk_init` and the error message (capped via the same
  `capExcerpt` step failures use). Previously `consecutive_failures`
  was bumped but `last_failure` was untouched, so when an SDK throw
  drove escalation the notification and next-prompt `{{last_error}}`
  block carried stale or null context instead of the actual error.

### Added
- Escalation push/webhook notifications now include the last failure's
  category and a one-line excerpt — e.g. `ccloop escalated: 3
  consecutive failures (run X step 47) — sdk: tests failed: timeout
  after 30s`. Previously the summary stopped at the run/step header,
  forcing the user to open the dashboard to see what actually broke.
  The excerpt is trimmed to its first line and capped at 200 chars
  so push transports stay happy.
- `claude.max_steps_per_session` config — cap how many consecutive
  steps reuse a single SDK session before ccloop forces a fresh one.
  Defaults to `0` (always resume, preserves current behavior). Useful
  for overnight runs: session resume is cheap inside the cache window
  but accumulates conversation history that grows the per-step token
  bill. A periodic reset re-establishes a clean cache prefix; Claude
  re-reads SPEC.md / progress.md from disk on the first step of the
  new session. Tracked on `state.steps_since_session_reset`.
- Cache hit-rate warning per SPEC §11: ccloop emits a `cache_warning`
  driver event when the per-step cache hit rate stays below 50% for
  three consecutive steps. The warning fires once per low-streak
  crossing — not on every subsequent low step — and resets when a
  step recovers above the threshold. Steps with no token usage (e.g.
  SDK init failures) don't move the streak. Tracked on
  `state.cache_low_streak`.
- `state.last_failure` carries the previous step's failure category and
  excerpt forward into the next step's `{{last_error}}` prompt block,
  so Claude course-corrects with the actual error text instead of a
  bare "previous step failed" notice. Cleared on success. Backfills to
  `null` when reading older `state.json` files.
- Default prompt template no longer inlines `SPEC.md` / `progress.md`;
  Claude reads them on demand. Pairs with SDK session resume so the
  files land in the prompt cache once and stay there.
- `StepFailure` type (`{ category: FailureCategory; excerpt: string }`)
  promoted out of inline shapes in `stepRecord.ts` and `state.ts` so
  the typed failure category is enforced at every write site.

### Changed
- `{{spec}}` and `{{progress}}` template vars are now lazy-loaded —
  the driver only reads `SPEC.md` / `progress.md` when the resolved
  template actually references them. The default template doesn't, so
  most runs skip these reads on the per-step hot path.
- Cache hit rate now counts `cache_creation_input_tokens` as a miss
  in the denominator. The previous formula inflated the rate to ~100%
  whenever the system prompt was cached and the new user turn was
  small.
- Sandbox profile (Linux + macOS) lets reads through across the host
  filesystem and scopes writes to CWD + `/tmp`. User-installed
  toolchains (mise, asdf, nvm, `~/.bun`, `~/.cargo`, Homebrew) resolve
  without enumeration. Network is allowed so package installers work;
  the boundary is filesystem scope, not exfiltration.
