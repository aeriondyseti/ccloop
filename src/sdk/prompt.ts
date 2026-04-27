import { readFile } from "node:fs/promises";
import { isENOENT } from "../errors.ts";

export const DEFAULT_PROMPT_TEMPLATE = `You are working in a loop driven by ccloop. Keep making progress on
this project until every Verification Requirement in SPEC.md is
satisfied, and only then create DONE.md.

# Spec

{{spec}}

# Progress so far

{{progress}}

{{last_error}}

# Your task this step (#{{step}})

1. Read the spec, paying special attention to the
   \`## Verification Requirements\` section.
2. Pick the most useful next step toward satisfying those requirements.
   Smaller, verifiable changes are better than ambitious ones.
3. Make the change. Run whatever checks the spec implies (tests,
   linters, etc.) so you have evidence the change is good.
4. Update \`./.ccloop/progress.md\` with a short note about what you
   did and what you learned. Append; do not rewrite.
5. If — and only if — every Verification Requirement is now
   satisfied, create \`./DONE.md\` at the project root with a brief
   paragraph for each requirement explaining how it's met. Do not
   create \`DONE.md\` speculatively.

ccloop will commit your work after this step ends. Don't run
\`git commit\` yourself.
`;

export interface PromptVars {
  spec: string;
  progress: string;
  last_error: string;
  step: number;
}

export async function loadPromptTemplate(overridePath: string): Promise<string> {
  if (!overridePath) return DEFAULT_PROMPT_TEMPLATE;
  try {
    return await readFile(overridePath, "utf8");
  } catch (err) {
    if (isENOENT(err)) return DEFAULT_PROMPT_TEMPLATE;
    throw err;
  }
}

export function renderPrompt(template: string, vars: PromptVars): string {
  return template
    .replaceAll("{{spec}}", vars.spec)
    .replaceAll("{{progress}}", vars.progress)
    .replaceAll("{{last_error}}", vars.last_error)
    .replaceAll("{{step}}", String(vars.step));
}
