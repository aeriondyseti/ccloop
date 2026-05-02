import { describe, test, expect } from "bun:test";
import {
  DESIGN_SYSTEM_PROMPT,
  PHASE_PROMPTS,
  getPhasePrompt,
  buildDesignPrompt,
} from "./prompts.ts";
import { DESIGN_PHASES } from "./constants.ts";

describe("DESIGN_SYSTEM_PROMPT", () => {
  test("contains key instructions", () => {
    expect(DESIGN_SYSTEM_PROMPT).toContain("six phases");
    expect(DESIGN_SYSTEM_PROMPT).toContain("ask_user");
    expect(DESIGN_SYSTEM_PROMPT).toContain(".ccloop/design/");
    expect(DESIGN_SYSTEM_PROMPT).toContain("spec.draft.md");
  });

  test("mentions all six phases", () => {
    expect(DESIGN_SYSTEM_PROMPT).toContain("Vision");
    expect(DESIGN_SYSTEM_PROMPT).toContain("Users");
    expect(DESIGN_SYSTEM_PROMPT).toContain("Scope");
    expect(DESIGN_SYSTEM_PROMPT).toContain("Architecture");
    expect(DESIGN_SYSTEM_PROMPT).toContain("Milestones");
    expect(DESIGN_SYSTEM_PROMPT).toContain("Acceptance");
  });

  test("specifies available tools", () => {
    expect(DESIGN_SYSTEM_PROMPT).toContain("Read/Grep/Glob");
    expect(DESIGN_SYSTEM_PROMPT).toContain("Edit/Write");
    expect(DESIGN_SYSTEM_PROMPT).toContain("Bash");
    expect(DESIGN_SYSTEM_PROMPT).toContain("WebSearch/WebFetch");
  });

  test("includes spec template structure", () => {
    expect(DESIGN_SYSTEM_PROMPT).toContain("## Vision");
    expect(DESIGN_SYSTEM_PROMPT).toContain("## Users");
    expect(DESIGN_SYSTEM_PROMPT).toContain("## Verification Requirements");
  });
});

describe("PHASE_PROMPTS", () => {
  test("has prompts for all six phases", () => {
    expect(Object.keys(PHASE_PROMPTS)).toHaveLength(6);
    for (const phase of DESIGN_PHASES) {
      expect(PHASE_PROMPTS[phase]).toBeDefined();
      expect(PHASE_PROMPTS[phase].length).toBeGreaterThan(0);
    }
  });

  test("each phase prompt mentions the phase name", () => {
    expect(PHASE_PROMPTS.vision).toContain("Vision");
    expect(PHASE_PROMPTS.users).toContain("Users");
    expect(PHASE_PROMPTS.scope).toContain("Scope");
    expect(PHASE_PROMPTS.architecture).toContain("Architecture");
    expect(PHASE_PROMPTS.milestones).toContain("Milestones");
    expect(PHASE_PROMPTS.acceptance).toContain("Acceptance");
  });

  test("vision phase asks about problem and solution", () => {
    expect(PHASE_PROMPTS.vision).toContain("problem");
    expect(PHASE_PROMPTS.vision).toContain("solution");
  });

  test("users phase asks about user needs", () => {
    expect(PHASE_PROMPTS.users).toContain("users");
    expect(PHASE_PROMPTS.users).toContain("needs");
    expect(PHASE_PROMPTS.users).toContain("workflows");
  });

  test("scope phase mentions in/out of scope", () => {
    expect(PHASE_PROMPTS.scope).toContain("in");
    expect(PHASE_PROMPTS.scope).toContain("Out of Scope");
  });

  test("architecture phase mentions technical decisions", () => {
    expect(PHASE_PROMPTS.architecture).toContain("technical");
    expect(PHASE_PROMPTS.architecture).toContain("stack");
  });

  test("milestones phase mentions deliverables", () => {
    expect(PHASE_PROMPTS.milestones).toContain("milestone");
    expect(PHASE_PROMPTS.milestones).toContain("deliverable");
  });

  test("acceptance phase mentions verification", () => {
    expect(PHASE_PROMPTS.acceptance).toContain("verification");
    expect(PHASE_PROMPTS.acceptance).toContain("Verification Requirements");
    expect(PHASE_PROMPTS.acceptance).toContain("Final Phase");
  });
});

describe("getPhasePrompt", () => {
  test("returns correct prompt for each phase", () => {
    for (const phase of DESIGN_PHASES) {
      const prompt = getPhasePrompt(phase);
      expect(prompt).toBe(PHASE_PROMPTS[phase]);
      expect(prompt.length).toBeGreaterThan(0);
    }
  });

  test("vision prompt is distinct from other phases", () => {
    const visionPrompt = getPhasePrompt("vision");
    const scopePrompt = getPhasePrompt("scope");
    expect(visionPrompt).not.toBe(scopePrompt);
  });
});

describe("buildDesignPrompt", () => {
  test("includes system prompt", () => {
    const prompt = buildDesignPrompt("vision");
    expect(prompt).toContain(DESIGN_SYSTEM_PROMPT);
  });

  test("includes phase-specific prompt", () => {
    const prompt = buildDesignPrompt("vision");
    expect(prompt).toContain(PHASE_PROMPTS.vision);
  });

  test("combines system and phase prompts in order", () => {
    const prompt = buildDesignPrompt("users");
    const systemIndex = prompt.indexOf(DESIGN_SYSTEM_PROMPT);
    const phaseIndex = prompt.indexOf(PHASE_PROMPTS.users);
    expect(systemIndex).toBeGreaterThanOrEqual(0);
    expect(phaseIndex).toBeGreaterThan(systemIndex);
  });

  test("includes additional context when provided", () => {
    const context = "User wants to build a CLI tool";
    const prompt = buildDesignPrompt("vision", context);
    expect(prompt).toContain(context);
    expect(prompt).toContain("Additional Context");
  });

  test("works without additional context", () => {
    const prompt = buildDesignPrompt("scope");
    expect(prompt).not.toContain("Additional Context");
    expect(prompt).toContain(DESIGN_SYSTEM_PROMPT);
    expect(prompt).toContain(PHASE_PROMPTS.scope);
  });

  test("different phases produce different prompts", () => {
    const visionPrompt = buildDesignPrompt("vision");
    const archPrompt = buildDesignPrompt("architecture");
    expect(visionPrompt).not.toBe(archPrompt);
    expect(visionPrompt).toContain("Vision");
    expect(archPrompt).toContain("Architecture");
  });
});
