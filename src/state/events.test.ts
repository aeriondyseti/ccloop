import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLogger, loadRecentEvents } from "./events.ts";
import { asIsoTimestamp, asRunId } from "../branded.ts";

describe("EventLogger", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ccloop-evt-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("creates parent dir and appends one JSON line per call", async () => {
    const path = join(dir, "nested", "events.jsonl");
    const log = new EventLogger(path);
    await log.append({ run_id: asRunId("r1"), step: 1, type: "step_start" });
    await log.append({ run_id: asRunId("r1"), step: 1, type: "step_end" });

    const text = await readFile(path, "utf8");
    const lines = text.trim().split("\n");
    expect(lines.length).toBe(2);
    const a = JSON.parse(lines[0]!);
    const b = JSON.parse(lines[1]!);
    expect(a.type).toBe("step_start");
    expect(b.type).toBe("step_end");
    expect(a.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test("loadRecentEvents returns last N entries, skips malformed, missing → []", async () => {
    const path = join(dir, "events.jsonl");
    const log = new EventLogger(path);
    for (let i = 0; i < 5; i++) {
      await log.append({ run_id: asRunId("r"), step: i, type: "step_start" });
    }
    // Inject a malformed line and a trailing newline.
    const { appendFile } = await import("node:fs/promises");
    await appendFile(path, "not-json\n", "utf8");
    await log.append({ run_id: asRunId("r"), step: 99, type: "step_end" });

    const recent = await loadRecentEvents(path, 3);
    expect(recent.length).toBe(3);
    expect(recent.at(-1)?.type).toBe("step_end");
    expect(recent.every((e) => typeof e.type === "string")).toBe(true);

    const empty = await loadRecentEvents(join(dir, "missing.jsonl"), 10);
    expect(empty).toEqual([]);
  });

  test("preserves a caller-supplied ts", async () => {
    const path = join(dir, "events.jsonl");
    const log = new EventLogger(path);
    const ts = asIsoTimestamp("2026-04-27T12:00:00.000Z");
    await log.append({ ts, run_id: asRunId("r1"), step: 0, type: "instance_start" });
    const rec = JSON.parse((await readFile(path, "utf8")).trim());
    expect(rec.ts).toBe("2026-04-27T12:00:00.000Z");
  });
});
