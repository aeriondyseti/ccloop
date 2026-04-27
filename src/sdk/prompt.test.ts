import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_PROMPT_TEMPLATE, loadPromptTemplate, renderPrompt } from "./prompt.ts";

describe("renderPrompt", () => {
  test("substitutes all four variables", () => {
    const out = renderPrompt(DEFAULT_PROMPT_TEMPLATE, {
      spec: "SPEC_BODY",
      progress: "PROG",
      last_error: "ERR",
      step: 7,
    });
    expect(out).toContain("SPEC_BODY");
    expect(out).toContain("PROG");
    expect(out).toContain("ERR");
    expect(out).toContain("#7");
    expect(out).not.toContain("{{spec}}");
    expect(out).not.toContain("{{step}}");
  });

  test("multiple occurrences are all replaced", () => {
    const out = renderPrompt("{{step}} / {{step}} / {{spec}}", {
      spec: "S",
      progress: "",
      last_error: "",
      step: 3,
    });
    expect(out).toBe("3 / 3 / S");
  });

  test("empty last_error renders cleanly", () => {
    const out = renderPrompt("X{{last_error}}Y", {
      spec: "", progress: "", last_error: "", step: 1,
    });
    expect(out).toBe("XY");
  });
});

describe("loadPromptTemplate", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ccloop-tpl-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("empty path returns the embedded default", async () => {
    expect(await loadPromptTemplate("")).toBe(DEFAULT_PROMPT_TEMPLATE);
  });

  test("missing file falls back to the embedded default", async () => {
    expect(await loadPromptTemplate(join(dir, "nope.md"))).toBe(DEFAULT_PROMPT_TEMPLATE);
  });

  test("present file is read verbatim", async () => {
    const path = join(dir, "custom.md");
    await writeFile(path, "CUSTOM {{step}}");
    expect(await loadPromptTemplate(path)).toBe("CUSTOM {{step}}");
  });
});
