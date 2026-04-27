# ccloop pre-1.0 release checklist

Step-by-step for taking ccloop from "all the bones are wired and
180 tests pass" to "1.0.0 published on npm." Designed to be run on
any machine — the only prereq is a fresh clone of
`aeriondyseti/ccloop`.

Items are ordered so each step's output is the next step's input.
Don't skip ahead.

---

## 0. Machine prereqs (one-time per machine)

```bash
# Bun ≥ 1.1
curl -fsSL https://bun.sh/install | bash

# Linux only: bubblewrap for the Bash sandbox path
sudo apt install -y bubblewrap     # Debian/Ubuntu
sudo dnf install -y bubblewrap     # Fedora
# macOS: sandbox-exec is built-in.

# git, gh, npm/node should already be present.
gh auth status                     # must show logged in
node --version                     # ≥ 22 recommended
npm --version                      # ≥ 11.5 (CI bumps anyway)

# Claude Code CLI (provides the long-lived OAuth token)
npm i -g @anthropic-ai/claude-code
claude setup-token
# → copy the printed CLAUDE_CODE_OAUTH_TOKEN into your shell rc:
#   export CLAUDE_CODE_OAUTH_TOKEN=...
```

Clone and verify the baseline:

```bash
git clone https://github.com/aeriondyseti/ccloop.git
cd ccloop
bun install
bun run typecheck
bun test
# → 180+ tests, 0 fail
```

You don't need a global install; from here on, run ccloop as
`bun /path/to/ccloop/src/index.ts <args>` (alias as `ccloop` if you
want).

---

## 1. First real self-run

Goal: prove the loop actually drives Claude end-to-end.

```bash
# Pick a tiny scratch project somewhere outside the ccloop repo.
mkdir -p ~/scratch/md-to-text && cd ~/scratch/md-to-text

# Scaffold via ccloop init (uses templates/SPEC.md + templates/ccloop.toml).
bun /path/to/ccloop/src/index.ts init

# The default templates/SPEC.md is the Markdown-to-plaintext example.
# Either keep it as-is or edit SPEC.md to whatever you want to dogfood.

# Make sure the OAuth token is exported.
echo "${CLAUDE_CODE_OAUTH_TOKEN:?set me first}" >/dev/null

# Run it. Foreground TUI; Ctrl-C to abort.
bun /path/to/ccloop/src/index.ts run
```

What to watch for:

- TUI renders without crashing on whatever terminal size you have.
- Step counter advances; auto-commits land in `git log` (one per
  step, plus a `chore: ccloop init` initial commit).
- `/.ccloop/events.jsonl` accumulates entries; `/.ccloop/state.json`
  is rewritten atomically each step.
- The usage panel populates within ~30s (first
  `/api/oauth/usage` poll).
- Either `DONE.md` lands and ccloop exits 0, or it stalls and you
  capture why.

Things to record while it's running (for step 2):

- `cat .ccloop/events.jsonl | jq 'select(.type=="step_end")'` —
  you want `usage` numbers and `stop_reason` per step.
- A snapshot of `/api/oauth/usage` raw JSON. Easiest: while a run
  is live, in another shell:
  ```bash
  curl -s -H "Authorization: Bearer $CLAUDE_CODE_OAUTH_TOKEN" \
       -H "anthropic-beta: oauth-2025-04-20" \
       https://api.anthropic.com/api/oauth/usage | tee usage-snapshot.json
  ```

If the run dies before `DONE.md`, that's fine — you've still got
data for step 2 and bugs to file. Run it twice if the first one
crashes early.

**Exit criterion:** at least one run that either reaches `DONE.md`
or runs ≥ 10 steps without ccloop itself crashing.

---

## 2. Close §14 Known Unknowns

Open `.claude/SPEC.md` and find §14. For each entry, replace the
*Resolve* gloss with what you actually observed:

- **§14.1 Prompt-cache hit rate.** Sum
  `cache_read_input_tokens` vs `input_tokens` across step records:
  ```bash
  jq -s '
    map(select(.type=="step_end") | .usage)
    | { read: map(.cache_read_input_tokens // 0) | add,
        input: map(.input_tokens // 0) | add }
  ' < .ccloop/events.jsonl
  ```
  If `read / (read + input)` > ~0.5, cache is doing its job.
- **§14.2 `/api/oauth/usage` shape.** Paste the redacted
  `usage-snapshot.json` shape into the spec. Confirm the field
  names ccloop's `UsageClient` parses match reality.
- **§14.3 `stop_reason` distribution.**
  ```bash
  jq -r 'select(.type=="step_end") | .stop_reason' \
    < .ccloop/events.jsonl | sort | uniq -c
  ```
  Note any `stop_reason` values ccloop's `classify.ts` doesn't yet
  handle.
- **§14.4 Pause-then-resume timing.** You probably won't trip a
  real 5h cap in one self-run. Either accept this stays open, or
  artificially trip it by setting `pause_at_utilization = 1.0` in
  the target's `ccloop.toml` for a one-step run.

Commit the §14 updates on a feature branch off `dev` (see step 6).

---

## 3. TUI dogfood pass

Resize your terminal to exactly 80×24 (`stty rows 24 cols 80` on
most shells; on iTerm/Terminal.app, just drag). Then trigger each
non-RUNNING state and screenshot.

| State | How to trigger |
|---|---|
| `DONE` | Let a real run finish, or `touch DONE.md` then `ccloop run`. |
| `PAUSED` | In the target's `ccloop.toml`, set `pause_at_utilization = 1.0`. The first usage poll pauses the loop. |
| `GUARDRAIL_TRIP` | Set `[loop] max_steps = 1`, run a spec that won't finish in 1 step. |
| `ESCALATED` | Set `[failure] consecutive_failures_before_escalation = 1` and break the SPEC so Claude can't satisfy verification (e.g. require a file no tool can produce). |

