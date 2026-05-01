# Tech debt

## Session compaction on context overflow (current behavior: hard rotate)

When `classifyStep` returns `context_overflow`, the driver clears
`state.session_id` so the next step starts a fresh session. The new
session re-reads SPEC.md and `.ccloop/progress.md` from disk per the
prompt template — but everything Claude learned in-flight (recent
diagnoses, half-finished edits, decisions deferred) is lost.

**TODO:** Replace the hard rotate with a summarize-then-rotate flow:

1. Detect impending or just-hit context overflow.
2. Issue a one-shot summarization query against the *expiring* session
   ("Summarize what you've done and what state things are in") before
   it disappears, capturing the model's own running picture.
3. Bake that summary into the next step's prompt template (a new
   `{{rotation_summary}}` slot, or appended to `last_error`) so the
   fresh session starts with continuity rather than blank slate.

Open questions: do we summarize before or after the failure (i.e. on
a soft-cap heuristic, or only on the failure itself)? If only on
failure, the poisoned session can't be summarized — we'd need a
recent-session snapshot from the *previous* successful step instead.
The `.ccloop/sdk-debug/step-NNNN/stream-*.jsonl` dumps could feed
this if `CCLOOP_SDK_DEBUG=1` is on; for prod we'd want the loop
itself to keep a small ring buffer of recent assistant outputs.

---

## Resolved

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

---

## Resolved

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
