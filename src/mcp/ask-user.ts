/**
 * `ask_user` MCP tool for the design loop.
 *
 * Allows the design agent to ask the user structured multiple-choice
 * questions interactively. The tool invocation suspends agent execution
 * while waiting for user input.
 */

import { z } from "zod";

/**
 * Result returned by MCP tool handlers.
 * Based on the MCP protocol spec.
 */
export interface CallToolResult {
  content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;
  isError?: boolean;
}

/**
 * Input schema for the ask_user tool.
 *
 * - question: The question to ask the user
 * - options: Array of choices (2-4 options)
 * - multi_select: Whether to allow multiple selections (default: false)
 */
export const AskUserInputSchema = z.object({
  question: z.string().min(1).describe("The question to ask the user"),
  options: z.array(
    z.object({
      label: z.string().min(1).describe("The display text for this option"),
      description: z.string().min(1).describe(
        "Explanation of what this option means or what will happen if chosen"
      ),
    })
  ).min(2).max(4).describe("Array of choices (2-4 options)"),
  multi_select: z.boolean().optional().describe(
    "Whether to allow multiple selections (default: false)"
  ),
});

export type AskUserInput = z.infer<typeof AskUserInputSchema>;

/**
 * Result returned by the ask_user tool.
 *
 * - selected: Array of selected option labels
 * - freeform: Optional freeform text if user pressed Esc to provide custom input
 */
export interface AskUserResult {
  selected: string[];
  freeform?: string;
}

/**
 * Callback function that the design loop provides to handle user interaction.
 *
 * This function is called when the agent invokes ask_user. It should:
 * 1. Render an interactive widget in the TUI
 * 2. Wait for user input (arrow keys + Enter, or Esc for freeform)
 * 3. Return the user's selection(s)
 *
 * The callback is async to allow the TUI to suspend while waiting for input.
 */
export type AskUserHandler = (input: AskUserInput) => Promise<AskUserResult>;

/**
 * Creates the handler function for the ask_user tool.
 *
 * @param userInteraction - Callback provided by the design loop to handle user input
 * @returns Handler function compatible with the MCP tool definition
 */
export function createAskUserHandler(
  userInteraction: AskUserHandler
): (args: AskUserInput, extra: unknown) => Promise<CallToolResult> {
  return async (args: AskUserInput, _extra: unknown): Promise<CallToolResult> => {
    try {
      const result = await userInteraction(args);

      // Format the result for the agent
      const content: Array<{ type: "text"; text: string }> = [];

      if (result.freeform) {
        content.push({
          type: "text",
          text: `User provided freeform input: ${result.freeform}`,
        });
      } else if (result.selected.length > 0) {
        const selections = result.selected.join(", ");
        content.push({
          type: "text",
          text: `User selected: ${selections}`,
        });
      } else {
        content.push({
          type: "text",
          text: "User did not make a selection.",
        });
      }

      return {
        content,
        isError: false,
      };
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
