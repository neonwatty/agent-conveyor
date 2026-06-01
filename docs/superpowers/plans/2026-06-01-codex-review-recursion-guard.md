# Codex Review Recursion Guard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent the Codex review toolkit from recursively invoking itself during `codex review` runs, and preserve a repeatable QA receipt for future GoalBuddy conveyor work.

**Architecture:** The active helper is outside this repository at `/Users/neonwatty/.codex/skills/codex-review/scripts/codex-review`, so the recursion fix is a local skill/tooling patch rather than a repository source change. The helper should export an inherited guard environment variable before launching `codex review`; any nested helper invocation should fail closed with a clear message unless explicitly opted in. This repository should add a QA runbook documenting the guard smoke test so future conveyor boards can prove the review step is bounded.

**Tech Stack:** Bash, Git, GitHub CLI, Codex CLI review helper, GoalBuddy state checker, Markdown QA docs.

---

## Files

- Modify: `/Users/neonwatty/.codex/skills/codex-review/scripts/codex-review`
  - Adds the runtime recursion guard and opt-in escape hatch.
- Modify: `/Users/neonwatty/.codex/skills/codex-review/SKILL.md`
  - Documents the guard semantics for agents using the review skill.
- Create: `docs/qa/codex-review-recursion-guard.md`
  - Adds a repo-local QA smoke for the helper guard.
- Modify: `docs/qa/README.md`
  - Links the new QA smoke.
- Optional GoalBuddy board: `docs/goals/codex-review-recursion-guard/`
  - Use if we want the fix driven by the same conveyor receipt discipline as the live dogfood.

## Acceptance Criteria

- A nested invocation of `/Users/neonwatty/.codex/skills/codex-review/scripts/codex-review` exits nonzero with a clear refusal message when `CODEX_REVIEW_HELPER_LEVEL=1`.
- A normal top-level helper invocation still works and exports `CODEX_REVIEW_HELPER_LEVEL=1` only to child processes.
- `CODEX_REVIEW_ALLOW_NESTED=1` permits an intentional nested dry run for emergency debugging.
- Leading-zero and huge numeric `CODEX_REVIEW_HELPER_LEVEL` values cannot bypass the nested guard or trigger Bash arithmetic overflow.
- A fake Codex binary that tries to invoke the helper from inside an outer helper run gets blocked with exit code `78`.
- The repo QA doc includes copy-pasteable commands for the guard smoke and explains why this matters for GoalBuddy conveyor runs.
- Burden of proof: a deliberately recursive fake review path is blocked, and no `codex-review` or `codex review` child processes remain after the smoke.

---

### Task 1: Patch the Helper Guard

**Files:**
- Modify: `/Users/neonwatty/.codex/skills/codex-review/scripts/codex-review`

- [ ] **Step 1: Back up the current helper**

Run:

```bash
cp /Users/neonwatty/.codex/skills/codex-review/scripts/codex-review \
  /tmp/codex-review.pre-recursion-guard
```

Expected: command exits `0`.

- [ ] **Step 2: Add the guard after argument parsing and before `git rev-parse`**

Insert this block immediately after the `case "$mode"` validation block:

```bash
nested_level=${CODEX_REVIEW_HELPER_LEVEL:-0}
allow_nested=${CODEX_REVIEW_ALLOW_NESTED:-}
if ! [[ "$nested_level" =~ ^[0-9]+$ ]]; then
  echo "codex-review: invalid CODEX_REVIEW_HELPER_LEVEL=$nested_level" >&2
  exit 2
fi
nested_level_is_nested=false
if [[ "$nested_level" =~ [1-9] ]]; then
  nested_level_is_nested=true
fi
if [[ "$nested_level_is_nested" == true && "$allow_nested" != "1" ]]; then
  echo "codex-review refusal: nested codex-review invocation blocked; set CODEX_REVIEW_ALLOW_NESTED=1 only for intentional debugging" >&2
  exit 78
fi
if [[ "$nested_level_is_nested" != true ]]; then
  export CODEX_REVIEW_HELPER_LEVEL=1
elif (( ${#nested_level} <= 15 )); then
  export CODEX_REVIEW_HELPER_LEVEL=$((10#$nested_level + 1))
else
  export CODEX_REVIEW_HELPER_LEVEL=2
fi
export CODEX_REVIEW_HELPER_PARENT_PID=$$
```

- [ ] **Step 3: Syntax-check the helper**

Run:

```bash
bash -n /Users/neonwatty/.codex/skills/codex-review/scripts/codex-review
```

