# DONE

The design-loop feature described at `./SPEC.md` is implemented.
Each numbered Verification Requirement is met as follows.

## 1. All SPEC.md checkboxes complete

`grep "^- \[ \]" SPEC.md` returns no lines; `grep -c "^- \[x\]"
SPEC.md` is 15. The full audit in iteration 1 confirmed each item
was actually delivered (not just marked) — several were already
ticked from prior recovery commits and re-verified against the
code; the unchecked items (`ccloop design` subcommand, two-pane
TUI, graceful shutdown, bare-`ccloop` auto-routing, tests,
documentation) were closed out across commits `8b286f9`, `06276af`,
`fb2ff18`, `2d90895`, `74db108`, and `abd256c`.

## 2. All tests pass (`bun test`)

`bun test` reports `526 pass / 0 fail / 1063 expect() calls` across
58 files. The pre-feature baseline was 488 tests; this branch adds
38 new tests across `src/cli/dispatch.test.ts` (route + auto-routing),
`src/design/orchestrator.test.ts` (accept / abort / validation /
resume), `src/design/shutdown.test.ts` (signal + force-abort +
summary file write), `src/design/e2e.test.ts` (empty + populated
fixtures), and `src/tui/design-dashboard.test.tsx` (two-pane layout,
focus cycling, ask_user / confirm / input widgets).

## 3. Typecheck passes

`bun run typecheck` (which invokes `tsc --noEmit`) exits clean with
no diagnostics. All new files type against
`@anthropic-ai/claude-agent-sdk@^0.1.0` and the existing internal
types.

## 4. End-to-end against an empty fixture

`src/design/e2e.test.ts` "ccloop design — empty fixture" instantiates
a temp directory with no source files, runs `runDesignSession()`
against a scripted SDK that emits a `Write` tool_use producing a
fully-formed draft, then drives `/accept` through the orchestrator.
The test asserts `outcome === "accepted"`, that `./SPEC.md` is
created at the fixture root with `## Vision` and `## Verification
Requirements` sections, that the build-loop launch offer surfaces
in the transcript, and that `validateSpec` (run inside `acceptDraft`)
passed before promotion.

## 5. End-to-end against a populated fixture

`src/design/e2e.test.ts` "ccloop design — populated fixture" seeds
the fixture with `main.ts` and `README.md`, runs a scripted SDK
that emits `Read`/`Grep` tool uses (visible in the transcript) and
a `Write` tool_use producing a draft that names those files, then
drives `/accept`. The test asserts the promoted `./SPEC.md` contains
"main.ts" and "README.md", and that `tool:Read:main.ts`,
`tool:Read:README.md`, and `tool:Grep:hello` all appear in the
recorded transcript log.

## 6. Graceful shutdown produces non-empty `last-session.md`

`src/design/shutdown.test.ts` "summary turn produces a non-empty
last-session.md on disk (VR §6)" trips `requestGraceful()` before
the user-input wait, runs the orchestrator with a scripted SDK
whose summary turn writes `./.ccloop/design/last-session.md` (as
the real `Write` tool does in production — the design approver
hook permits writes under `./.ccloop/design/`), and asserts the
file exists, has length > 0, and contains the expected body. The
two-tier SIGINT contract (graceful first hit, force-abort second
hit within 2s) is also verified end-to-end via
`forceAbort during SDK call surfaces as aborted, not error`.

## 7. Build loop's existing tests still pass

The shared-TUI extraction landed in earlier recovery commits before
this branch; the build-loop tests under `src/tui/Dashboard.tsx`,
`src/tui/projector.test.ts`, `src/tui/format.test.ts`,
`src/tui/run-wiring.test.tsx`, `src/tui/escalated-keys.test.tsx`,
the orchestrator/loop suites, the SDK suites, and the config /
state / sandbox suites are all green in the same `bun test` run
that exercises the new design-loop suites — no fork, no skips, no
regressions.
