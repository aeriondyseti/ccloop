import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  initializeDraft,
  loadDraft,
  loadDraftIfExists,
  validateDraft,
  promoteDraft,
  saveDraft,
} from "./draft.ts";

// Create a unique temp directory for each test run
const TEST_DIR_PREFIX = join(tmpdir(), "ccloop-draft-test-");
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

describe("initializeDraft", () => {
  test("creates draft from template when none exists", async () => {
    // Create a template
    const templateDir = join(testDir, "templates");
    await mkdir(templateDir, { recursive: true });
    const templatePath = join(templateDir, "SPEC.md");
    await writeFile(templatePath, "# Template SPEC\n\n- [ ] Item 1\n\n## Verification Requirements\n\n1. Done", "utf8");

    const created = await initializeDraft(testDir, templatePath);
    expect(created).toBe(true);

    const draftPath = join(testDir, ".ccloop", "design", "spec.draft.md");
    const content = await readFile(draftPath, "utf8");
    expect(content).toContain("Template SPEC");
  });

  test("returns false when draft already exists", async () => {
    const templatePath = join(testDir, "template.md");
    await writeFile(templatePath, "# Template\n\n- [ ] Item\n\n## Verification Requirements\n\n1. Done", "utf8");

    const created1 = await initializeDraft(testDir, templatePath);
    expect(created1).toBe(true);

    const created2 = await initializeDraft(testDir, templatePath);
    expect(created2).toBe(false);
  });

  test("creates .ccloop/design directory", async () => {
    const templatePath = join(testDir, "template.md");
    await writeFile(templatePath, "# Template\n\n- [ ] Item\n\n## Verification Requirements\n\n1. Done", "utf8");

    await initializeDraft(testDir, templatePath);

    const draftPath = join(testDir, ".ccloop", "design", "spec.draft.md");
    const content = await readFile(draftPath, "utf8");
    expect(content).toBeDefined();
  });
});

describe("loadDraft", () => {
  test("loads existing draft content", async () => {
    const draftPath = join(testDir, ".ccloop", "design", "spec.draft.md");
    await mkdir(join(testDir, ".ccloop", "design"), { recursive: true });
    await writeFile(draftPath, "# My Draft\n\nContent here", "utf8");

    const content = await loadDraft(testDir);
    expect(content).toBe("# My Draft\n\nContent here");
  });

  test("throws when draft doesn't exist", async () => {
    await expect(loadDraft(testDir)).rejects.toThrow();
  });
});

describe("loadDraftIfExists", () => {
  test("returns content when draft exists", async () => {
    const draftPath = join(testDir, ".ccloop", "design", "spec.draft.md");
    await mkdir(join(testDir, ".ccloop", "design"), { recursive: true });
    await writeFile(draftPath, "# Draft", "utf8");

    const content = await loadDraftIfExists(testDir);
    expect(content).toBe("# Draft");
  });

  test("returns null when draft doesn't exist", async () => {
    const content = await loadDraftIfExists(testDir);
    expect(content).toBeNull();
  });
});

describe("validateDraft", () => {
  test("returns ok: true for valid draft", async () => {
    const draftPath = join(testDir, ".ccloop", "design", "spec.draft.md");
    await mkdir(join(testDir, ".ccloop", "design"), { recursive: true });
    await writeFile(
      draftPath,
      "# Spec\n\n- [ ] Item 1\n- [x] Item 2\n\n## Verification Requirements\n\n1. All done",
      "utf8"
    );

    const result = await validateDraft(testDir);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.checklistCount).toBe(2);
    }
  });

  test("returns ok: false when no checklist", async () => {
    const draftPath = join(testDir, ".ccloop", "design", "spec.draft.md");
    await mkdir(join(testDir, ".ccloop", "design"), { recursive: true });
    await writeFile(
      draftPath,
      "# Spec\n\n## Verification Requirements\n\n1. All done",
      "utf8"
    );

    const result = await validateDraft(testDir);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("no checklist");
    }
  });

  test("returns ok: false when missing Verification Requirements", async () => {
    const draftPath = join(testDir, ".ccloop", "design", "spec.draft.md");
    await mkdir(join(testDir, ".ccloop", "design"), { recursive: true });
    await writeFile(draftPath, "# Spec\n\n- [ ] Item 1", "utf8");

    const result = await validateDraft(testDir);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("Verification Requirements");
    }
  });

  test("returns ok: false when Verification Requirements is empty", async () => {
    const draftPath = join(testDir, ".ccloop", "design", "spec.draft.md");
    await mkdir(join(testDir, ".ccloop", "design"), { recursive: true });
    await writeFile(
      draftPath,
      "# Spec\n\n- [ ] Item 1\n\n## Verification Requirements\n\n",
      "utf8"
    );

    const result = await validateDraft(testDir);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("empty");
    }
  });
});