For each: confirm layout doesn't wrap awkwardly, no ANSI bleed,
the legend / hotkeys row is visible. In `ESCALATED`, mash
`c` / `r` / `e` / `q` and verify they do what the spec says.

If anything's wrong, fix in `src/tui/` and re-test. Add a test in
`src/tui/projector.test.ts` for any layout bug you fixed.

---

## 4. Sandbox empirical check

With `[claude] yolo_mode = false` (the default), run a one-step
target spec that asks Claude to:

1. Write to `/tmp/ccloop-sandbox-test`. Should be denied (out of
   CWD). Confirm by: `ls /tmp/ccloop-sandbox-test` → no such file.
2. Run `curl https://example.com`. Should be denied (network
   call from Bash; current denylist may or may not catch this —
   document the result).
3. `rm -rf ~`. Should be denied (catastrophic-pattern denylist).

If any of these *aren't* denied, that's a sandbox bug. Patch
`src/sandbox/denylist.ts` or `src/sandbox/wrap.ts` and add a test.

macOS `sandbox-exec`: only test if you have a Mac. Otherwise note
"untested on macOS" against §6.5 of the spec and move on.

---

## 5. `ccloop init` polish

```bash
mkdir -p ~/scratch/init-smoke && cd ~/scratch/init-smoke
bun /path/to/ccloop/src/index.ts init
bun /path/to/ccloop/src/index.ts run --yes
```

If `run` errors with anything other than the auth gate or a
genuine spec-content issue, that's an init bug. Fix in
`src/cli/init.ts` and/or update `templates/`.

The acceptance bar: a brand-new user with a token set can clone
ccloop, `init` a scratch dir, and `run` without editing any
configuration file.

---

## 6. npm Trusted Publisher + branching

Has to happen before the first publish.

### 6a. Configure Trusted Publisher on npmjs.com

1. Sign in to https://www.npmjs.com.
2. **First-time package creation:** if `ccloop` doesn't exist yet,
   you have two options:
   - Pre-register the package via TP using npm's "Add a package"
     UI which now supports pre-creation through Trusted Publisher.
     Pick **GitHub Actions**, fill in:
     - Organization or user: `aeriondyseti`
     - Repository: `ccloop`
     - Workflow filename: `ci.yml`
     - Environment: *(blank)*
   - Or: `npm publish` once locally (requires login + 2FA), then
     configure TP afterwards in **Settings → Publishing access →
     Require two-factor authentication or automation tokens →
     Trusted Publisher**, same fields as above.
3. Confirm by visiting
   `https://www.npmjs.com/package/ccloop/access` — the Trusted
   Publisher row should show the GitHub repo + workflow.

### 6b. Create the `dev` branch

```bash
cd /path/to/ccloop
git push origin main:dev
```

The CI workflow expects `dev` to exist (the post-main reset
force-pushes onto it).

### 6c. Protect `main`

GitHub UI → **Settings → Branches → Add branch ruleset** for `main`:

- Require a pull request before merging.
- Required reviewers: add **Gemini Code Assist** and **Copilot**
  (per your global rules).
- Block direct pushes (the only exception is the CI's tag/release
  push, which uses `GITHUB_TOKEN` and is allowed by default).
- Allow force pushes: **off**.

Leave `dev` open — it's the integration branch.

---

## 7. README quickstart re-verification

Spin up a fresh shell — ideally a fresh container — clone
the repo, and copy-paste the README's Quickstart block verbatim.
Whatever doesn't work, fix in `README.md` until it does.

---

## 8. Ship 1.0.0

Once 1–7 are green:

```bash
# Branch off dev, bump version, commit, PR.
git checkout dev && git pull
git checkout -b release/1.0.0
npm version 1.0.0 --no-git-tag-version
git commit -am "chore: bump version to 1.0.0"
gh pr create --base dev --title "Release 1.0.0" --body "Pre-1.0 punch list complete."
# Merge via GitHub UI (no review gate on dev). CI publishes
# 1.0.0-dev.<run> with the @dev tag.
```

Smoke-test the dev publish:

```bash
npm install -g ccloop@dev
ccloop --version    # should print 1.0.0-dev.N
ccloop init && ccloop run    # against a scratch dir
```

If green:

```bash
gh pr create --base main --head dev \
   --title "Release 1.0.0" \
   --body "Promotes dev to 1.0.0. Pre-1.0 checklist closed."
# Add Gemini + Copilot as reviewers in the PR UI.
```

After both reviews approve and you merge, CI:

1. Publishes `ccloop@1.0.0` with `--tag latest`.
2. Creates `v1.0.0` git tag.
3. Creates GitHub Release `v1.0.0` with auto-generated notes.
4. Force-pushes `main` onto `dev`.

Verify:

```bash
npm view ccloop dist-tags
# → { latest: '1.0.0', dev: '1.0.0-dev.N' }

gh release view v1.0.0
```

Done. Delete `.claude/` if you want (it's marked ephemeral); the
spec served its purpose.

---

## If something goes sideways

- **Publish fails with "OIDC token missing"**: the workflow needs
  `permissions: id-token: write`. Already set in `ci.yml`, but
  if you forked or edited, double-check.
- **Publish fails with "package already exists at this version"**:
  on `main`, version in `package.json` must be incremented before
  merge. This is intentional — there's no auto-bump on `main`.
- **`dev` reset force-push rejected**: someone direct-pushed to
  `dev` between the last main merge and the CI run. Either rebase
  the dev work onto main or accept the loss.
- **Trusted Publisher fails verification**: most common cause is
  workflow-file mismatch. The TP config must point at the exact
  `.github/workflows/ci.yml` path — case-sensitive.
