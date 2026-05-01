# Tech debt

## TUI flicker on content updates

**Symptom.** When `now` or `log` panes receive new content, the
affected region briefly flickers. Severity correlates with how much
of the visible region changes per paint, not with tick rate.

**Diagnosis (2026-05-01).** Ruled out, in order:

- `ink-scroll-view`: swapping `LogPane` to a plain `<Box>` +
  tail-slice did not change flicker. Both panes flickered equally.
- Tick rate: raising `TUI_TICK_MS` from 250 → 1000 didn't reduce
  flicker proportionally. Flicker is per visible paint, not per
  tick.
- Layout shift: `flexShrink={0}` default on `Pane` (kept) fixed an
  unrelated problem where `NowPane` content overflow was squeezing
  sibling panes — but didn't affect flicker.

**Root cause.** Ink's render strategy on a frame change is
clear-region + rewrite-region. Tail-pinned panes (`LogPane` slice,
`NowPane` auto-tail) shift every visible line on each append, so
each "small" content update is in fact a full-window rewrite. The
brief blank moment between clear and rewrite is the visible
flicker. Structural to Ink, not a fixable bug at the React-tree
level.

**Mitigations that don't work.**

- Memoize / skip equal-frame rerenders: the flickering paints are
  the necessary ones, so skipping doesn't help.
- Reduce visible window: still a full-window shift on append.
- Cap `nowBuffer`: reduces reconciliation cost, paint cost
  identical.

**Real fixes.**

1. Restructure log as Ink `<Static>` (append-only, written above
   the live region — breaks the bordered-pane layout).
2. Switch the renderer to a framebuffer-diffing engine (Rezi /
   Zireael, notcurses, ratatui-via-WASM). Emits ANSI only for
   changed cells, no clear-then-rewrite. Estimated 3–5 focused
   days for a Rezi port, plus ongoing pre-alpha API risk until
   Rezi stabilizes. See conversation 2026-05-01 for the port
   sketch.
3. Accept the flicker for now.

Current decision: accept. Revisit when Rezi reaches beta or if a
user reports flicker as a blocker.
