/**
 * Two-pane Ink dashboard for `ccloop design`.
 *
 * Layout:
 *   ┌─ ccloop design · <state> ─────────────────────────────┐
 *   │ elapsed · cost · tokens · cwd                         │
 *   ├─── transcript (left, focusable, scroll) ─┬── draft ──┤
 *   │ assistant prose, tool uses, info/error   │ live spec │
 *   │ … then ask_user / confirm / input prompt │ contents  │
 *   └──────────────────────────────────────────┴───────────┘
 *      Tab to switch panes · /accept · /abort · Ctrl+C
 */

import { Box, Text, useInput } from "ink";
import { ScrollView, type ScrollViewRef } from "ink-scroll-view";
import React, { useRef, useState, useSyncExternalStore } from "react";
import {
  Frame, Pane, Header, useFocusCycle, useScrollKeys, useAutoTail,
  useKeyboardAvailable, useCtrlC,
} from "./shared/index.ts";
import type { DesignTuiBridge, TranscriptEntry } from "./design-bridge.ts";

type FocusTarget = "transcript" | "draft";
const FOCUS_ORDER: ReadonlyArray<FocusTarget> = ["transcript", "draft"];

export interface DesignDashboardProps {
  bridge: DesignTuiBridge;
  cwd: string;
  /** Called on Ctrl+C; the CLI installs a SIGINT handler upstream
   *  too — this hook lets the TUI surface the event in-process. */
  onInterrupt?: () => void;
}

export function DesignDashboard({ bridge, cwd, onInterrupt }: DesignDashboardProps): React.ReactElement {
  const state = useSyncExternalStore(bridge.subscribe, bridge.getState, bridge.getState);
  const [focus, setFocus] = useState<FocusTarget>("transcript");
  useFocusCycle<FocusTarget>(focus, setFocus, FOCUS_ORDER);
  useCtrlC(onInterrupt);

  const elapsedMs = Date.now() - state.startedAt;
  const isAsking = state.pendingAsk !== null;
  const isConfirming = state.pendingConfirm !== null;
  const isInputting = state.pendingInput !== null;
  const headerState = isAsking
    ? "ASKING"
    : isConfirming
      ? "CONFIRMING"
      : isInputting
        ? "WAITING"
        : "DESIGNING";
  const stateColor = isAsking || isConfirming ? "yellow" : "cyan";

  return (
    <Frame>
      <Header
        loopLabel="ccloop design"
        state={headerState}
        stateColor={stateColor}
        elapsedMs={elapsedMs}
        cwd={cwd}
      />
      <Box flexDirection="row" flexGrow={1} flexShrink={1}>
        <Box flexDirection="column" flexGrow={1} flexShrink={1} width="50%">
          <TranscriptPane state={state} focused={focus === "transcript"} bridge={bridge} />
        </Box>
        <Box flexDirection="column" flexGrow={1} flexShrink={1} width="50%">
          <DraftPane draft={state.draft} focused={focus === "draft"} />
        </Box>
      </Box>
      <Text dimColor>
        Tab/Shift-Tab cycle panes · ↑↓ ⇞⇟ g/G scroll · Enter submit ·
        type freeform or /accept · /abort · Ctrl+C exit
      </Text>
    </Frame>
  );
}

interface TranscriptPaneProps {
  state: ReturnType<DesignTuiBridge["getState"]>;
  focused: boolean;
  bridge: DesignTuiBridge;
}

