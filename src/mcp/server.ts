/** In-process MCP server exposing the `ask_user` tool that the design
 *  agent calls to ask the user structured multiple-choice questions. */

import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import {
  AskUserInputSchema,
  createAskUserHandler,
  type AskUserHandler,
} from "./ask-user.ts";

export function createDesignMcpServer(
  userInteraction: AskUserHandler,
): McpSdkServerConfigWithInstance {
  const askUserTool = tool(
    "ask_user",
    "Ask the user a structured multiple-choice question. Use this to gather user preferences, clarify requirements, or get decisions during the design process. The tool supports single or multiple selection, and users can also provide freeform text by pressing Esc.",
    AskUserInputSchema.shape,
    createAskUserHandler(userInteraction),
  );
  return createSdkMcpServer({
    name: "design-loop",
    version: "1.0.0",
    tools: [askUserTool],
  });
}
