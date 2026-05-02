import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { isENOENT } from "../errors.ts";
import { SPEC_FILENAME } from "../state/paths.ts";
import { parseChecklist } from "../spec/checklist.ts";

export type SpecCheck =
  | { ok: true; checklistCount: number }
  | { ok: false; error: string };

const VR_HEADING_RE = /^##\s+Verification Requirements\s*$/mi;

export async function validateSpec(cwd: string): Promise<SpecCheck> {
  const path = join(cwd, SPEC_FILENAME);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if (isENOENT(err)) {
      return { ok: false, error: `missing ./${SPEC_FILENAME}. Run \`ccloop init\` to scaffold one.` };
    }
    throw err;
  }
  return validateSpecText(text);
}

export function validateSpecText(text: string): SpecCheck {
  // Share parsing with the dashboard/recap so a user whose spec uses
  // `*` or numbered bullets isn't told "no checklist" by validation
  // while the dashboard happily counts the same items.
  const checklistCount = parseChecklist(text).total;
  if (checklistCount === 0) {
    return { ok: false, error: `${SPEC_FILENAME} has no checklist (need at least one \`- [ ]\` or \`- [x]\` line).` };
  }
  const vrMatch = VR_HEADING_RE.exec(text);
  if (!vrMatch) {
    return { ok: false, error: `${SPEC_FILENAME} is missing the \`## Verification Requirements\` heading.` };
  }
  const after = text.slice(vrMatch.index + vrMatch[0].length);
  // Body = text after the heading until the next h2 (or EOF), trimmed.
  const nextH2 = /^##\s+/m.exec(after);
  const body = (nextH2 ? after.slice(0, nextH2.index) : after).trim();
  if (body.length === 0) {
    return { ok: false, error: `${SPEC_FILENAME} \`## Verification Requirements\` body is empty.` };
  }
  return { ok: true, checklistCount };
}
