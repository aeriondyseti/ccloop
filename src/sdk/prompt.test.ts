import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_PROMPT_TEMPLATE, loadPromptTemplate, renderPrompt } from "./prompt.ts";

describe("renderPrompt", () => {
  test("default template substitutes step and last_error and ignores spec/progress", () => {
    const out = renderPrompt(DEFAULT_PROMPT_TEMPLATE, {
      spec: "SPEC_BODY",
      progress: "PROG",
      last_error: "ERR",
      step: 7,
    });
    expect(out).toContain("ERR");
    expect(out).toContain("#7");
    // The default template no longer inlines spec/progress — Claude
    // is told to Read them itself — so those placeholders aren't
    // present and SPEC_BODY/PROG must not leak into the rendered
    // prompt.
    expect(out).not.toContain("SPEC_BODY");
    expect(out).not.toContain("PROG");
    expect(out).not.toContain("{{step}}");
    expect(out).not.toContain("{{last_error}}");
  });

  test("custom templates can still reference {{spec}} and {{progress}}", () => {
    const out = renderPrompt("S={{spec}} P={{progress}}", {
      spec: "X", progress: "Y", last_error: "", step: 0,
    });
    expect(out).toBe("S=X P=Y");
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

  test("default template asks for the summary at the start, not the end", () => {
    // Regression: the prior template said "End your response with a
    // one-line summary..." while ccloop's commit-subject derivation
    // takes the FIRST non-blank line. The contradiction caused
    // commit subjects to be a preamble like "I'll add /healthz" or
    // "Looking at the spec…" rather than the actual summary.
    expect(DEFAULT_PROMPT_TEMPLATE).toContain("Begin your response");
    expect(DEFAULT_PROMPT_TEMPLATE).not.toContain("End your response");
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

  test("missing file at a non-empty override path throws (no silent fallback)", async () => {
    await expect(loadPromptTemplate(join(dir, "nope.md"))).rejects.toThrow(
      /prompt\.template_path=.*does not exist/,
    );
  });

  test("present file is read verbatim", async () => {
    const path = join(dir, "custom.md");
    await writeFile(path, "CUSTOM {{step}}");
    expect(await loadPromptTemplate(path)).toBe("CUSTOM {{step}}");
  });
});
