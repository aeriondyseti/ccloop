import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  saveSessionMetadata,
  loadSessionMetadata,
  loadSessionMetadataIfExists,
  createSessionMetadata,
  updateSessionMetadata,
  isSessionResumable,
} from "./session.ts";
import type { DesignSessionMetadata } from "./types.ts";

const TEST_DIR_PREFIX = join(tmpdir(), "ccloop-session-test-");
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

describe("saveSessionMetadata", () => {
  test("saves metadata to session.json", async () => {
    const metadata: DesignSessionMetadata = {
      started_at: "2025-01-01T00:00:00.000Z",
      current_phase: "vision",
      turn_count: 5,
      total_cost_usd: 1.23,
    };

    await saveSessionMetadata(testDir, metadata);

    const saved = await loadSessionMetadata(testDir);
    expect(saved).toEqual(metadata);
  });

  test("creates .ccloop/design directory if needed", async () => {
    const metadata = createSessionMetadata("users");
    await saveSessionMetadata(testDir, metadata);

    const saved = await loadSessionMetadata(testDir);
    expect(saved.current_phase).toBe("users");
  });

  test("overwrites existing metadata", async () => {
    const metadata1 = createSessionMetadata("vision");
    await saveSessionMetadata(testDir, metadata1);

    const metadata2: DesignSessionMetadata = {
      ...metadata1,
      current_phase: "scope",
      turn_count: 10,
    };
    await saveSessionMetadata(testDir, metadata2);

    const saved = await loadSessionMetadata(testDir);
    expect(saved.current_phase).toBe("scope");
    expect(saved.turn_count).toBe(10);
  });
});

describe("loadSessionMetadata", () => {
  test("loads existing metadata", async () => {
    const metadata: DesignSessionMetadata = {
      started_at: "2025-01-01T12:00:00.000Z",
      current_phase: "architecture",
      turn_count: 15,
      total_cost_usd: 2.5,
    };

    await saveSessionMetadata(testDir, metadata);
    const loaded = await loadSessionMetadata(testDir);

    expect(loaded).toEqual(metadata);
  });

  test("throws when session.json doesn't exist", async () => {
    await expect(loadSessionMetadata(testDir)).rejects.toThrow();
  });

  test("throws when metadata is invalid (missing started_at)", async () => {
    const path = join(testDir, ".ccloop", "design");
    await mkdir(path, { recursive: true });
    await writeFile(
      join(path, "session.json"),
      JSON.stringify({ current_phase: "vision", turn_count: 0, total_cost_usd: 0 }),
      "utf8"
    );

    await expect(loadSessionMetadata(testDir)).rejects.toThrow(/started_at/);
  });

  test("throws when metadata is invalid (missing current_phase)", async () => {
    const path = join(testDir, ".ccloop", "design");
    await mkdir(path, { recursive: true });
    await writeFile(
      join(path, "session.json"),
      JSON.stringify({ started_at: "2025-01-01T00:00:00.000Z", turn_count: 0, total_cost_usd: 0 }),
      "utf8"
    );

    await expect(loadSessionMetadata(testDir)).rejects.toThrow(/current_phase/);
  });

  test("throws when metadata is invalid (missing turn_count)", async () => {
    const path = join(testDir, ".ccloop", "design");
    await mkdir(path, { recursive: true });
    await writeFile(
      join(path, "session.json"),
      JSON.stringify({ started_at: "2025-01-01T00:00:00.000Z", current_phase: "vision", total_cost_usd: 0 }),
      "utf8"
    );

    await expect(loadSessionMetadata(testDir)).rejects.toThrow(/turn_count/);
  });

  test("throws when metadata is invalid (missing total_cost_usd)", async () => {
    const path = join(testDir, ".ccloop", "design");
    await mkdir(path, { recursive: true });
    await writeFile(
      join(path, "session.json"),
      JSON.stringify({ started_at: "2025-01-01T00:00:00.000Z", current_phase: "vision", turn_count: 0 }),
      "utf8"
    );

    await expect(loadSessionMetadata(testDir)).rejects.toThrow(/total_cost_usd/);
  });
});

