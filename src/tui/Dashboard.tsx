import { Box, Text } from "ink";
import React, { useRef, useState } from "react";
import { ScrollView, type ScrollViewRef } from "ink-scroll-view";
import {
  formatCost, formatCountdown, formatDuration,
  formatPct, formatTokens,
} from "./format.ts";
import type { FocusTarget, TurnEvent, TuiViewModel } from "./types.ts";
import {
  Frame,
  Pane,
  Controls,
  Header,
  UsagePane,
  useCtrlC,
  useFocusCycle,
  useScrollKeys,
  useAutoTail,
  useMenuKey,
  usePauseKey,
  type MenuKey,
} from "./shared/index.ts";

export type { MenuKey };

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
  /** Operator pause toggle. Active in RUNNING / OPERATOR_PAUSED only;
   *  bound to the lowercase `p` key. */
  onTogglePause?: () => void;
}

const FOCUS_ORDER: readonly FocusTarget[] = ["now", "log"];

export function Dashboard({
  view, onMenuKey, onInterrupt, onTogglePause,
}: DashboardProps): React.ReactElement {
  useCtrlC(onInterrupt);
  // Pause hotkey is only live while the run is in a state where
  // pausing is meaningful. Other states (escalated/guardrail/done)
  // either have their own menu or are terminal.
  const pauseActive = view.state === "RUNNING" || view.state === "OPERATOR_PAUSED";
  usePauseKey(pauseActive, onTogglePause);
  return <Frame>{pickScreen(view, onMenuKey)}</Frame>;
}

function pickScreen(
  view: TuiViewModel,
  onMenuKey?: (k: MenuKey) => void,
): React.ReactElement {
  switch (view.state) {
    case "STARTING": return <Starting view={view} />;
    case "RUNNING":  return <Running view={view} />;
    case "PAUSED":   return <Paused view={view} />;
    case "OPERATOR_PAUSED": return <OperatorPaused view={view} />;
    case "ESCALATED": return <Escalated view={view} onMenuKey={onMenuKey} />;
    case "GUARDRAIL_TRIP": return <GuardrailTrip view={view} onMenuKey={onMenuKey} />;
    case "DONE": return <Done view={view} />;
  }
}

// ===== content =====

function BuildLoopHeader({ view }: { view: TuiViewModel }): React.ReactElement {
  const stateColor =
    view.state === "RUNNING" ? "green"
    : view.state === "PAUSED" ? "cyan"
    : view.state === "OPERATOR_PAUSED" ? "yellow"
    : view.state === "ESCALATED" ? "red"
    : view.state === "GUARDRAIL_TRIP" ? "magenta"
    : view.state === "DONE" ? "green"
    : "yellow";
  const status = cadenceLabel(view);
  return (
    <Header
      state={view.state}
      stateColor={stateColor}
      heartbeat={view.heartbeat}
      step={view.step}
      status={status || undefined}
      elapsedMs={view.elapsedMs}
      checklist={view.checklist}
      rollingCostUsd={view.rollingCostUsd}
      rollingTokensIn={view.rollingTokensIn}
      rollingTokensOut={view.rollingTokensOut}
      averageCacheHitRate={view.averageCacheHitRate}
      cacheLowStreak={view.cacheLowStreak}
      cwd={view.cwd}
    />
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
  const remaining = Math.max(0, totalS - clamped);
  return `next step in ${remaining}s (${clamped}/${totalS})`;
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
            titleRight={titleRight} flexGrow={1} flexShrink={1}>
        <Text dimColor>(waiting for the next turn…)</Text>
      </Pane>
    );
  }

  return (
    <Pane title={title} role="focusable" focused={focused}
          titleRight={titleRight} flexGrow={1} flexShrink={1}>
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
  available: readonly FocusTarget[],
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
      <BuildLoopHeader view={view} />
      <NowPane view={view} focus={focus} />
      <UsagePane usage={view.usage} />
      <LogPane view={view} focus={focus} />
      <Controls hint={view.controlsHint} />
    </Box>
  );
}

function Paused({ view }: { view: TuiViewModel }): React.ReactElement {
  const focus = useFocusableLayout(view, ["now", "log"]);
  return (
    <Box flexDirection="column" flexGrow={1}>
      <BuildLoopHeader view={view} />
      <Pane title="paused">
        <Text>reason:    {view.pause?.reason ?? "—"}</Text>
        <Text>resumes in: {view.pause ? formatCountdown(view.pause.until) : "—"}</Text>
      </Pane>
      <UsagePane usage={view.usage} />
      <NowPane view={view} focus={focus} />
      <LogPane view={view} focus={focus} />
      <Controls hint={view.controlsHint} />
    </Box>
  );
}

/** Operator-initiated pause. Same layout as RUNNING — the only
 *  difference is the header colour (yellow), the controls hint
 *  ("p resume"), and the small banner pane explaining what's
 *  happening. The loop is parked at the orchestrator's pause-gate
 *  check; the in-flight step + cadence sleep have already
 *  completed by the time this screen is visible. */
function OperatorPaused({ view }: { view: TuiViewModel }): React.ReactElement {
  const focus = useFocusableLayout(view, FOCUS_ORDER);
  return (
    <Box flexDirection="column" flexGrow={1}>
      <BuildLoopHeader view={view} />
      <Pane title="paused (operator)">
        <Text color="yellow">paused between loops — press <Text bold>p</Text> to resume</Text>
        <Text dimColor>the in-flight step finished; ccloop will start the next step on resume</Text>
      </Pane>
      <NowPane view={view} focus={focus} />
      <UsagePane usage={view.usage} />
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
      <BuildLoopHeader view={view} />
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
      <BuildLoopHeader view={view} />
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
      <BuildLoopHeader view={view} />
      <Pane title="done">
        <Text>final commit: {view.done?.finalCommitSha ?? "—"}</Text>
      </Pane>
      <LogPane view={view} focus={focus} />
      <Controls hint={view.controlsHint} />
    </Box>
  );
}
