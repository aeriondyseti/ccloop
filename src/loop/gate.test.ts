import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGate } from "./gate.ts";

function mkTmp(): string {
  return mkdtempSync(join(tmpdir(), "ccloop-gate-"));
}

describe("runGate", () => {
  test("exit 0 → ok with empty excerpt", async () => {
    const cwd = mkTmp();
    try {
      const r = await runGate({ cwd, command: "true", timeoutSeconds: 5 });
      expect(r.ok).toBe(true);
      expect(r.exitCode).toBe(0);
      expect(r.excerpt).toBe("");
      expect(r.timedOut).toBe(false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("non-zero exit → failure with command + tail", async () => {
    const cwd = mkTmp();
    try {
      const r = await runGate({
        cwd,
        command: "echo hello && echo bad >&2 && exit 7",
        timeoutSeconds: 5,
      });
      expect(r.ok).toBe(false);
      expect(r.exitCode).toBe(7);
      expect(r.excerpt).toContain("exit 7");
      expect(r.excerpt).toContain("hello");
      expect(r.excerpt).toContain("bad");
      expect(r.timedOut).toBe(false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("hung command is killed at the timeout", async () => {
    const cwd = mkTmp();
    try {
      const start = Date.now();
      // Spawn a sub-shell that itself spawns sleep, exercising the
      // process-group kill path (SIGKILL on the shell alone would
      // orphan the sleep).
      const r = await runGate({ cwd, command: "sh -c 'sleep 30'", timeoutSeconds: 1 });
      const elapsed = Date.now() - start;
      expect(r.ok).toBe(false);
      expect(r.timedOut).toBe(true);
      expect(r.excerpt).toContain("timed out");
      expect(elapsed).toBeLessThan(5000);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("multi-step pipeline runs through sh -c", async () => {
    const cwd = mkTmp();
    try {
      const r = await runGate({
        cwd,
        command: "true && echo ok",
        timeoutSeconds: 5,
      });
      expect(r.ok).toBe(true);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