describe("loadSessionMetadataIfExists", () => {
  test("returns metadata when it exists", async () => {
    const metadata = createSessionMetadata("milestones");
    await saveSessionMetadata(testDir, metadata);

    const loaded = await loadSessionMetadataIfExists(testDir);
    expect(loaded).not.toBeNull();
    expect(loaded?.current_phase).toBe("milestones");
  });

  test("returns null when session.json doesn't exist", async () => {
    const loaded = await loadSessionMetadataIfExists(testDir);
    expect(loaded).toBeNull();
  });

  test("throws on invalid metadata (not ENOENT)", async () => {
    const path = join(testDir, ".ccloop", "design");
    await mkdir(path, { recursive: true });
    await writeFile(join(path, "session.json"), "invalid json", "utf8");

    await expect(loadSessionMetadataIfExists(testDir)).rejects.toThrow();
  });
});

describe("createSessionMetadata", () => {
  test("creates metadata with default phase", () => {
    const metadata = createSessionMetadata();

    expect(metadata.current_phase).toBe("vision");
    expect(metadata.turn_count).toBe(0);
    expect(metadata.total_cost_usd).toBe(0);
    expect(metadata.started_at).toBeDefined();
    expect(typeof metadata.started_at).toBe("string");
  });

  test("creates metadata with specified phase", () => {
    const metadata = createSessionMetadata("acceptance");

    expect(metadata.current_phase).toBe("acceptance");
    expect(metadata.turn_count).toBe(0);
    expect(metadata.total_cost_usd).toBe(0);
  });

  test("includes timestamp in ISO format", () => {
    const metadata = createSessionMetadata();
    const parsed = Date.parse(metadata.started_at);
    expect(Number.isNaN(parsed)).toBe(false);
  });
});

describe("updateSessionMetadata", () => {
  test("updates specified fields", () => {
    const original = createSessionMetadata("vision");
    const updated = updateSessionMetadata(original, {
      turn_count: 10,
      total_cost_usd: 1.5,
    });

    expect(updated.turn_count).toBe(10);
    expect(updated.total_cost_usd).toBe(1.5);
    expect(updated.current_phase).toBe("vision");
    expect(updated.started_at).toBe(original.started_at);
  });

  test("updates phase", () => {
    const original = createSessionMetadata("vision");
    const updated = updateSessionMetadata(original, {
      current_phase: "scope",
    });

    expect(updated.current_phase).toBe("scope");
    expect(updated.turn_count).toBe(0);
  });

  test("can mark as accepted", () => {
    const original = createSessionMetadata();
    const updated = updateSessionMetadata(original, {
      accepted: true,
    });

    expect(updated.accepted).toBe(true);
  });

  test("doesn't mutate original", () => {
    const original = createSessionMetadata("vision");
    const originalCopy = { ...original };

    updateSessionMetadata(original, { turn_count: 100 });

    expect(original).toEqual(originalCopy);
  });
});

describe("isSessionResumable", () => {
  test("returns true when session and draft exist", async () => {
    const metadata = createSessionMetadata("users");
    await saveSessionMetadata(testDir, metadata);

    // Create a draft
    const draftPath = join(testDir, ".ccloop", "design", "spec.draft.md");
    await writeFile(draftPath, "# Draft", "utf8");

    const resumable = await isSessionResumable(testDir);
    expect(resumable).toBe(true);
  });

  test("returns false when session doesn't exist", async () => {
    const resumable = await isSessionResumable(testDir);
    expect(resumable).toBe(false);
  });

  test("returns false when draft doesn't exist", async () => {
    const metadata = createSessionMetadata();
    await saveSessionMetadata(testDir, metadata);

    const resumable = await isSessionResumable(testDir);
    expect(resumable).toBe(false);
  });

  test("returns false when session is already accepted", async () => {
    const metadata = createSessionMetadata();
    metadata.accepted = true;
    await saveSessionMetadata(testDir, metadata);

    // Create a draft
    const draftPath = join(testDir, ".ccloop", "design", "spec.draft.md");
    await mkdir(join(testDir, ".ccloop", "design"), { recursive: true });
    await writeFile(draftPath, "# Draft", "utf8");

    const resumable = await isSessionResumable(testDir);
    expect(resumable).toBe(false);
  });

  test("returns true for in-progress session with draft", async () => {
    const metadata: DesignSessionMetadata = {
      started_at: "2025-01-01T00:00:00.000Z",
      current_phase: "architecture",
      turn_count: 20,
      total_cost_usd: 3.5,
    };
    await saveSessionMetadata(testDir, metadata);

    const draftPath = join(testDir, ".ccloop", "design", "spec.draft.md");
    await writeFile(draftPath, "# In Progress\n\n- [ ] Item", "utf8");

    const resumable = await isSessionResumable(testDir);
    expect(resumable).toBe(true);
  });
});
