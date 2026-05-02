import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  acceptDraft,
  checkDraftValidity,
  formatValidationError,
  generateAcceptancePrompt,
} from "./acceptance.ts";

const TEST_DIR_PREFIX = join(tmpdir(), "ccloop-acceptance-test-");
let testDir: string;

beforeEach(async () => {
  testDir = TEST_DIR_PREFIX + Math.random().toString(36).slice(2);
  await mkdir(testDir, { recursive: true });
});

afterEach(async () => {
  try {
    await rm(testDir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
});

async function createValidDraft(dir: string): Promise<void> {
  const draftPath = join(dir, ".ccloop", "design", "spec.draft.md");
  await mkdir(join(dir, ".ccloop", "design"), { recursive: true });
  await writeFile(
    draftPath,
    "# Project\n\n- [ ] Feature 1\n- [ ] Feature 2\n\n## Verification Requirements\n\n1. All features work\n2. Tests pass",
    "utf8"
  );
}

async function createInvalidDraft(dir: string): Promise<void> {
  const draftPath = join(dir, ".ccloop", "design", "spec.draft.md");
  await mkdir(join(dir, ".ccloop", "design"), { recursive: true });
  // Missing Verification Requirements section
  await writeFile(draftPath, "# Project\n\n- [ ] Feature 1", "utf8");
}

describe("acceptDraft", () => {
  test("accepts and promotes valid draft", async () => {
    await createValidDraft(testDir);

    const result = await acceptDraft(testDir);

    expect(result.accepted).toBe(true);
    if (result.accepted) {
      expect(result.promotedFiles).toContain("SPEC.md");

      // Verify SPEC.md was created
      const specPath = join(testDir, "SPEC.md");
      const content = await readFile(specPath, "utf8");
      expect(content).toContain("Feature 1");
      expect(content).toContain("Verification Requirements");
    }
  });

  test("rejects invalid draft with validation error", async () => {
    await createInvalidDraft(testDir);

    const result = await acceptDraft(testDir);

    expect(result.accepted).toBe(false);
    if (!result.accepted) {
      expect(result.validationError).toContain("Verification Requirements");
    }
  });

  test("promotes sibling artifacts when they exist", async () => {
    await createValidDraft(testDir);

    // Create sibling artifacts
    const designDir = join(testDir, ".ccloop", "design");
    await writeFile(join(designDir, "ROADMAP.md"), "# Future", "utf8");
    await writeFile(join(designDir, "IDEAS.md"), "# Ideas", "utf8");
    await writeFile(join(designDir, "TECH-DEBT.md"), "# Debt", "utf8");

    const result = await acceptDraft(testDir);

    expect(result.accepted).toBe(true);
    if (result.accepted) {
      expect(result.promotedFiles).toContain("SPEC.md");
      expect(result.promotedFiles).toContain("ROADMAP.md");
      expect(result.promotedFiles).toContain("IDEAS.md");
      expect(result.promotedFiles).toContain("TECH-DEBT.md");

      // Verify files were copied
      const roadmap = await readFile(join(testDir, "ROADMAP.md"), "utf8");
      expect(roadmap).toBe("# Future");
    }
  });

  test("promotes only SPEC.md when no siblings exist", async () => {
    await createValidDraft(testDir);

    const result = await acceptDraft(testDir);

    expect(result.accepted).toBe(true);
    if (result.accepted) {
      expect(result.promotedFiles).toEqual(["SPEC.md"]);
    }
  });

  test("rejects draft with no checklist items", async () => {
    const draftPath = join(testDir, ".ccloop", "design", "spec.draft.md");
    await mkdir(join(testDir, ".ccloop", "design"), { recursive: true });
    await writeFile(
      draftPath,
      "# Project\n\n## Verification Requirements\n\n1. Done",
      "utf8"
    );

    const result = await acceptDraft(testDir);

    expect(result.accepted).toBe(false);
    if (!result.accepted) {
      expect(result.validationError).toContain("no checklist");
    }
  });

  test("rejects draft with empty Verification Requirements", async () => {
    const draftPath = join(testDir, ".ccloop", "design", "spec.draft.md");
    await mkdir(join(testDir, ".ccloop", "design"), { recursive: true });
    await writeFile(
      draftPath,
      "# Project\n\n- [ ] Feature\n\n## Verification Requirements\n\n",
      "utf8"
    );

    const result = await acceptDraft(testDir);

    expect(result.accepted).toBe(false);
    if (!result.accepted) {
      expect(result.validationError).toContain("empty");
    }
  });
});

describe("checkDraftValidity", () => {
  test("returns ok for valid draft", async () => {
    await createValidDraft(testDir);

    const result = await checkDraftValidity(testDir);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.checklistCount).toBe(2);
    }
  });

  test("returns error for invalid draft", async () => {
    await createInvalidDraft(testDir);

    const result = await checkDraftValidity(testDir);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("Verification Requirements");
    }
  });

  test("returns error when draft doesn't exist", async () => {
    const result = await checkDraftValidity(testDir);

    expect(result.ok).toBe(false);
  });
});

describe("formatValidationError", () => {
  test("formats error message with context", () => {
    const error = "Missing checklist items";
    const formatted = formatValidationError(error);

    expect(formatted).toContain("Draft validation failed");
    expect(formatted).toContain("Missing checklist items");
    expect(formatted).toContain("update the draft");
  });

  test("includes the original error message", () => {
    const error = "No Verification Requirements section";
    const formatted = formatValidationError(error);

    expect(formatted).toContain("No Verification Requirements section");
  });
});

describe("generateAcceptancePrompt", () => {
  test("includes checklist count", () => {
    const prompt = generateAcceptancePrompt(5);

    expect(prompt).toContain("5 checklist items");
  });

  test("mentions all promotion actions", () => {
    const prompt = generateAcceptancePrompt(3);

    expect(prompt).toContain("spec.draft.md to SPEC.md");
    expect(prompt).toContain("ROADMAP.md");
    expect(prompt).toContain("IDEAS.md");
    expect(prompt).toContain("TECH-DEBT.md");
    expect(prompt).toContain("Promote draft to SPEC.md?");
  });

  test("indicates draft is valid", () => {
    const prompt = generateAcceptancePrompt(10);

    expect(prompt).toContain("valid");
    expect(prompt).toContain("ready to promote");
  });
});
