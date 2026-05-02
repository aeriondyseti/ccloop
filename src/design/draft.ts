/** Draft management for the design loop: initialize from the
 *  bundled `templates/SPEC.md`, load/validate, and promote
 *  `spec.draft.md` (plus sibling artifacts) into the project root
 *  on accept. */

import { readFile, writeFile, mkdir, copyFile, access } from "node:fs/promises";
import { join, dirname } from "node:path";
import { isENOENT } from "../errors.ts";
import { validateSpecText, type SpecCheck } from "../config/spec.ts";
import { getDesignPaths, getDesignDir } from "./paths.ts";

/** Returns true if a fresh draft was created, false if one already
 *  existed (the caller can use this to print a "resuming…" hint). */
export async function initializeDraft(
  cwd: string,
  templatePath?: string,
): Promise<boolean> {
  const paths = getDesignPaths(cwd);
  try {
    await access(paths.draft);
    return false;
  } catch (err) {
    if (!isENOENT(err)) throw err;
  }
  await mkdir(getDesignDir(cwd), { recursive: true });
  const defaultTemplatePath = join(import.meta.dir, "..", "..", "templates", "SPEC.md");
  await copyFile(templatePath ?? defaultTemplatePath, paths.draft);
  return true;
}

export async function loadDraft(cwd: string): Promise<string> {
  return await readFile(getDesignPaths(cwd).draft, "utf8");
}

export async function loadDraftIfExists(cwd: string): Promise<string | null> {
  try {
    return await loadDraft(cwd);
  } catch (err) {
    if (isENOENT(err)) return null;
    throw err;
  }
}

export async function validateDraft(cwd: string): Promise<SpecCheck> {
  return validateSpecText(await loadDraft(cwd));
}

/** Promote the draft (and any sibling artifacts the agent wrote) to
 *  the project root. Returns the list of files copied. */
export async function promoteDraft(cwd: string): Promise<string[]> {
  const paths = getDesignPaths(cwd);
  const promoted: string[] = [];

  await copyFile(paths.draft, join(cwd, "SPEC.md"));
  promoted.push("SPEC.md");

  const siblings: Array<{ src: string; dest: string }> = [
    { src: paths.roadmap, dest: join(cwd, "ROADMAP.md") },
    { src: paths.ideas, dest: join(cwd, "IDEAS.md") },
    { src: paths.techDebt, dest: join(cwd, "TECH-DEBT.md") },
  ];
  for (const { src, dest } of siblings) {
    try {
      await access(src);
      await copyFile(src, dest);
      promoted.push(dest.replace(cwd + "/", ""));
    } catch (err) {
      if (!isENOENT(err)) throw err;
    }
  }
  return promoted;
}

export async function saveDraft(cwd: string, content: string): Promise<void> {
  const paths = getDesignPaths(cwd);
  await mkdir(dirname(paths.draft), { recursive: true });
  await writeFile(paths.draft, content, "utf8");
}
