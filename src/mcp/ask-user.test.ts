import { describe, test, expect } from "bun:test";
import {
  AskUserInputSchema,
  createAskUserHandler,
  type AskUserInput,
  type AskUserResult,
} from "./ask-user.ts";

describe("AskUserInputSchema", () => {
  test("validates correct input with required fields", () => {
    const input = {
      question: "Which approach should we take?",
      options: [
        { label: "Option A", description: "First approach" },
        { label: "Option B", description: "Second approach" },
      ],
    };
    const result = AskUserInputSchema.safeParse(input);
    expect(result.success).toBe(true);
  });

  test("validates input with multi_select flag", () => {
    const input = {
      question: "Select features to include:",
      options: [
        { label: "Auth", description: "Add authentication" },
        { label: "DB", description: "Add database" },
      ],
      multi_select: true,
    };
    const result = AskUserInputSchema.safeParse(input);
    expect(result.success).toBe(true);
  });

  test("rejects input with less than 2 options", () => {
    const input = {
      question: "Choose one:",
      options: [
        { label: "Only one", description: "Not enough options" },
      ],
    };
    const result = AskUserInputSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  test("rejects input with more than 4 options", () => {
    const input = {
      question: "Choose one:",
      options: [
        { label: "1", description: "First" },
        { label: "2", description: "Second" },
        { label: "3", description: "Third" },
        { label: "4", description: "Fourth" },
        { label: "5", description: "Fifth - too many!" },
      ],
    };
    const result = AskUserInputSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  test("rejects input with empty question", () => {
    const input = {
      question: "",
      options: [
        { label: "A", description: "First" },
        { label: "B", description: "Second" },
      ],
    };
    const result = AskUserInputSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  test("rejects options with empty label", () => {
    const input = {
      question: "Choose:",
      options: [
        { label: "", description: "Empty label" },
        { label: "B", description: "Second" },
      ],
    };
    const result = AskUserInputSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  test("rejects options with empty description", () => {
    const input = {
      question: "Choose:",
      options: [
        { label: "A", description: "" },
        { label: "B", description: "Second" },
      ],
    };
    const result = AskUserInputSchema.safeParse(input);
    expect(result.success).toBe(false);
  });
});

describe("createAskUserHandler", () => {
  test("returns selected options when user makes single selection", async () => {
    const mockHandler = async (input: AskUserInput): Promise<AskUserResult> => {
      expect(input.question).toBe("Test question?");
      return { selected: ["Option A"] };
    };

    const handler = createAskUserHandler(mockHandler);
    const result = await handler({
      question: "Test question?",
      options: [
        { label: "Option A", description: "First" },
        { label: "Option B", description: "Second" },
      ],
    }, undefined);

    expect(result.isError).toBe(false);
    expect(result.content).toHaveLength(1);
    const firstContent = result.content[0];
    expect(firstContent).toBeDefined();
    if (firstContent && firstContent.type === "text") {
      expect(firstContent.text).toContain("User selected: Option A");
    }
  });

  test("returns multiple selected options when user makes multiple selections", async () => {
    const mockHandler = async (_input: AskUserInput): Promise<AskUserResult> => {
      return { selected: ["Option A", "Option B"] };
    };

    const handler = createAskUserHandler(mockHandler);
    const result = await handler({
      question: "Select features:",
      options: [
        { label: "Option A", description: "First" },
        { label: "Option B", description: "Second" },
      ],
      multi_select: true,
    }, undefined);

    expect(result.isError).toBe(false);
    const firstContent = result.content[0];
    expect(firstContent).toBeDefined();
    if (firstContent && firstContent.type === "text") {
      expect(firstContent.text).toContain("User selected: Option A, Option B");
    }
  });

  test("returns freeform input when user provides custom text", async () => {
    const mockHandler = async (_input: AskUserInput): Promise<AskUserResult> => {
      return { selected: [], freeform: "Custom approach: use hybrid model" };
    };

    const handler = createAskUserHandler(mockHandler);
    const result = await handler({
      question: "Choose approach:",
      options: [
        { label: "A", description: "First" },
        { label: "B", description: "Second" },
      ],
    }, undefined);

    expect(result.isError).toBe(false);
    const firstContent = result.content[0];
    expect(firstContent).toBeDefined();
    if (firstContent && firstContent.type === "text") {
      expect(firstContent.text).toContain("User provided freeform input");
      expect(firstContent.text).toContain("Custom approach: use hybrid model");
    }
  });

  test("handles empty selection gracefully", async () => {
    const mockHandler = async (_input: AskUserInput): Promise<AskUserResult> => {
      return { selected: [] };
    };

    const handler = createAskUserHandler(mockHandler);
    const result = await handler({
      question: "Choose:",
      options: [
        { label: "A", description: "First" },
        { label: "B", description: "Second" },
      ],
    }, undefined);

    expect(result.isError).toBe(false);
    const firstContent = result.content[0];
    expect(firstContent).toBeDefined();
    if (firstContent && firstContent.type === "text") {
      expect(firstContent.text).toContain("User did not make a selection");
    }
  });

  test("handles handler errors gracefully", async () => {
    const mockHandler = async (_input: AskUserInput): Promise<AskUserResult> => {
      throw new Error("User cancelled");
    };

    const handler = createAskUserHandler(mockHandler);
    const result = await handler({
      question: "Choose:",
      options: [
        { label: "A", description: "First" },
        { label: "B", description: "Second" },
      ],
    }, undefined);

    expect(result.isError).toBe(true);
    const firstContent = result.content[0];
    expect(firstContent).toBeDefined();
    if (firstContent && firstContent.type === "text") {
      expect(firstContent.text).toContain("Error asking user");
      expect(firstContent.text).toContain("User cancelled");
    }
  });

  test("respects multi_select flag in input", async () => {
    let capturedInput: AskUserInput | null = null;
    const mockHandler = async (input: AskUserInput): Promise<AskUserResult> => {
      capturedInput = input;
      return { selected: ["A"] };
    };

    const handler = createAskUserHandler(mockHandler);
    await handler({
      question: "Select:",
      options: [
        { label: "A", description: "First" },
        { label: "B", description: "Second" },
      ],
      multi_select: true,
    }, undefined);

    expect(capturedInput).not.toBeNull();
    expect(capturedInput).toBeDefined();
    expect(capturedInput!.multi_select).toBe(true);
  });
});
