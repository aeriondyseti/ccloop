/**
 * Bridge between the design orchestrator's IoAdapter and React state.
 *
 * The orchestrator is fully decoupled from rendering — it just calls
 * IoAdapter methods. The TUI (Ink) needs to observe those calls as
 * state. This bridge captures everything in a tiny store with
 * subscribe/getState semantics so React can mount it via
 * `useSyncExternalStore`. Pending awaits (askUser, confirm,
 * getNextInput) are stored as `{ resolver, ... }` records so the UI
 * can fulfill them with `submit*` methods when the user responds.
 */
import type { IoAdapter } from "../design/io.ts";
import type { AskUserInput, AskUserResult } from "../mcp/ask-user.ts";

export type TranscriptEntry =
  | { kind: "assistant"; text: string }
  | { kind: "tool"; name: string; summary: string }
  | { kind: "info"; text: string }
  | { kind: "error"; text: string }
  | { kind: "user"; text: string };

export interface PendingAsk {
  input: AskUserInput;
  resolve: (r: AskUserResult) => void;
}

export interface PendingConfirm {
  question: string;
  defaultYes: boolean;
  resolve: (b: boolean) => void;
}

export interface PendingInput {
  resolve: (s: string | null) => void;
}

export interface DesignTuiState {
  transcript: TranscriptEntry[];
  draft: string;
  pendingAsk: PendingAsk | null;
  pendingConfirm: PendingConfirm | null;
  pendingInput: PendingInput | null;
  /** Mounted-at timestamp for an "elapsed" counter in the header. */
  startedAt: number;
}

export interface DesignTuiBridge {
  adapter: IoAdapter;
  subscribe(listener: () => void): () => void;
  getState(): DesignTuiState;
  /** Provide an answer to the pending ask_user widget. */
  submitAsk(result: AskUserResult): void;
  /** Resolve the pending yes/no confirmation. */
  submitConfirm(answer: boolean): void;
  /** Submit the user's typed line (or null on Ctrl+D / EOF). */
  submitInput(line: string | null): void;
}

export function createDesignTuiBridge(): DesignTuiBridge {
  const listeners = new Set<() => void>();
  let state: DesignTuiState = {
    transcript: [],
    draft: "",
    pendingAsk: null,
    pendingConfirm: null,
    pendingInput: null,
    startedAt: Date.now(),
  };

  function emit(): void {
    for (const l of listeners) l();
  }
  function update(mutator: (s: DesignTuiState) => DesignTuiState): void {
    state = mutator(state);
    emit();
  }

  const adapter: IoAdapter = {
    showAssistantText(text) {
      if (!text.trim()) return;
      update((s) => ({ ...s, transcript: [...s.transcript, { kind: "assistant", text }] }));
    },
    showToolUse(name, summary) {
      update((s) => ({ ...s, transcript: [...s.transcript, { kind: "tool", name, summary }] }));
    },
    showInfo(text) {
      update((s) => ({ ...s, transcript: [...s.transcript, { kind: "info", text }] }));
    },
    showError(text) {
      update((s) => ({ ...s, transcript: [...s.transcript, { kind: "error", text }] }));
    },
    draftUpdated(content) {
      update((s) => ({ ...s, draft: content }));
    },
    askUser(input) {
      return new Promise<AskUserResult>((resolve) => {
        update((s) => ({ ...s, pendingAsk: { input, resolve } }));
      });
    },
    getNextInput() {
      return new Promise<string | null>((resolve) => {
        update((s) => ({ ...s, pendingInput: { resolve } }));
      });
    },
    confirm(question, defaultYes) {
      return new Promise<boolean>((resolve) => {
        update((s) => ({ ...s, pendingConfirm: { question, defaultYes, resolve } }));
      });
    },
    async close() {
      // The Ink instance is unmounted by the caller after the
      // orchestrator returns. Nothing to flush here.
    },
  };

  return {
    adapter,
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    getState() { return state; },
    submitAsk(result) {
      const pending = state.pendingAsk;
      if (!pending) return;
      update((s) => ({ ...s, pendingAsk: null }));
      pending.resolve(result);
    },
    submitConfirm(answer) {
      const pending = state.pendingConfirm;
      if (!pending) return;
      update((s) => ({ ...s, pendingConfirm: null }));
      pending.resolve(answer);
    },
    submitInput(line) {
      const pending = state.pendingInput;
      if (!pending) return;
      const text = line?.trim() ?? "";
      if (line !== null && text.length > 0) {
        update((s) => ({ ...s, pendingInput: null, transcript: [...s.transcript, { kind: "user", text }] }));
      } else {
        update((s) => ({ ...s, pendingInput: null }));
      }
      pending.resolve(line);
    },
  };
}