function TranscriptPane({ state, focused, bridge }: TranscriptPaneProps): React.ReactElement {
  const ref = useRef<ScrollViewRef>(null);
  const userScrolledRef = useRef(false);
  // The transcript grows as the agent emits text, the user replies, and
  // info/error banners arrive. Always tail unless the user manually
  // scrolled up.
  useAutoTail(state.transcript.length, userScrolledRef, ref);
  // Don't grab arrow keys when an interactive widget is active — the
  // widget owns those keys.
  const widgetActive = state.pendingAsk !== null || state.pendingConfirm !== null;
  useScrollKeys({ focused: focused && !widgetActive, userScrolledRef, scrollRef: ref });

  const titleRight = focused ? "tab to draft" : "tab to focus";

  return (
    <Pane title="transcript" role="focusable" focused={focused}
          titleRight={titleRight} flexGrow={1} flexShrink={1}>
      <Box flexDirection="column" flexGrow={1} flexShrink={1}>
        <Box flexDirection="column" flexGrow={1} flexShrink={1}>
          <ScrollView ref={ref}>
            {state.transcript.map((e, i) => (
              <TranscriptRow key={i} entry={e} />
            ))}
          </ScrollView>
        </Box>
        {state.pendingAsk ? (
          <AskWidget bridge={bridge} />
        ) : state.pendingConfirm ? (
          <ConfirmWidget bridge={bridge} />
        ) : state.pendingInput ? (
          <InputWidget bridge={bridge} />
        ) : (
          <Text dimColor>(agent is working…)</Text>
        )}
      </Box>
    </Pane>
  );
}

function TranscriptRow({ entry }: { entry: TranscriptEntry }): React.ReactElement {
  switch (entry.kind) {
    case "assistant":
      return <Text>{entry.text}</Text>;
    case "tool": {
      const summary = entry.summary ? `: ${entry.summary}` : "";
      return <Text dimColor>  · {entry.name}{summary}</Text>;
    }
    case "info":
      return <Text color="cyan">[info] {entry.text}</Text>;
    case "error":
      return <Text color="red">[error] {entry.text}</Text>;
    case "user":
      return <Text color="green">you: {entry.text}</Text>;
  }
}

function DraftPane({ draft, focused }: { draft: string; focused: boolean }): React.ReactElement {
  const ref = useRef<ScrollViewRef>(null);
  const userScrolledRef = useRef(false);
  // Auto-tail by line count proxies "scroll to most recently edited" —
  // edits typically extend the draft. A future iteration can track
  // diff regions, but the spec only asks for "auto-scrolling to the
  // most recently edited region", and a tailing right pane satisfies
  // the common case (append/extend).
  const lineCount = draft.length === 0 ? 0 : draft.split("\n").length;
  useAutoTail(lineCount, userScrolledRef, ref);
  useScrollKeys({ focused, userScrolledRef, scrollRef: ref });

  const titleRight = focused ? "tab to transcript" : "tab to focus";

  return (
    <Pane title="spec.draft.md" role="focusable" focused={focused}
          titleRight={titleRight} flexGrow={1} flexShrink={1}>
      {draft.length === 0 ? (
        <Text dimColor>(empty draft)</Text>
      ) : (
        <ScrollView ref={ref}>
          {draft.split("\n").map((line, i) => (
            <Text key={i}>{line || " "}</Text>
          ))}
        </ScrollView>
      )}
    </Pane>
  );
}

// ===== Widgets =====