Expected: command exits `0`.

- [ ] **Step 4: Verify nested helper calls fail closed**

Run from `/Users/neonwatty/Desktop/codex-terminal-manager`:

```bash
set +e
CODEX_REVIEW_HELPER_LEVEL=1 \
  /Users/neonwatty/.codex/skills/codex-review/scripts/codex-review --mode local \
  >/tmp/codex-review-nested-stdout.txt \
  2>/tmp/codex-review-nested-stderr.txt
review_status=$?
set -e
cat /tmp/codex-review-nested-stderr.txt
test "$review_status" -eq 78
rg "nested codex-review invocation blocked" /tmp/codex-review-nested-stderr.txt
```

Expected: exit status is `78`, and stderr contains `nested codex-review invocation blocked`.

- [ ] **Step 5: Verify the explicit escape hatch still works for dry runs**

Run:

```bash
CODEX_REVIEW_HELPER_LEVEL=1 CODEX_REVIEW_ALLOW_NESTED=1 \
  /Users/neonwatty/.codex/skills/codex-review/scripts/codex-review \
  --mode local --codex-bin /bin/echo --dry-run \
  >/tmp/codex-review-allow-nested.txt
rg "review: /bin/echo review --uncommitted" /tmp/codex-review-allow-nested.txt
```

Expected: command exits `0` and prints the dry-run review command.

- [ ] **Step 6: Commit local skill patch receipt**

There is no repository commit for this local skill file. Record the local checksum:

```bash
shasum -a 256 /Users/neonwatty/.codex/skills/codex-review/scripts/codex-review \
  >/tmp/codex-review-helper-recursion-guard.sha256
cat /tmp/codex-review-helper-recursion-guard.sha256
```

Expected: command exits `0` and prints one SHA-256 hash line.

---

### Task 2: Prove the Guard Blocks Real Recursion Shape

**Files:**
- Read: `/Users/neonwatty/.codex/skills/codex-review/scripts/codex-review`
- Temporary: `/tmp/fake-codex-review-recursive`

- [ ] **Step 1: Create a fake Codex binary that tries to recurse**

Run:

```bash
current_pid=$$
ps -eo pid=,args= | awk -v self="$current_pid" '
  $1 != self && $0 ~ /[c]odex.*review|[c]odex-review/ { print $1 }
' | sort -u >/tmp/codex-review-before.pids

cat >/tmp/fake-codex-review-recursive <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
set +e
/Users/neonwatty/.codex/skills/codex-review/scripts/codex-review --mode local \
  >/tmp/fake-nested-codex-review.stdout \
  2>/tmp/fake-nested-codex-review.stderr
nested_status=$?
set -e
echo "nested-status:$nested_status"
cat /tmp/fake-nested-codex-review.stderr
exit 0
EOF
chmod +x /tmp/fake-codex-review-recursive
```

Expected: command exits `0`.

- [ ] **Step 2: Run the outer helper with the fake Codex binary**

Run from `/Users/neonwatty/Desktop/codex-terminal-manager`:

```bash
env -u CODEX_REVIEW_HELPER_LEVEL -u CODEX_REVIEW_HELPER_PARENT_PID \
  /Users/neonwatty/.codex/skills/codex-review/scripts/codex-review \
  --mode local \
  --codex-bin /tmp/fake-codex-review-recursive \
  >/tmp/codex-review-recursion-smoke.txt \
  2>&1
cat /tmp/codex-review-recursion-smoke.txt
rg "nested-status:78" /tmp/codex-review-recursion-smoke.txt
rg "nested codex-review invocation blocked" /tmp/codex-review-recursion-smoke.txt
```

Expected: command exits `0`, the nested helper exits `78`, and the refusal message is present.

- [ ] **Step 3: Verify no review helper processes leaked**

Run:

```bash
current_pid=$$
ps -eo pid=,args= | awk -v self="$current_pid" '
  $1 != self && $0 ~ /[c]odex.*review|[c]odex-review/ { print $1 }
' | sort -u >/tmp/codex-review-after.pids
comm -13 /tmp/codex-review-before.pids /tmp/codex-review-after.pids \
  >/tmp/codex-review-new.pids
if [ -s /tmp/codex-review-new.pids ]; then
  ps -p "$(paste -sd, /tmp/codex-review-new.pids)" -o pid=,args=
  exit 1
fi
```

Expected: no stale `codex-review` or `codex review --uncommitted` processes from the smoke remain.

---

### Task 3: Document the Skill Behavior

