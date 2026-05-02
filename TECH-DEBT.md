# Tech debt

## Resolved

### Session compaction on context overflow (resolved 2026-05-02)

The hard-rotate behavior is replaced with a summarize-then-rotate
flow on the *proactive* paths (step-cap, context_threshold). Right
before the driver clears `state.session_id`, it issues a one-shot
SDK query (`src/sdk/summarize.ts`) against the expiring session
asking for a 300-word self-summary: goal, what's done vs. in-flight,
decisions to respect, gotchas. The result lands in
`state.rotation_summary` and is rendered into the next step's prompt
under a `# Picking up from a rotated session` heading via the new
`{{rotation_summary}}` template slot. The driver clears the field
after one consumption so subsequent steps don't replay the same
summary every iteration.

The reactive `context_overflow` rotation deliberately skips
summarization — by the time we observe that signal the session is
already wedged, and any further query against it would hit the same
wall. For that path the next step still starts blank; the prompt
template's existing instruction to read SPEC.md and progress.md
from disk covers the gap.

A subagent-output ring buffer (so we can summarize *before* the
poisoned step) is a possible follow-up but not pursued — the
proactive path catches the case in practice well before the
reactive one fires.

### TUI flicker on content updates (resolved 2026-05-01)

Investigated and fixed by upgrading Ink 5 → 6 (which required
React 18 → 19). Ink 6 ships:

- **Synchronized output** (DEC mode 2026): the terminal buffers
  writes between begin/end markers so the frame swap is atomic.
  Automatic in supporting terminals (Kitty, WezTerm, Ghostty,
  recent Konsole/iTerm2).
- **`incrementalRendering`**: only emits ANSI for changed lines
  instead of clear+rewrite of the whole frame region.
- **`maxFps`**: built-in render throttle (default 30).
- **Concurrent rendering** (opt-in): React 19 concurrent root.

Also fixed the character-width handling issue we'd seen earlier.

Both options are wired up in `src/cli/run.ts` at the `render()`
call. The skip-if-unchanged guard around `ink.rerender()` is now
belt-and-suspenders — Ink throttles internally — but kept because
it still avoids React reconciliation work on no-op ticks.

If flicker resurfaces, suspects in order: (1) terminal doesn't
support DEC 2026 → upgrade terminal or accept; (2) Ink regression
→ pin version; (3) something writing to stdout outside Ink (we
already guard `process.stderr.write` to non-TTY mode).
