import { Box, Text, useInput, useStdin } from "ink";
import React, { useEffect, useRef, useState } from "react";
import { ScrollView, type ScrollViewRef } from "ink-scroll-view";
import {
  formatBar, formatCost, formatCountdown, formatDuration,
  formatPct, formatTokens,
} from "./format.ts";
import type { FocusTarget, TurnEvent, TuiViewModel } from "./types.ts";

export type MenuKey = "c" | "r" | "e" | "q";

export interface DashboardProps {
  view: TuiViewModel;
  /** When set, ESCALATED / GUARDRAIL_TRIP screens dispatch their
   *  hotkeys through this callback. Each TUI state filters to the
   *  keys it actually advertises (§9.6, §10.5). */
  onMenuKey?: (key: MenuKey) => void;
  /** Ctrl+C handler. Called once per Ctrl+C press; the CLI owns the
   *  press-counting / force-exit policy. We pass `exitOnCtrlC: false`
   *  to Ink's `render()` so this is the single Ctrl+C path — without
   *  it, Ink would unmount the React tree on first press while our
   *  loop kept running. */
  onInterrupt?: () => void;
}

const FOCUS_ORDER: FocusTarget[] = ["now", "log"];

export function Dashboard({
  view, onMenuKey, onInterrupt,
}: DashboardProps): React.ReactElement {
  useCtrlC(onInterrupt);
  switch (view.state) {
    case "STARTING": return <Starting view={view} />;
    case "RUNNING":  return <Running view={view} />;
    case "PAUSED":   return <Paused view={view} />;
    case "ESCALATED": return <Escalated view={view} onMenuKey={onMenuKey} />;
    case "GUARDRAIL_TRIP": return <GuardrailTrip view={view} onMenuKey={onMenuKey} />;
    case "DONE": return <Done view={view} />;
  }
}

/** Catch Ctrl+C ourselves. Ink is configured with
 *  `exitOnCtrlC: false`; without this hook the keystroke would be
 *  swallowed silently. */
function useCtrlC(onInterrupt: (() => void) | undefined): void {
  const kb = useKeyboardAvailable();
  useInput((input, key) => {
    if (key.ctrl && input === "c") onInterrupt?.();
  }, { isActive: kb && !!onInterrupt });
}

/** True when the runtime can put stdin into raw mode. Without this,
 *  Ink's `useInput` throws on mount (e.g. non-TTY stdin in CI, some
 *  IDE integrated terminals). All key-handling hooks gate `isActive`
 *  on this so ccloop degrades gracefully to a read-only dashboard.
 *
 *  Note the strict `=== true` coercion: Ink reports `isRawModeSupported`
 *  as `undefined` (not `false`) when stdin isn't a TTY, and Ink's
 *  `useInput` short-circuits only on the literal `false`. */
function useKeyboardAvailable(): boolean {
  const { isRawModeSupported } = useStdin();
  return isRawModeSupported === true;
}

function useMenuKey(
  allowed: ReadonlyArray<MenuKey>,
  onMenuKey: ((key: MenuKey) => void) | undefined,
): void {
  const kb = useKeyboardAvailable();
  useInput((input) => {
    if (!onMenuKey) return;
    const ch = input.toLowerCase() as MenuKey;
    if (allowed.includes(ch)) onMenuKey(ch);
  }, { isActive: kb && !!onMenuKey });
}

