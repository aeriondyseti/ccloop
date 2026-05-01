# Tech debt

(none currently tracked)

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
