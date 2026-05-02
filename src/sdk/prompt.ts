import { readFile } from "node:fs/promises";
import { isENOENT } from "../errors.ts";

export const DEFAULT_PROMPT_TEMPLATE = `You are working in a loop driven by ccloop. Keep making progress on
this project until every Verification Requirement in \`./SPEC.md\` is
satisfied, and only then create \`./DONE.md\`.

The spec lives at \`./SPEC.md\` and the running journal lives at
\`./.ccloop/progress.md\`. Read each one with your \`Read\` tool if
you haven't already loaded it in this session — ccloop deliberately
does not paste them into this prompt.

{{rotation_summary}}{{last_error}}

# Your task this step (#{{step}})

1. If you don't already have it in context, read \`./SPEC.md\` —
   especially the \`## Verification Requirements\` section — and
   skim the tail of \`./.ccloop/progress.md\` to see what's been done.
2. Pick the most useful next step toward satisfying those requirements.
   Smaller, verifiable changes are better than ambitious ones.
3. Make the change. Run whatever checks the spec implies (tests,
   linters, type-checks, etc.) so you have evidence the change is good.
4. If your change finishes a checklist item in \`./SPEC.md\`, mark it
   \`- [x]\` so the spec stays current.
5. Append a short note to \`./.ccloop/progress.md\` — one or two lines:
   what you changed and *why*, plus any non-obvious thing the next
   step should know (a flaky test, a half-finished refactor, a decision
   you deferred). Append; do not rewrite.
6. If — and only if — every Verification Requirement is now satisfied,
   create \`./DONE.md\` at the project root with a brief paragraph for
   each requirement explaining how it's met. Do not create \`DONE.md\`
   speculatively.

Begin your response with a one-line summary of what this step did —
ccloop uses your first non-blank line as the auto-commit subject, so
make sure the first thing you write is short and active (e.g.
\`feat(api): add /healthz\`), not a preamble. After the summary
line, you can explain whatever else the operator should know.

ccloop will commit your work after this step ends. Don't run
\`git commit\` yourself.
`;

export interface PromptVars {
  spec: string;
  progress: string;
  last_error: string;
  step: number;
  /** Optional carry-over summary from a just-rotated session. Empty
   *  string disables the rendering. The driver clears the source
   *  state field after this is consumed so subsequent steps don't
   *  keep replaying the same summary. */
  rotation_summary: string;
}

/** Load the per-run prompt template. Empty `overridePath` returns the
 *  embedded default. A non-empty `overridePath` that doesn't resolve
 *  is a *configuration error* and throws — the previous silent
 *  fall-through was a footgun for overnight runs (a typo in
 *  `prompt.template_path` would invisibly use the default). */
export async function loadPromptTemplate(overridePath: string): Promise<string> {
  if (!overridePath) return DEFAULT_PROMPT_TEMPLATE;
  try {
    return await readFile(overridePath, "utf8");
  } catch (err) {
    if (isENOENT(err)) {
      throw new Error(
        `prompt.template_path="${overridePath}" does not exist. ` +
        `Leave it empty to use the embedded default.`,
      );
    }
    throw err;
  }
}

export function renderPrompt(template: string, vars: PromptVars): string {
  return template
    .replaceAll("{{spec}}", vars.spec)
    .replaceAll("{{progress}}", vars.progress)
    .replaceAll("{{last_error}}", vars.last_error)
    .replaceAll("{{rotation_summary}}", renderRotationSummary(vars.rotation_summary))
    .replaceAll("{{step}}", String(vars.step));
}

/** Wrap a non-empty rotation summary in a markdown heading so it's
 *  visually distinct from the rest of the prompt. Empty input
 *  returns empty string so the slot disappears in normal steps. */
export function renderRotationSummary(summary: string): string {
  const trimmed = summary.trim();
  if (!trimmed) return "";
  return (
    "# Picking up from a rotated session\n\n" +
    "The previous SDK session approached its context limit and was " +
    "rotated. Here is its self-summary; treat it as ground truth for " +
    "what's already been done and pick the next concrete step from " +
    "that state.\n\n" +
    "> " + trimmed.split("\n").join("\n> ") + "\n\n"
  );
}