function AskWidget({ bridge }: { bridge: DesignTuiBridge }): React.ReactElement {
  const state = useSyncExternalStore(bridge.subscribe, bridge.getState, bridge.getState);
  const ask = state.pendingAsk;
  const [cursor, setCursor] = useState(0);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [freeformMode, setFreeformMode] = useState(false);
  const [freeformText, setFreeformText] = useState("");
  const kb = useKeyboardAvailable();

  useInput((input, key) => {
    if (!ask) return;
    if (freeformMode) {
      if (key.return) {
        bridge.submitAsk({ selected: [], freeform: freeformText });
        return;
      }
      if (key.escape) {
        setFreeformMode(false);
        setFreeformText("");
        return;
      }
      if (key.backspace || key.delete) {
        setFreeformText((s) => s.slice(0, -1));
        return;
      }
      if (input && !key.ctrl && !key.meta) {
        setFreeformText((s) => s + input);
      }
      return;
    }
    const total = ask.input.options.length;
    if (key.upArrow) { setCursor((c) => (c - 1 + total) % total); return; }
    if (key.downArrow) { setCursor((c) => (c + 1) % total); return; }
    if (key.escape) { setFreeformMode(true); return; }
    if (input === " " && ask.input.multi_select) {
      setPicked((p) => {
        const n = new Set(p);
        if (n.has(cursor)) n.delete(cursor); else n.add(cursor);
        return n;
      });
      return;
    }
    if (key.return) {
      let selected: string[];
      if (ask.input.multi_select) {
        const indices = picked.size > 0 ? [...picked].sort() : [cursor];
        selected = indices.map((i) => ask.input.options[i]?.label ?? "");
      } else {
        selected = [ask.input.options[cursor]?.label ?? ""];
      }
      bridge.submitAsk({ selected });
    }
  }, { isActive: kb && ask !== null });

  if (!ask) return <Text> </Text>;

  if (freeformMode) {
    return (
      <Box flexDirection="column" borderStyle="single" borderColor="yellow" paddingX={1}>
        <Text bold>? {ask.input.question}</Text>
        <Text>(freeform — Enter to submit, Esc to go back)</Text>
        <Text>&gt; {freeformText}<Text inverse> </Text></Text>
      </Box>
    );
  }
  return (
    <Box flexDirection="column" borderStyle="single" borderColor="yellow" paddingX={1}>
      <Text bold>? {ask.input.question}</Text>
      {ask.input.options.map((opt, i) => {
        const isCursor = i === cursor;
        const isPicked = picked.has(i);
        const marker = ask.input.multi_select ? (isPicked ? "[x]" : "[ ]") : (isCursor ? "▸" : " ");
        return (
          <Text key={i} color={isCursor ? "cyan" : undefined}>
            {marker} {opt.label}
            <Text dimColor> — {opt.description}</Text>
          </Text>
        );
      })}
      <Text dimColor>
        ↑↓ move · {ask.input.multi_select ? "Space toggle · " : ""}Enter submit · Esc freeform
      </Text>
    </Box>
  );
}

function ConfirmWidget({ bridge }: { bridge: DesignTuiBridge }): React.ReactElement {
  const state = useSyncExternalStore(bridge.subscribe, bridge.getState, bridge.getState);
  const c = state.pendingConfirm;
  const kb = useKeyboardAvailable();
  useInput((input, key) => {
    if (!c) return;
    if (input === "y" || input === "Y") { bridge.submitConfirm(true); return; }
    if (input === "n" || input === "N") { bridge.submitConfirm(false); return; }
    if (key.return) { bridge.submitConfirm(c.defaultYes); return; }
    if (key.escape) { bridge.submitConfirm(false); return; }
  }, { isActive: kb && c !== null });
  if (!c) return <Text> </Text>;
  return (
    <Box flexDirection="column" borderStyle="single" borderColor="yellow" paddingX={1}>
      <Text bold>{c.question}</Text>
      <Text dimColor>
        {c.defaultYes ? "[Y/n]" : "[y/N]"} · y/n · Enter for default · Esc to cancel
      </Text>
    </Box>
  );
}

function InputWidget({ bridge }: { bridge: DesignTuiBridge }): React.ReactElement {
  const state = useSyncExternalStore(bridge.subscribe, bridge.getState, bridge.getState);
  const pending = state.pendingInput;
  const [text, setText] = useState("");
  const kb = useKeyboardAvailable();
  useInput((input, key) => {
    if (!pending) return;
    if (key.return) {
      bridge.submitInput(text);
      setText("");
      return;
    }
    if (key.backspace || key.delete) {
      setText((s) => s.slice(0, -1));
      return;
    }
    if (input && !key.ctrl && !key.meta) {
      setText((s) => s + input);
    }
  }, { isActive: kb && pending !== null });
  if (!pending) return <Text> </Text>;
  return (
    <Box>
      <Text>you&gt; {text}<Text inverse> </Text></Text>
    </Box>
  );
}