**Files:**
- Modify: `/Users/neonwatty/.codex/skills/codex-review/SKILL.md`

- [ ] **Step 1: Add a recursion guard note under `## Helper`**

Add this paragraph after the helper capability bullets:

````markdown
Recursion guard:
- The helper exports `CODEX_REVIEW_HELPER_LEVEL=1` to the nested `codex review` process.
- If a review session tries to invoke the helper again, the helper exits `78` with `nested codex-review invocation blocked`.
- Use `CODEX_REVIEW_ALLOW_NESTED=1` only for intentional debugging dry runs; do not use it in normal closeout, GoalBuddy conveyor, or PR review flows.
````

- [ ] **Step 2: Inspect the skill note**

Run:

```bash
rg -n "Recursion guard|CODEX_REVIEW_HELPER_LEVEL|CODEX_REVIEW_ALLOW_NESTED" \
  /Users/neonwatty/.codex/skills/codex-review/SKILL.md
```

Expected: the three new terms are present.

---

### Task 4: Add Repository QA Documentation

**Files:**
- Create: `docs/qa/codex-review-recursion-guard.md`
- Modify: `docs/qa/README.md`

- [ ] **Step 1: Create the QA smoke doc**

Create `docs/qa/codex-review-recursion-guard.md` with this content:

````markdown
# Codex Review Recursion Guard

Use this smoke after changing the local `codex-review` helper. It proves a
review session cannot recursively launch another review helper and leave
duplicate review processes running.

## Baseline

```bash
current_pid=$$
ps -eo pid=,args= | awk -v self="$current_pid" '
  $1 != self && $0 ~ /[c]odex.*review|[c]odex-review/ { print $1 }
' | sort -u >/tmp/codex-review-before.pids
```

## Direct Nested Block

```bash
set +e
CODEX_REVIEW_HELPER_LEVEL=1 \
  /Users/neonwatty/.codex/skills/codex-review/scripts/codex-review --mode local \
  >/tmp/codex-review-nested-stdout.txt \
  2>/tmp/codex-review-nested-stderr.txt
review_status=$?
set -e
cat /tmp/codex-review-nested-stderr.txt
test "$review_status" -eq 78
rg "nested codex-review invocation blocked" /tmp/codex-review-nested-stderr.txt
```

## Recursive Shape Smoke

```bash
cat >/tmp/fake-codex-review-recursive <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
set +e
/Users/neonwatty/.codex/skills/codex-review/scripts/codex-review --mode local \
  >/tmp/fake-nested-codex-review.stdout \
  2>/tmp/fake-nested-codex-review.stderr
nested_status=$?
set -e
echo "nested-status:$nested_status"
cat /tmp/fake-nested-codex-review.stderr
exit 0
EOF
chmod +x /tmp/fake-codex-review-recursive

env -u CODEX_REVIEW_HELPER_LEVEL -u CODEX_REVIEW_HELPER_PARENT_PID \
  /Users/neonwatty/.codex/skills/codex-review/scripts/codex-review \
  --mode local \
  --codex-bin /tmp/fake-codex-review-recursive \
  >/tmp/codex-review-recursion-smoke.txt \
  2>&1
cat /tmp/codex-review-recursion-smoke.txt
rg "nested-status:78" /tmp/codex-review-recursion-smoke.txt
rg "nested codex-review invocation blocked" /tmp/codex-review-recursion-smoke.txt
```

## Cleanup Proof

```bash
current_pid=$$
ps -eo pid=,args= | awk -v self="$current_pid" '
  $1 != self && $0 ~ /[c]odex.*review|[c]odex-review/ { print $1 }
' | sort -u >/tmp/codex-review-after.pids
comm -13 /tmp/codex-review-before.pids /tmp/codex-review-after.pids \
  >/tmp/codex-review-new.pids
if [ -s /tmp/codex-review-new.pids ]; then
  ps -p "$(paste -sd, /tmp/codex-review-new.pids)" -o pid=,args=
  exit 1
fi
```

The run passes only if no stale review processes remain.
````

- [ ] **Step 2: Link the QA smoke from the QA index**

Add this bullet to `docs/qa/README.md` near the other task files:

```markdown
- [Codex review recursion guard](codex-review-recursion-guard.md) - proves the
  local review helper blocks nested review invocations and does not leave stale
  review processes behind.
```

- [ ] **Step 3: Verify Markdown and links**

Run:

```bash
rg -n "Codex review recursion guard|nested-status:78|CODEX_REVIEW_HELPER_LEVEL" \
  docs/qa/codex-review-recursion-guard.md docs/qa/README.md
git diff --check
```

