/**
 * Draft management utilities for the design loop.
 *
 * Handles initialization, loading, validation, and promotion of spec.draft.md
 */

import { readFile, writeFile, mkdir, copyFile, access } from "node:fs/promises";
import { join, dirname } from "node:path";
import { isENOENT } from "../errors.ts";
import { validateSpecText, type SpecCheck } from "../config/spec.ts";
import { getDesignPaths, getDesignDir } from "./paths.ts";

/**
 * Initialize a new draft from the template SPEC.md.
 *
 * Creates .ccloop/design/ directory if needed and copies the template
 * to spec.draft.md. If a draft already exists, this is a no-op.
 *
 * @param cwd - Current working directory
 * @param templatePath - Path to templates/SPEC.md (defaults to bundled template)
 * @returns true if a new draft was created, false if one already existed
 */
export async function initializeDraft(
  cwd: string,
  templatePath?: string
): Promise<boolean> {
  const paths = getDesignPaths(cwd);
  const designDir = getDesignDir(cwd);

  // Check if draft already exists
  try {
    await access(paths.draft);
    return false; // Draft already exists
  } catch (err) {
    if (!isENOENT(err)) throw err;
  }

  // Create design directory
  await mkdir(designDir, { recursive: true });

  // Determine template path
  const defaultTemplatePath = join(import.meta.dir, "..", "..", "templates", "SPEC.md");
  const sourcePath = templatePath ?? defaultTemplatePath;

  // Copy template to draft
  await copyFile(sourcePath, paths.draft);

  return true;
}

/**
 * Load the current draft content.
 *
 * @param cwd - Current working directory
 * @returns Draft content as string
 * @throws If draft doesn't exist or can't be read
 */
export async function loadDraft(cwd: string): Promise<string> {
  const paths = getDesignPaths(cwd);
  return await readFile(paths.draft, "utf8");
}

/**
 * Load draft content if it exists, otherwise return null.
 *
 * @param cwd - Current working directory
 * @returns Draft content or null if doesn't exist
 */
export async function loadDraftIfExists(cwd: string): Promise<string | null> {
  try {
    return await loadDraft(cwd);
  } catch (err) {
    if (isENOENT(err)) return null;
    throw err;
  }
}

/**
 * Validate the draft using the same validation as SPEC.md.
 *
 * Checks that the draft has:
 * - At least one checklist item
 * - A "## Verification Requirements" section with content
 *
 * @param cwd - Current working directory
 * @returns Validation result
 */
export async function validateDraft(cwd: string): Promise<SpecCheck> {
  const content = await loadDraft(cwd);
  return validateSpecText(content);
}

/**
 * Promote the draft to SPEC.md.
 *
 * Copies spec.draft.md to ./SPEC.md at the project root.
 * Also copies any sibling artifacts (ROADMAP.md, IDEAS.md, TECH-DEBT.md)
 * if they exist.
 *
 * @param cwd - Current working directory
 * @returns List of files that were promoted
 */
export async function promoteDraft(cwd: string): Promise<string[]> {
  const paths = getDesignPaths(cwd);
  const promoted: string[] = [];

  // Always promote the main draft
  const specPath = join(cwd, "SPEC.md");
  await copyFile(paths.draft, specPath);
  promoted.push("SPEC.md");

  // Promote sibling artifacts if they exist
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
      // File doesn't exist, skip it
    }
  }

  return promoted;
}

/**
 * Save content to the draft.
 *
 * @param cwd - Current working directory
 * @param content - New content for the draft
 */
export async function saveDraft(cwd: string, content: string): Promise<void> {
  const paths = getDesignPaths(cwd);
  const designDir = dirname(paths.draft);

  // Ensure design directory exists
  await mkdir(designDir, { recursive: true });

  // Write the content
  await writeFile(paths.draft, content, "utf8");
}
