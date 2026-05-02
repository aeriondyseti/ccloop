import { describe, test, expect } from "bun:test";
import { createDesignMcpServer } from "./server.ts";
import type { AskUserInput, AskUserResult } from "./ask-user.ts";

describe("createDesignMcpServer", () => {
  test("creates an MCP server with ask_user tool", () => {
    const mockHandler = async (_input: AskUserInput): Promise<AskUserResult> => {
      return { selected: ["test"] };
    };

    const server = createDesignMcpServer(mockHandler);

    // Verify server structure
    expect(server).toBeDefined();
    expect(server.instance).toBeDefined();
    expect(server.type).toBe("sdk");
  });

  test("creates server with correct name", () => {
    const mockHandler = async (_input: AskUserInput): Promise<AskUserResult> => {
      return { selected: [] };
    };

    const server = createDesignMcpServer(mockHandler);

    expect(server.name).toBe("design-loop");
    // version is stored in the instance, not at the top level
    expect(server.instance).toBeDefined();
  });

  test("server instance is reusable across multiple calls", () => {
    const mockHandler = async (_input: AskUserInput): Promise<AskUserResult> => {
      return { selected: [] };
    };

    const server1 = createDesignMcpServer(mockHandler);
    const server2 = createDesignMcpServer(mockHandler);

    // Each call creates a new instance
    expect(server1.instance).toBeDefined();
    expect(server2.instance).toBeDefined();
    expect(server1.instance).not.toBe(server2.instance);
  });
});
