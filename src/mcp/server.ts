/**
 * In-process MCP server for the design loop.
 *
 * Provides the `ask_user` tool that allows the design agent to interactively
 * ask the user structured multiple-choice questions.
 */

import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import {
  AskUserInputSchema,
  createAskUserHandler,
  type AskUserHandler,
} from "./ask-user.ts";

/**
 * Creates an MCP server instance with the ask_user tool.
 *
 * @param userInteraction - Callback function that handles user interaction in the TUI
 * @returns MCP server configuration that can be passed to the SDK's mcpServers option
 *
 * @example
 * ```typescript
 * const mcpServer = createDesignMcpServer(async (input) => {
 *   // Show interactive widget in TUI and wait for user response
 *   return { selected: ["option1"] };
 * });
 *
 * const query = defaultQuery({
 *   prompt: "Design a new feature",
 *   options: {
 *     mcpServers: {
 *       "design-loop": mcpServer,
 *     },
 *   },
 * });
 * ```
 */
export function createDesignMcpServer(
  userInteraction: AskUserHandler
): McpSdkServerConfigWithInstance {
  const askUserTool = tool(
    "ask_user",
    "Ask the user a structured multiple-choice question. Use this to gather user preferences, clarify requirements, or get decisions during the design process. The tool supports single or multiple selection, and users can also provide freeform text by pressing Esc.",
    AskUserInputSchema.shape,
    createAskUserHandler(userInteraction)
  );

  return createSdkMcpServer({
    name: "design-loop",
    version: "1.0.0",
    tools: [askUserTool],
  });
}
