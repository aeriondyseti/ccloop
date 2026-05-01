# ccloop — agent instructions

You are working on **ccloop**, a TypeScript/Bun CLI that drives Claude
Code in a loop against a target project's `SPEC.md` until the project
is done.

## Read this first

The full design contract is in **`.claude/SPEC.md`**. Read it before
making substantive changes. It defines vocabulary, the iteration
model, validation rules, and behavior contracts that you should not
violate without surfacing the change.

Two other files set context:

- **`ROADMAP.md`** — items deliberately scoped out of MVP. Don't
  implement them; if you find yourself wanting to, propose a
  ROADMAP-aligned discussion instead.
- **`IDEAS.md`** — sibling-project ideas. Not part of ccloop. Ignore
  unless explicitly directed.

## Three specs exist — don't confuse them

This repo has THREE files named `SPEC.md` in different roles:

- **`.claude/SPEC.md`** — *ccloop's own spec*. The build contract
  for this codebase. This is what you read before making
  substantive changes.
- **`templates/SPEC.md`** — *an example/starter spec for users of
  ccloop*. Shipped as a scaffold for `ccloop init` to copy. NOT a
  spec for ccloop itself.
- **`./SPEC.md`** (repo root) — *a build target spec*. May be created
  by `ccloop design` or when running ccloop on this repo in dogfood
  mode to build new ccloop features. Describes what needs to be
  built, not ccloop's contract. Treat it the same way ccloop normally
  treats `./SPEC.md` in any target project: it is the build target
  for the current run.

When `.claude/SPEC.md` says "the spec," it means whatever
`./SPEC.md` is in the project ccloop is being run against. Inside
this repo, that overlaps with the dogfood spec at `./SPEC.md` — the
ccloop-on-ccloop case.

If you need to change ccloop's own contract (vocabulary, iteration
model, etc.), that lives in `.claude/SPEC.md`. If you're
implementing the feature described at `./SPEC.md`, that's the
dogfood target — finish the checklist, write `DONE.md`, don't
edit `.claude/SPEC.md` unless the feature genuinely changes the
contract.

## Vocabulary cheatsheet

These terms are pinned (full definitions in §2 of `.claude/SPEC.md`):

- **Run** — whole project; may span multiple instances.
- **Instance** — one OS process lifetime of `ccloop`.
- **Step** — one SDK `query` / one full agentic session. ccloop's
  loop counter.
- **Turn** — Anthropic's "turn" (one assistant response + tool
  execution). Internal to a step.
- **Inference** — colloquial; one HTTP call to the model.

The Agent SDK's `maxTurns` parameter counts Anthropic-turns, which
in ccloop's vocabulary are *inferences per step*. The §2.5 footnote
in the spec disambiguates wherever this matters.

## Hard rules

- Never write outside the user's CWD when ccloop runs in production.
  All ccloop runtime state lives in `./.ccloop/`. Deleting that
  directory must leave a clean target project.
- Never break the "no global state" rule (`~/.ccloop/` does not
  exist; nothing in `~/.config/`, `~/.cache/`, etc.).
- Never commit `.ccloop/` from this repo's tests. The root
  `.gitignore` excludes it.

## Ephemeral

This `.claude/` directory is ephemeral. Once ccloop ships and works,
it can be deleted. The spec exists as a build contract, not as
living documentation. Don't future-proof its contents.
