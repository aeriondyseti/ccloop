import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateSpec, validateSpecText } from "./spec.ts";

describe("validateSpecText", () => {
  test("happy path", () => {
    const r = validateSpecText(
      `# X\n\n- [ ] one\n- [x] two\n\n## Verification Requirements\n\n1. tests pass\n`,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.checklistCount).toBe(2);
  });

  test("missing checklist", () => {
    const r = validateSpecText(`# X\n\n## Verification Requirements\n\n1. ok\n`);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/checklist/);
  });

  test("missing VR heading", () => {
    const r = validateSpecText(`# X\n- [ ] a\n`);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/Verification Requirements/);
  });

  test("empty VR body", () => {
    const r = validateSpecText(`- [ ] a\n## Verification Requirements\n`);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/empty/);
  });

  test("VR body bounded by next h2", () => {
    const r = validateSpecText(
      `- [ ] a\n## Verification Requirements\n\nbody\n\n## Other\n\nstuff`,
    );
    expect(r.ok).toBe(true);
  });
});

describe("validateSpec", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ccloop-spec-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("missing SPEC.md returns helpful error", async () => {
    const r = await validateSpec(dir);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/missing.*SPEC\.md/);
  });

  test("present SPEC.md is read and validated", async () => {
    await writeFile(
      join(dir, "SPEC.md"),
      `- [ ] one\n## Verification Requirements\n\nbody\n`,
    );
    const r = await validateSpec(dir);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.checklistCount).toBe(1);
  });
});