Expected: all terms are found and `git diff --check` exits `0`.

---

### Task 5: Run Final Verification and Publish Repository Docs

**Files:**
- Modified repo docs from Task 4.
- Local skill files from Tasks 1 and 3 are not part of this repository.

- [ ] **Step 1: Run focused local verification**

Run:

```bash
bash -n /Users/neonwatty/.codex/skills/codex-review/scripts/codex-review
CODEX_REVIEW_HELPER_LEVEL=1 \
  /Users/neonwatty/.codex/skills/codex-review/scripts/codex-review --mode local \
  >/tmp/codex-review-nested-stdout.txt \
  2>/tmp/codex-review-nested-stderr.txt; test "$?" -eq 78
rg "nested codex-review invocation blocked" /tmp/codex-review-nested-stderr.txt
rg -n "Codex review recursion guard|nested-status:78|CODEX_REVIEW_HELPER_LEVEL" \
  docs/qa/codex-review-recursion-guard.md docs/qa/README.md
git diff --check
```

Expected: every command exits `0`.

- [ ] **Step 2: Run the recursive smoke**

Run:

```bash
env -u CODEX_REVIEW_HELPER_LEVEL -u CODEX_REVIEW_HELPER_PARENT_PID \
  /Users/neonwatty/.codex/skills/codex-review/scripts/codex-review \
  --mode local \
  --codex-bin /tmp/fake-codex-review-recursive \
  >/tmp/codex-review-recursion-smoke.txt \
  2>&1
rg "nested-status:78" /tmp/codex-review-recursion-smoke.txt
rg "nested codex-review invocation blocked" /tmp/codex-review-recursion-smoke.txt
```

Expected: all commands exit `0`.

- [ ] **Step 3: Run process cleanup proof**

Run:

```bash
current_pid=$$
ps -eo pid=,args= | awk -v self="$current_pid" '
  $1 != self && $0 ~ /[c]odex.*review|[c]odex-review/ { print $1 }
' | sort -u >/tmp/codex-review-after.pids
comm -13 /tmp/codex-review-before.pids /tmp/codex-review-after.pids \
  >/tmp/codex-review-new.pids
if [ -s /tmp/codex-review-new.pids ]; then
  ps -p "$(paste -sd, /tmp/codex-review-new.pids)" -o pid=,args=
  exit 1
fi
```

Expected: no stale review helper or Codex review processes from the smoke remain.

- [ ] **Step 4: Commit and PR the repo docs**

Run:

```bash
git checkout -b codex/codex-review-recursion-guard-docs
git add docs/qa/codex-review-recursion-guard.md docs/qa/README.md
git commit -m "Document codex review recursion guard"
git push -u origin codex/codex-review-recursion-guard-docs
gh pr create \
  --title "Document codex review recursion guard" \
  --body "Adds a repeatable QA smoke for the local codex-review recursion guard. Local skill helper changes are outside the repository and are verified by the commands in the QA note." \
  --base main \
  --head codex/codex-review-recursion-guard-docs
```

Expected: PR is created.

- [ ] **Step 5: Monitor and merge when green**

Run:

```bash
gh pr checks --watch
gh pr merge --squash --delete-branch
```

Expected: GitHub checks are green and the docs PR is merged.

---

## GoalBuddy Conveyor Shape

If we drive this as a conveyor, use two child boards:

1. `local-skill-recursion-guard`
   - Scope: `/Users/neonwatty/.codex/skills/codex-review/scripts/codex-review` and `/Users/neonwatty/.codex/skills/codex-review/SKILL.md`.
   - Completion proof: direct nested block exits `78`, recursive fake Codex smoke records `nested-status:78`, cleanup proof shows no stale review processes.
   - No PR expected because this is local skill tooling outside the repository.

2. `repo-qa-recursion-guard-doc`
   - Scope: `docs/qa/codex-review-recursion-guard.md` and `docs/qa/README.md`.
   - Completion proof: focused docs checks, PR URL, green CI, merge SHA, and parent receipt update.

## Self-Review

- Spec coverage: The plan covers the observed failure mode, local helper patch, opt-in escape hatch, fake recursive smoke, process cleanup proof, docs, PR, CI, and merge.
- Placeholder scan: No unfinished placeholder markers or unspecified test steps remain.
- Type/name consistency: The guard variables are consistently named `CODEX_REVIEW_HELPER_LEVEL` and `CODEX_REVIEW_ALLOW_NESTED`; the intended nested-block exit code is consistently `78`.
