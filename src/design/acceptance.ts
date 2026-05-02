/** Acceptance + validation gate for the design loop: when the user
 *  signals accept, validate the draft, and promote it (plus sibling
 *  artifacts) to the project root if validation passes. */

import { validateDraft, promoteDraft } from "./draft.ts";
import type { SpecCheck } from "../config/spec.ts";

export type AcceptanceResult =
  | { accepted: false; validationError: string }
  | { accepted: true; promotedFiles: string[] };

export async function acceptDraft(cwd: string): Promise<AcceptanceResult> {
  try {
    const validation = await validateDraft(cwd);
    if (!validation.ok) {
      return { accepted: false, validationError: validation.error };
    }
    const promotedFiles = await promoteDraft(cwd);
    return { accepted: true, promotedFiles };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { accepted: false, validationError: `Failed to accept draft: ${message}` };
  }
}

export async function checkDraftValidity(cwd: string): Promise<SpecCheck> {
  try {
    return await validateDraft(cwd);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Failed to read draft: ${message}` };
  }
}

export function formatValidationError(error: string): string {
  return `Draft validation failed:\n\n${error}\n\nPlease update the draft to fix these issues before accepting.`;
}

export function generateAcceptancePrompt(checklistCount: number): string {
  return (
    `The draft is valid and ready to promote.\n\n` +
    `This will:\n` +
    `  • Copy spec.draft.md to SPEC.md (${checklistCount} checklist items)\n` +
    `  • Copy any sibling artifacts (ROADMAP.md, IDEAS.md, TECH-DEBT.md) if they exist\n\n` +
    `Promote draft to SPEC.md?`
  );
}
