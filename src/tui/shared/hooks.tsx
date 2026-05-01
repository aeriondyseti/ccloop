/**
 * Shared hooks for TUI components (both build and design loops).
 */

import { useEffect, useRef, useState } from "react";
import { useInput, useStdin, useStdout } from "ink";
import type { ScrollViewRef } from "ink-scroll-view";
import { appendFileSync, mkdirSync } from "node:fs";

// ===== Terminal size =====

export function useTerminalSize(): { rows: number; cols: number } {
  const { stdout } = useStdout();
  const [size, setSize] = useState(() => ({
    rows: stdout?.rows ?? 24,
    cols: stdout?.columns ?? 80,
  }));
  useEffect(() => {
    if (!stdout) return;
    const onResize = (): void => {
      setSize({ rows: stdout.rows, cols: stdout.columns });
    };
    stdout.on("resize", onResize);
    return () => { stdout.off("resize", onResize); };
  }, [stdout]);
  return size;
}

// ===== Keyboard availability =====

/** True when the runtime can put stdin into raw mode. Without this,
 *  Ink's `useInput` throws on mount (e.g. non-TTY stdin in CI, some
 *  IDE integrated terminals). All key-handling hooks gate `isActive`
 *  on this so ccloop degrades gracefully to a read-only dashboard.
 *
 *  Note the strict `=== true` coercion: Ink reports `isRawModeSupported`
 *  as `undefined` (not `false`) when stdin isn't a TTY, and Ink's
 *  `useInput` short-circuits only on the literal `false`. */
export function useKeyboardAvailable(): boolean {
  const { isRawModeSupported } = useStdin();
  return isRawModeSupported === true;
}

// ===== Ctrl+C handling =====

/** Catch Ctrl+C ourselves. Ink is configured with
 *  `exitOnCtrlC: false`; without this hook the keystroke would be
 *  swallowed silently. */
export function useCtrlC(onInterrupt: (() => void) | undefined): void {
  const kb = useKeyboardAvailable();
  useInput((input, key) => {
    debugKey("ctrlc-watch", input, key);
    if (key.ctrl && input === "c") onInterrupt?.();
  }, { isActive: kb && !!onInterrupt });
}

// ===== Focus cycling (Tab/Shift-Tab) =====

/** Tab / Shift-Tab focus cycling. */
export function useFocusCycle<T extends string>(
  focus: T,
  setFocus: (f: T) => void,
  available: ReadonlyArray<T>,
): void {
  const kb = useKeyboardAvailable();
  useInput((_input, key) => {
    if (!key.tab) return;
    const idx = available.indexOf(focus);
    if (idx < 0) return;
    const next = key.shift
      ? available[(idx - 1 + available.length) % available.length]
      : available[(idx + 1) % available.length];
    if (next) setFocus(next);
  }, { isActive: kb });
}

// ===== Scrollable pane keyboard handling =====

interface ScrollKeys {
  /** Scrolling for this pane is active only when focused === true. */
  focused: boolean;
  /** True while content is auto-tailing the bottom; flips to false on
   *  manual scroll-up; resets on Home/End or when the user scrolls
   *  back to the bottom. Used to gate auto-scroll-to-bottom on new
   *  content. */
  userScrolledRef: React.RefObject<boolean>;
  scrollRef: React.RefObject<ScrollViewRef | null>;
}

export function useScrollKeys({ focused, userScrolledRef, scrollRef }: ScrollKeys): void {
  const kb = useKeyboardAvailable();
  useInput((_input, key) => {
    if (!focused) return;
    const s = scrollRef.current;
    if (!s) return;
    if (key.upArrow)   { s.scrollBy(-1); userScrolledRef.current = true; return; }
    if (key.downArrow) {
      s.scrollBy(1);
      // If we end up at the bottom, re-engage auto-tail.
      const offset = s.getScrollOffset();
      const bottom = s.getBottomOffset();
      userScrolledRef.current = offset < bottom - 1;
      return;
    }
    if (key.pageUp)    { s.scrollBy(-s.getViewportHeight()); userScrolledRef.current = true; return; }
    if (key.pageDown)  {
      s.scrollBy(s.getViewportHeight());
      const offset = s.getScrollOffset();
      const bottom = s.getBottomOffset();
      userScrolledRef.current = offset < bottom - 1;
      return;
    }
    // Ink's Key type doesn't expose Home/End uniformly across
    // terminals, so we accept lowercase `g` / uppercase `G` as
    // top/bottom — same convention as less / vim.
    if (_input === "g") { s.scrollToTop(); userScrolledRef.current = true; return; }
    if (_input === "G") { s.scrollToBottom(); userScrolledRef.current = false; return; }
  }, { isActive: kb && focused });
}

export function useAutoTail(
  contentLength: number,
  userScrolledRef: React.RefObject<boolean>,
  scrollRef: React.RefObject<ScrollViewRef | null>,
): void {
  const last = useRef(contentLength);
  useEffect(() => {
    if (contentLength !== last.current) {
      last.current = contentLength;
      if (!userScrolledRef.current) scrollRef.current?.scrollToBottom();
    }
  }, [contentLength, userScrolledRef, scrollRef]);
}

// ===== Menu key handling =====

export type MenuKey = "c" | "r" | "e" | "q";

export function useMenuKey(
  allowed: ReadonlyArray<MenuKey>,
  onMenuKey: ((key: MenuKey) => void) | undefined,
): void {
  const kb = useKeyboardAvailable();
  useInput((input, key) => {
    debugKey(`menu(allowed=${allowed.join("")},active=${!!onMenuKey})`, input, key);
    if (!onMenuKey) return;
    // Ignore modified keys: Ctrl-C arrives as input="c" and would
    // otherwise be parsed as the "continue" menu choice. Plain
    // letter keys come through with no modifiers set.
    if (key.ctrl || key.meta) return;
    const ch = input.toLowerCase() as MenuKey;
    if (allowed.includes(ch)) onMenuKey(ch);
  }, { isActive: kb && !!onMenuKey });
}

// ===== Keyboard debugging =====

/** Opt-in keystroke logger. Enable with `CCLOOP_TUI_DEBUG=1`. Writes
 *  one JSONL line per dispatched key to `./.ccloop/tui-debug.log`,
 *  including which hook saw it. Used to diagnose "key doesn't reach
 *  the handler" reports without instrumenting prod conditionally —
 *  the no-op path is a single env-var read. */
const TUI_DEBUG = process.env.CCLOOP_TUI_DEBUG === "1";

export function debugKey(
  source: string,
  input: string,
  key: Record<string, unknown>,
): void {
  if (!TUI_DEBUG) return;
  try {
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      source,
      input,
      inputCodes: [...input].map((c) => c.charCodeAt(0)),
      key: {
        ctrl: key.ctrl, meta: key.meta, shift: key.shift,
        upArrow: key.upArrow, downArrow: key.downArrow,
        tab: key.tab, return: key.return, escape: key.escape,
      },
    }) + "\n";
    // Sync append so we don't lose entries on crash, and so multiple
    // hooks logging in the same dispatch don't race. Cheap; off by
    // default.
    mkdirSync(".ccloop", { recursive: true });
    appendFileSync(".ccloop/tui-debug.log", line);
  } catch {
    // Logging must never break the TUI.
  }
}
