/**
 * Acceptance and validation gate for design loop.
 *
 * Handles the flow when a user signals they want to accept the draft:
 * 1. Validate the draft
 * 2. If validation fails, return errors
 * 3. If validation passes, promote draft + sibling artifacts
 */

import { validateDraft, promoteDraft } from "./draft.ts";
import type { SpecCheck } from "../config/spec.ts";

/**
 * Result of attempting to accept a draft.
 */
export type AcceptanceResult =
  | { accepted: false; validationError: string }
  | { accepted: true; promotedFiles: string[] };

/**
 * Attempt to accept and promote the draft.
 *
 * Validates the draft first. If validation fails, returns the error.
 * If validation passes, promotes the draft and sibling artifacts to
 * the project root.
 *
 * @param cwd - Current working directory
 * @returns Acceptance result (accepted or validation error)
 */
export async function acceptDraft(cwd: string): Promise<AcceptanceResult> {
  try {
    // Validate the draft
    const validation = await validateDraft(cwd);

    if (!validation.ok) {
      return {
        accepted: false,
        validationError: validation.error,
      };
    }

    // Validation passed, promote the draft
    const promotedFiles = await promoteDraft(cwd);

    return {
      accepted: true,
      promotedFiles,
    };
  } catch (err) {
    // Handle unexpected errors (file I/O, etc.)
    const message = err instanceof Error ? err.message : String(err);
    return {
      accepted: false,
      validationError: `Failed to accept draft: ${message}`,
    };
  }
}

/**
 * Validate the draft without promoting.
 *
 * Useful for checking draft validity before prompting for acceptance.
 *
 * @param cwd - Current working directory
 * @returns Validation result
 */
export async function checkDraftValidity(cwd: string): Promise<SpecCheck> {
  try {
    return await validateDraft(cwd);
  } catch (err) {
    // If the draft doesn't exist or can't be read, return an error
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: `Failed to read draft: ${message}`,
    };
  }
}

/**
 * Format validation errors for display to the user.
 *
 * @param error - Validation error message
 * @returns Formatted error message
 */
export function formatValidationError(error: string): string {
  return `Draft validation failed:\n\n${error}\n\nPlease update the draft to fix these issues before accepting.`;
}

/**
 * Generate a confirmation prompt for accepting the draft.
 *
 * @param checklistCount - Number of checklist items in the draft
 * @returns Confirmation prompt text
 */
export function generateAcceptancePrompt(checklistCount: number): string {
  return (
    `The draft is valid and ready to promote.\n\n` +
    `This will:\n` +
    `  • Copy spec.draft.md to SPEC.md (${checklistCount} checklist items)\n` +
    `  • Copy any sibling artifacts (ROADMAP.md, IDEAS.md, TECH-DEBT.md) if they exist\n\n` +
    `Promote draft to SPEC.md?`
  );
}
