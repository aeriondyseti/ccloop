# SPEC

> Replace this preamble with a one-paragraph description of what
> you want built. Be concrete. ccloop will read this file every
> step, so what you write here is what Claude works against.

A short CLI tool that converts Markdown files to plain text by
stripping all formatting (bold, italic, links, code fences, headings)
while preserving the underlying prose and paragraph structure.

## Scope

Replace this list with your own. The checklist is informational —
ccloop renders it on the dashboard so you can watch progress, but
ccloop does not gate on it. Claude is instructed to tick items off
as it completes them.

- [ ] Project scaffolding (Bun, TypeScript, basic test runner).
- [ ] CLI entrypoint that takes a path or stdin and writes plain text
      to stdout.
- [ ] Strip headings, emphasis, links, code fences, lists, blockquotes.
- [ ] Preserve paragraph breaks.
- [ ] Tests covering each transformation.
- [ ] README with usage examples.

## Verification Requirements

When all of these are satisfied, Claude creates `DONE.md` at the
project root with a paragraph for each item explaining how it's met.
Until then, Claude keeps working.

The default list — edit freely to match what "done" actually means
for your project:

1. All SPEC.md checkboxes complete.
2. All tests pass.
3. Code has at least 75% branch coverage.