/** Tab / Shift-Tab focus cycling. */
function useFocusCycle(
  focus: FocusTarget,
  setFocus: (f: FocusTarget) => void,
  available: ReadonlyArray<FocusTarget>,
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

// ===== bordered pane primitives =====

type PaneRole = "static" | "focusable";

interface PaneProps {
  title: string;
  role?: PaneRole;
  focused?: boolean;
  titleRight?: string;
  flexGrow?: number;
  height?: number;
  children?: React.ReactNode;
}

function Pane({
  title, role = "static", focused = false,
  titleRight, flexGrow, height, children,
}: PaneProps): React.ReactElement {
  const isHot = role === "focusable" && focused;
  const borderStyle = isHot ? "double" : "round";
  const borderColor = isHot
    ? "cyan"
    : (role === "focusable" ? "gray" : undefined);

  return (
    <Box
      flexDirection="column"
      borderStyle={borderStyle}
      borderColor={borderColor}
      flexGrow={flexGrow}
      height={height}
      paddingX={1}
      overflow="hidden"
    >
      <Box>
        <Text bold color={isHot ? "cyan" : undefined}>{title}</Text>
        {titleRight ? (
          <>
            <Box flexGrow={1} />
            <Text dimColor>{titleRight}</Text>
          </>
        ) : null}
      </Box>
      {children}
    </Box>
  );
}

// ===== scrollable pane shell =====

interface ScrollKeys {
  /** Scrolling for this pane is active only when focused === true. */
  focused: boolean;
  /** True while content is auto-tailing the bottom; flips to false on
   *  manual scroll-up; resets on Home/End or when the user scrolls
   *  back to the bottom. Used to gate auto-scroll-to-bottom on new
   *  content. */
  userScrolledRef: React.MutableRefObject<boolean>;
  scrollRef: React.RefObject<ScrollViewRef>;
}

function useScrollKeys({ focused, userScrolledRef, scrollRef }: ScrollKeys): void {
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

function useAutoTail(
  contentLength: number,
  userScrolledRef: React.MutableRefObject<boolean>,
  scrollRef: React.RefObject<ScrollViewRef>,
): void {
  const last = useRef(contentLength);
  useEffect(() => {
    if (contentLength !== last.current) {
      last.current = contentLength;
      if (!userScrolledRef.current) scrollRef.current?.scrollToBottom();
    }
  }, [contentLength, userScrolledRef, scrollRef]);
}

// ===== content =====

function Header({ view }: { view: TuiViewModel }): React.ReactElement {
  const stateColor =
    view.state === "RUNNING" ? "green"
    : view.state === "PAUSED" ? "cyan"
    : view.state === "ESCALATED" ? "red"
    : view.state === "GUARDRAIL_TRIP" ? "magenta"
    : view.state === "DONE" ? "green"
    : "yellow";
  const status = cadenceLabel(view);
  return (
    <Pane title={`ccloop · ${view.state} ${view.heartbeat}`}>
      <Box>
        <Text color={stateColor}>step {view.step}</Text>
        {status ? <Text>  ·  {status}</Text> : null}
        <Text>  ·  elapsed {formatDuration(view.elapsedMs)}</Text>
      </Box>
      <Box>
        <Text>cost {formatCost(view.rollingCostUsd)}  ·  in {formatTokens(view.rollingTokensIn)} / out {formatTokens(view.rollingTokensOut)}  ·  cache {formatPct(view.averageCacheHitRate)}</Text>
      </Box>
      <Text dimColor>{view.cwd}</Text>
    </Pane>
  );
}

/** Header status segment: "cadence X/Y s" while in a cadence wait,
 *  empty otherwise. The TUI rerenders on the heartbeat tick (1 Hz),
 *  which is enough for a per-second countdown. */
function cadenceLabel(view: TuiViewModel): string {
  if (!view.cadenceWait) return "";
  const elapsedMs = Date.now() - Date.parse(view.cadenceWait.startedAt);
  const elapsedS = Math.max(0, Math.floor(elapsedMs / 1000));
  const totalS = Math.max(1, Math.floor(view.cadenceWait.totalMs / 1000));
  const clamped = Math.min(elapsedS, totalS);
  return `cadence ${clamped}/${totalS}s`;
}

function UsagePane({ view }: { view: TuiViewModel }): React.ReactElement {
  if (!view.usage) {
    return (
      <Pane title="usage">
        <Text dimColor>(no data)</Text>
      </Pane>
    );
  }
  const { five_hour, seven_day } = view.usage;
  return (
    <Pane title="usage">
      <Text>5h    {formatBar(five_hour.utilization)} {five_hour.utilization.toFixed(1)}%  resets {formatCountdown(five_hour.resets_at)}</Text>
      <Text>week  {formatBar(seven_day.utilization)} {seven_day.utilization.toFixed(1)}%  resets {formatCountdown(seven_day.resets_at)}</Text>
    </Pane>
  );
}

interface FocusableProps {
  view: TuiViewModel;
  focus: FocusTarget;
}

function NowPane({ view, focus }: FocusableProps): React.ReactElement {
  const ref = useRef<ScrollViewRef>(null);
  const userScrolledRef = useRef(false);
  const focused = focus === "now";
  useAutoTail(view.nowContent.length, userScrolledRef, ref);
  useScrollKeys({ focused, userScrolledRef, scrollRef: ref });

  const titleRight = focused
    ? (userScrolledRef.current ? "↑↓ ⇞⇟ · G to live" : "↑↓ ⇞⇟ g/G · live")
    : "tab to focus";
  const title = nowTitle(view);

  if (view.nowContent.length === 0) {
    return (
      <Pane title={title} role="focusable" focused={focused}
            titleRight={titleRight} flexGrow={1}>
        <Text dimColor>(waiting for the next turn…)</Text>
      </Pane>
    );
  }

  return (
    <Pane title={title} role="focusable" focused={focused}
          titleRight={titleRight} flexGrow={1}>
      <ScrollView ref={ref}>
        {view.nowContent.map((e, i) => (
          <TurnEventRow key={`${i}-${e.kind}`} event={e} />
        ))}
      </ScrollView>
    </Pane>
  );
}

function nowTitle(view: TuiViewModel): string {
  const last = view.nowContent[view.nowContent.length - 1];
  if (!last) return "now";
  switch (last.kind) {
    case "tool_use":
      return `now · ▸ ${last.tool} · ${last.summary}`;
    case "tool_result":
      return `now · ${last.ok ? "✓" : "✗"} ${last.tool}`;
    case "assistant_text":
      return "now · ◌ thinking";
    case "turn_start":
      return `now · turn ${last.turn}`;
    case "idle":
      return `now · ${last.note}`;
  }
}

function TurnEventRow({ event }: { event: TurnEvent }): React.ReactElement {
  switch (event.kind) {
    case "turn_start":
      return <Text dimColor>── turn {event.turn} ──</Text>;
    case "assistant_text":
      return <Text>{event.text}</Text>;
    case "tool_use":
      return <Text color="cyan">▸ {event.tool} · {event.summary}</Text>;
    case "tool_result":
      return (
        <Text color={event.ok ? "green" : "red"}>
          {event.ok ? "✓" : "✗"} {event.tool}: {event.excerpt}
        </Text>
      );
    case "idle":
      return <Text dimColor>· {event.note}</Text>;
  }
}

function LogPane({ view, focus }: FocusableProps): React.ReactElement {
  const ref = useRef<ScrollViewRef>(null);
  const userScrolledRef = useRef(false);
  const focused = focus === "log";
  useAutoTail(view.logContent.length, userScrolledRef, ref);
  useScrollKeys({ focused, userScrolledRef, scrollRef: ref });

  const titleRight = focused ? "↑↓ ⇞⇟ g/G" : "tab to focus";

  if (view.logContent.length === 0) {
    return (
      <Pane title="log" role="focusable" focused={focused}
            titleRight={titleRight} height={10}>
        <Text dimColor>(no events)</Text>
      </Pane>
    );
  }
  return (
    <Pane title="log" role="focusable" focused={focused}
          titleRight={titleRight} height={10}>
      <ScrollView ref={ref}>
        {view.logContent.map((e, i) => (
          <Text key={`${i}-${e}`} dimColor>{e}</Text>
        ))}
      </ScrollView>
    </Pane>
  );
}

function Controls({ hint }: { hint: string }): React.ReactElement {
  return <Text dimColor>{hint}</Text>;
}

// ===== state-specific layouts =====

function Starting({ view }: { view: TuiViewModel }): React.ReactElement {
  return (
    <Box flexDirection="column">
      <Pane title={`ccloop · STARTING ${view.heartbeat}`}>
        <Text dimColor>validating SPEC.md, loading config, opening SDK…</Text>
        <Text dimColor>{view.cwd}</Text>
      </Pane>
      <Controls hint={view.controlsHint} />
    </Box>
  );
}

function useFocusableLayout(
  view: TuiViewModel,
  available: ReadonlyArray<FocusTarget>,
): FocusTarget {
  const initial = available.includes(view.focus) ? view.focus : (available[0] ?? "now");
  const [focus, setFocus] = useState<FocusTarget>(initial);
  useFocusCycle(focus, setFocus, available);
  return focus;
}

function Running({ view }: { view: TuiViewModel }): React.ReactElement {
  const focus = useFocusableLayout(view, FOCUS_ORDER);
  return (
    <Box flexDirection="column" flexGrow={1}>
      <Header view={view} />
      <NowPane view={view} focus={focus} />
      <UsagePane view={view} />
      <LogPane view={view} focus={focus} />
      <Controls hint={view.controlsHint} />
    </Box>
  );
}

function Paused({ view }: { view: TuiViewModel }): React.ReactElement {
  const focus = useFocusableLayout(view, ["now", "log"]);
  return (
    <Box flexDirection="column" flexGrow={1}>
      <Header view={view} />
      <Pane title="paused">
        <Text>reason:    {view.pause?.reason ?? "—"}</Text>
        <Text>resumes in: {view.pause ? formatCountdown(view.pause.until) : "—"}</Text>
      </Pane>
      <UsagePane view={view} />
      <NowPane view={view} focus={focus} />
      <LogPane view={view} focus={focus} />
      <Controls hint={view.controlsHint} />
    </Box>
  );
}

function Escalated({
  view, onMenuKey,
}: { view: TuiViewModel; onMenuKey?: (k: MenuKey) => void }): React.ReactElement {
  useMenuKey(["c", "r", "e", "q"], onMenuKey);
  // Log is scrollable so the user can investigate before deciding.
  // Now is hidden — there's no live stream during an escalation.
  const focus = useFocusableLayout(view, ["log"]);
  return (
    <Box flexDirection="column" flexGrow={1}>
      <Header view={view} />
      <Pane title="escalated">
        <Text>reason: {view.escalation?.reason ?? "—"}</Text>
      </Pane>
      <LogPane view={view} focus={focus} />
      <Controls hint={view.controlsHint} />
    </Box>
  );
}

function GuardrailTrip({
  view, onMenuKey,
}: { view: TuiViewModel; onMenuKey?: (k: MenuKey) => void }): React.ReactElement {
  useMenuKey(["q", "e"], onMenuKey);
  return (
    <Box flexDirection="column">
      <Header view={view} />
      <Pane title="guardrail trip">
        <Text>which:  {view.guardrail?.which ?? "—"}</Text>
        <Text>limit:  {String(view.guardrail?.limit ?? "—")}</Text>
        <Text>actual: {String(view.guardrail?.actual ?? "—")}</Text>
      </Pane>
      <Controls hint={view.controlsHint} />
    </Box>
  );
}

function Done({ view }: { view: TuiViewModel }): React.ReactElement {
  const focus = useFocusableLayout(view, ["log"]);
  return (
    <Box flexDirection="column" flexGrow={1}>
      <Header view={view} />
      <Pane title="done">
        <Text>final commit: {view.done?.finalCommitSha ?? "—"}</Text>
      </Pane>
      <LogPane view={view} focus={focus} />
      <Controls hint={view.controlsHint} />
    </Box>
  );
}
