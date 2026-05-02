import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DesignEventEmitter, createDesignEventEmitter } from "./events.ts";

const TEST_DIR_PREFIX = join(tmpdir(), "ccloop-design-events-test-");
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

async function readEvents(cwd: string): Promise<any[]> {
  const eventsPath = join(cwd, ".ccloop", "events.jsonl");
  const content = await readFile(eventsPath, "utf8");
  return content
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

describe("DesignEventEmitter", () => {
  test("creates events.jsonl in .ccloop directory", async () => {
    const emitter = new DesignEventEmitter(testDir);
    await emitter.sessionStart("vision");

    const events = await readEvents(testDir);
    expect(events).toHaveLength(1);
  });

  test("sessionStart emits correct event", async () => {
    const emitter = new DesignEventEmitter(testDir);
    await emitter.sessionStart("vision");

    const events = await readEvents(testDir);
    expect(events[0].type).toBe("design_session_start");
    expect(events[0].phase).toBe("vision");
    expect(events[0].ts).toBeDefined();
  });

  test("askUserAsked emits correct event", async () => {
    const emitter = new DesignEventEmitter(testDir);
    await emitter.askUserAsked("Which approach should we use?");

    const events = await readEvents(testDir);
    expect(events[0].type).toBe("ask_user_asked");
    expect(events[0].question).toBe("Which approach should we use?");
  });

  test("askUserAnswered emits correct event with selections", async () => {
    const emitter = new DesignEventEmitter(testDir);
    await emitter.askUserAnswered(["option1", "option2"]);

    const events = await readEvents(testDir);
    expect(events[0].type).toBe("ask_user_answered");
    expect(events[0].selected).toEqual(["option1", "option2"]);
    expect(events[0].freeform).toBeUndefined();
  });

  test("askUserAnswered emits correct event with freeform", async () => {
    const emitter = new DesignEventEmitter(testDir);
    await emitter.askUserAnswered([], "Custom answer");

    const events = await readEvents(testDir);
    expect(events[0].type).toBe("ask_user_answered");
    expect(events[0].selected).toEqual([]);
    expect(events[0].freeform).toBe("Custom answer");
  });

  test("draftEdit emits correct event", async () => {
    const emitter = new DesignEventEmitter(testDir);
    await emitter.draftEdit(".ccloop/design/spec.draft.md");

    const events = await readEvents(testDir);
    expect(events[0].type).toBe("draft_edit");
    expect(events[0].file_path).toBe(".ccloop/design/spec.draft.md");
  });

  test("sessionAccept emits correct event", async () => {
    const emitter = new DesignEventEmitter(testDir);
    await emitter.sessionAccept(42, 1.23);

    const events = await readEvents(testDir);
    expect(events[0].type).toBe("design_session_accept");
    expect(events[0].turn_count).toBe(42);
    expect(events[0].total_cost_usd).toBe(1.23);
  });

  test("sessionAbort emits correct event", async () => {
    const emitter = new DesignEventEmitter(testDir);
    await emitter.sessionAbort("User cancelled");

    const events = await readEvents(testDir);
    expect(events[0].type).toBe("design_session_abort");
    expect(events[0].reason).toBe("User cancelled");
  });

  test("sessionEnd emits correct event for accepted outcome", async () => {
    const emitter = new DesignEventEmitter(testDir);
    await emitter.sessionEnd("accepted");

    const events = await readEvents(testDir);
    expect(events[0].type).toBe("design_session_end");
    expect(events[0].outcome).toBe("accepted");
  });

  test("sessionEnd emits correct event for aborted outcome", async () => {
    const emitter = new DesignEventEmitter(testDir);
    await emitter.sessionEnd("aborted");

    const events = await readEvents(testDir);
    expect(events[0].outcome).toBe("aborted");
  });

  test("sessionEnd emits correct event for error outcome", async () => {
    const emitter = new DesignEventEmitter(testDir);
    await emitter.sessionEnd("error");

    const events = await readEvents(testDir);
    expect(events[0].outcome).toBe("error");
  });

  test("multiple events are appended correctly", async () => {
    const emitter = new DesignEventEmitter(testDir);
    await emitter.sessionStart("vision");
    await emitter.askUserAsked("What users?");
    await emitter.draftEdit("spec.draft.md");

    const events = await readEvents(testDir);
    expect(events).toHaveLength(3);
    expect(events[0].type).toBe("design_session_start");
    expect(events[1].type).toBe("ask_user_asked");
    expect(events[2].type).toBe("draft_edit");
  });

  test("emit allows custom events", async () => {
    const emitter = new DesignEventEmitter(testDir);
    await emitter.emit({
      type: "design_session_start",
      timestamp: "2025-01-01T00:00:00.000Z",
      phase: "architecture",
    });

    const events = await readEvents(testDir);
    expect(events[0].type).toBe("design_session_start");
    expect(events[0].phase).toBe("architecture");
    expect(events[0].ts).toBe("2025-01-01T00:00:00.000Z");
  });
});

describe("createDesignEventEmitter", () => {
  test("returns a DesignEventEmitter instance", async () => {
    const emitter = createDesignEventEmitter(testDir);
    expect(emitter).toBeInstanceOf(DesignEventEmitter);

    await emitter.sessionStart("vision");
    const events = await readEvents(testDir);
    expect(events).toHaveLength(1);
  });
});
