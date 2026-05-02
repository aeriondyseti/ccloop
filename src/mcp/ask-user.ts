/** `ask_user` — the MCP tool the design agent invokes to suspend
 *  itself and ask the user a structured multi-choice question. */

import { z } from "zod";

/** MCP tool result envelope (subset of the protocol's CallToolResult). */
export interface CallToolResult {
  content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;
  isError?: boolean;
}

export const AskUserInputSchema = z.object({
  question: z.string().min(1).describe("The question to ask the user"),
  options: z.array(
    z.object({
      label: z.string().min(1).describe("The display text for this option"),
      description: z.string().min(1).describe(
        "Explanation of what this option means or what will happen if chosen",
      ),
    }),
  ).min(2).max(4).describe("Array of choices (2-4 options)"),
  multi_select: z.boolean().optional().describe(
    "Whether to allow multiple selections (default: false)",
  ),
});

export type AskUserInput = z.infer<typeof AskUserInputSchema>;

export interface AskUserResult {
  selected: string[];
  freeform?: string;
}

/** Provided by the design loop. The callback should render an
 *  interactive widget in the TUI, wait for the user, and return their
 *  selection — async so the TUI can suspend in the meantime. */
export type AskUserHandler = (input: AskUserInput) => Promise<AskUserResult>;

export function createAskUserHandler(
  userInteraction: AskUserHandler,
): (args: AskUserInput, extra: unknown) => Promise<CallToolResult> {
  return async (args: AskUserInput): Promise<CallToolResult> => {
    try {
      const result = await userInteraction(args);
      const content: Array<{ type: "text"; text: string }> = [];
      if (result.freeform) {
        content.push({ type: "text", text: `User provided freeform input: ${result.freeform}` });
      } else if (result.selected.length > 0) {
        content.push({ type: "text", text: `User selected: ${result.selected.join(", ")}` });
      } else {
        content.push({ type: "text", text: "User did not make a selection." });
      }
      return { content, isError: false };
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: `Error asking user: ${error instanceof Error ? error.message : String(error)}`,
        }],
        isError: true,
      };
    }
  };
}