describe("promoteDraft", () => {
  test("copies draft to SPEC.md", async () => {
    const draftPath = join(testDir, ".ccloop", "design", "spec.draft.md");
    await mkdir(join(testDir, ".ccloop", "design"), { recursive: true });
    await writeFile(draftPath, "# My Spec\n\n- [ ] Feature", "utf8");

    const promoted = await promoteDraft(testDir);
    expect(promoted).toContain("SPEC.md");

    const specPath = join(testDir, "SPEC.md");
    const content = await readFile(specPath, "utf8");
    expect(content).toBe("# My Spec\n\n- [ ] Feature");
  });

  test("promotes ROADMAP.md if it exists", async () => {
    const designDir = join(testDir, ".ccloop", "design");
    await mkdir(designDir, { recursive: true });
    await writeFile(join(designDir, "spec.draft.md"), "# Spec\n\n- [ ] Item\n\n## Verification Requirements\n\n1. Done", "utf8");
    await writeFile(join(designDir, "ROADMAP.md"), "# Future work", "utf8");

    const promoted = await promoteDraft(testDir);
    expect(promoted).toContain("SPEC.md");
    expect(promoted).toContain("ROADMAP.md");

    const roadmapPath = join(testDir, "ROADMAP.md");
    const content = await readFile(roadmapPath, "utf8");
    expect(content).toBe("# Future work");
  });

  test("promotes IDEAS.md if it exists", async () => {
    const designDir = join(testDir, ".ccloop", "design");
    await mkdir(designDir, { recursive: true });
    await writeFile(join(designDir, "spec.draft.md"), "# Spec\n\n- [ ] Item\n\n## Verification Requirements\n\n1. Done", "utf8");
    await writeFile(join(designDir, "IDEAS.md"), "# Ideas list", "utf8");

    const promoted = await promoteDraft(testDir);
    expect(promoted).toContain("IDEAS.md");

    const ideasPath = join(testDir, "IDEAS.md");
    const content = await readFile(ideasPath, "utf8");
    expect(content).toBe("# Ideas list");
  });

  test("promotes TECH-DEBT.md if it exists", async () => {
    const designDir = join(testDir, ".ccloop", "design");
    await mkdir(designDir, { recursive: true });
    await writeFile(join(designDir, "spec.draft.md"), "# Spec\n\n- [ ] Item\n\n## Verification Requirements\n\n1. Done", "utf8");
    await writeFile(join(designDir, "TECH-DEBT.md"), "# Known issues", "utf8");

    const promoted = await promoteDraft(testDir);
    expect(promoted).toContain("TECH-DEBT.md");

    const techDebtPath = join(testDir, "TECH-DEBT.md");
    const content = await readFile(techDebtPath, "utf8");
    expect(content).toBe("# Known issues");
  });

  test("promotes only draft when no siblings exist", async () => {
    const designDir = join(testDir, ".ccloop", "design");
    await mkdir(designDir, { recursive: true });
    await writeFile(join(designDir, "spec.draft.md"), "# Spec", "utf8");

    const promoted = await promoteDraft(testDir);
    expect(promoted).toEqual(["SPEC.md"]);
  });

  test("promotes all artifacts when all exist", async () => {
    const designDir = join(testDir, ".ccloop", "design");
    await mkdir(designDir, { recursive: true });
    await writeFile(join(designDir, "spec.draft.md"), "# Spec", "utf8");
    await writeFile(join(designDir, "ROADMAP.md"), "# Roadmap", "utf8");
    await writeFile(join(designDir, "IDEAS.md"), "# Ideas", "utf8");
    await writeFile(join(designDir, "TECH-DEBT.md"), "# Debt", "utf8");

    const promoted = await promoteDraft(testDir);
    expect(promoted).toHaveLength(4);
    expect(promoted).toContain("SPEC.md");
    expect(promoted).toContain("ROADMAP.md");
    expect(promoted).toContain("IDEAS.md");
    expect(promoted).toContain("TECH-DEBT.md");
  });
});

describe("saveDraft", () => {
  test("saves content to draft", async () => {
    await saveDraft(testDir, "# New content\n\nHello world");

    const draftPath = join(testDir, ".ccloop", "design", "spec.draft.md");
    const content = await readFile(draftPath, "utf8");
    expect(content).toBe("# New content\n\nHello world");
  });

  test("creates directory if it doesn't exist", async () => {
    await saveDraft(testDir, "# Content");

    const draftPath = join(testDir, ".ccloop", "design", "spec.draft.md");
    const content = await readFile(draftPath, "utf8");
    expect(content).toBe("# Content");
  });

  test("overwrites existing draft", async () => {
    await saveDraft(testDir, "First version");
    await saveDraft(testDir, "Second version");

    const draftPath = join(testDir, ".ccloop", "design", "spec.draft.md");
    const content = await readFile(draftPath, "utf8");
    expect(content).toBe("Second version");
  });
});
