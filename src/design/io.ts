/**
 * IoAdapter — presentation seam for the design orchestrator.
 *
 * The orchestrator owns the SDK, MCP server, draft promotion, and
 * lifecycle events. Anything that touches the user (rendering text,
 * asking questions, reading typed input) goes through this interface
 * so the same orchestrator can drive a stdio CLI, a two-pane TUI, or
 * a test harness.
 */
import type { AskUserInput, AskUserResult } from "../mcp/ask-user.ts";

export interface IoAdapter {
  /** Stream text the agent emitted between tool uses. */
  showAssistantText(text: string): void;
  /** Stream a tool use summary line for the transcript. */
  showToolUse(name: string, summary: string): void;
  /** Informational status (e.g. "draft promoted: SPEC.md"). */
  showInfo(text: string): void;
  /** Error/warning surfaced to the user (validation errors, denials). */
  showError(text: string): void;

  /** Block until the user responds to an `ask_user` invocation. */
  askUser(input: AskUserInput): Promise<AskUserResult>;

  /** Notify that the draft on disk changed; the TUI uses this to
   *  re-render the right pane. Stdio adapters can ignore. */
  draftUpdated(content: string): void;

  /** Get the user's next freeform line between agent turns.
   *  Returns the typed text, or null on EOF/cancel.
   *  The orchestrator handles `/accept` and `/abort` itself; adapters
   *  should pass slash commands through. */
  getNextInput(): Promise<string | null>;

  /** Yes/no confirmation. Used for "promote draft to ./SPEC.md?" and
   *  "launch ccloop build now?" prompts. */
  confirm(question: string, defaultYes: boolean): Promise<boolean>;

  /** Final cleanup (close readline, unmount Ink, etc.). */
  close(): Promise<void>;
}
