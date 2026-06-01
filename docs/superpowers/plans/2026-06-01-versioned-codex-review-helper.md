# Versioned Codex Review Helper Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the guarded `codex-review` helper reproducible from this repository instead of depending on one machine's patched `~/.codex` skill copy.

**Architecture:** Add `codex-review` as a versioned repo skill beside `manage-codex-workers`, teach `scripts/install-local` to install both skills into `$CODEX_HOME/skills`, and make `doctor-self`, README, and QA docs prove the installed helper is present and guarded. The proof must be adversarial: stale installed helper content, missing helper script bits, inherited review guard variables, huge numeric guard values, recursive fake review runs, and process leaks must all be tested explicitly.

**Tech Stack:** Bash, Python `unittest`, GitHub CLI, Codex skill layout, `scripts/install-local`, `workerctl doctor-self`, Markdown QA runbooks.

---

## Files

- Create: `skills/codex-review/SKILL.md`
  - Versioned copy of the local Codex review skill usage contract.
- Create: `skills/codex-review/scripts/codex-review`
  - Versioned guarded helper script.
- Modify: `scripts/install-local`
  - Install both `manage-codex-workers` and `codex-review` skills.
  - Fail if either required skill source is incomplete.
  - Replace stale installed copies on every `--write`.
- Modify: `workerctl/commands.py`
  - Add `doctor-self` checks for the installed codex-review skill and helper script.
- Modify: `tests/test_workerctl.py`
  - Add install and doctor tests that prove both skills install, stale installed copies are replaced, and `--no-skill` skips all skill installs.
- Modify: `README.md`
  - Document that local install now installs both `manage-codex-workers` and `codex-review`.
- Modify: `docs/qa/codex-review-recursion-guard.md`
  - Make the QA smoke work from an installed helper path discovered through `$CODEX_HOME`, with the current absolute path as an operator example only if needed.
- Optional modify: `docs/superpowers/plans/2026-06-01-codex-review-recursion-guard.md`
  - Add a short follow-up note that PR #187's local helper is now planned to become versioned/installable here.

## Acceptance Criteria

- `scripts/install-local` default preview names both skill install targets.
- `scripts/install-local --write --codex-home "$tmp/codex-home"` installs:
  - `$tmp/codex-home/skills/manage-codex-workers/SKILL.md`
  - `$tmp/codex-home/skills/codex-review/SKILL.md`
  - `$tmp/codex-home/skills/codex-review/scripts/codex-review`
- The installed `codex-review` helper is executable and byte-for-byte matches `skills/codex-review/scripts/codex-review`.
- A stale pre-existing `$CODEX_HOME/skills/codex-review/scripts/codex-review` containing different content is replaced on install.
- `scripts/install-local --write --no-skill` installs the PATH line but creates no skill directories.
- `workerctl doctor-self --json` reports `codex_review_skill_installed` and `codex_review_helper_installed` checks.
- The versioned helper fails closed:
  - `CODEX_REVIEW_HELPER_LEVEL=1` exits `78` and emits `nested codex-review invocation blocked`.
  - `CODEX_REVIEW_HELPER_LEVEL=abc` exits `2`.
  - `CODEX_REVIEW_HELPER_LEVEL=0000` is top-level and reaches dry-run review selection.
  - `CODEX_REVIEW_HELPER_LEVEL=08 CODEX_REVIEW_ALLOW_NESTED=1` reaches dry-run review selection and exports a valid incremented level.
  - `CODEX_REVIEW_HELPER_LEVEL=9223372036854775808` exits `78` without Bash arithmetic overflow.
- The recursive fake Codex smoke proves an outer top-level helper can launch, its child helper is blocked with `nested-status:78`, and no new review-like processes remain.
- The QA doc commands do not rely on this developer's private home path; they can run against a temporary `$CODEX_HOME` install.
- Burden of proof: a deliberately injected stale installed helper is overwritten, and a deliberately injected stale review-like process is detected by cleanup proof.

---

### Task 1: Version the Codex Review Skill

**Files:**
- Create: `skills/codex-review/SKILL.md`
- Create: `skills/codex-review/scripts/codex-review`

- [ ] **Step 1: Create the skill directory**

Run:

```bash
mkdir -p skills/codex-review/scripts
```

Expected: command exits `0`.

- [ ] **Step 2: Add the versioned helper script**

Create `skills/codex-review/scripts/codex-review` with this exact content:

```bash
#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: codex-review [options]

Options:
  --mode auto|local|branch   Target selection. Default: auto.
  --base REF                 Base ref for branch review. Default: PR base or origin/main.
  --codex-bin PATH           Codex binary. Default: codex.
  --full-access              Run nested Codex review without sandbox/approval prompts.
  --output FILE              Also save output to file.
  --parallel-tests CMD       Run review and test command concurrently.
  --dry-run                  Print selected commands, do not run.
  -h, --help                 Show help.

Modes:
  local   codex review --uncommitted
  branch  codex review --base <base>
  auto    dirty tree -> local, else PR/current branch -> branch
EOF
}

mode=auto
base_ref=
codex_bin=${CODEX_BIN:-codex}
codex_args=()
output=${CODEX_REVIEW_OUTPUT:-}
parallel_tests=
dry_run=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --mode)
      mode=${2:-}
      shift 2
      ;;
    --base)
      base_ref=${2:-}
      shift 2
      ;;
    --codex-bin)
      codex_bin=${2:-}
      shift 2
      ;;
    --full-access)
      codex_args+=(--dangerously-bypass-approvals-and-sandbox)
      shift
      ;;
    --output)
      output=${2:-}
      shift 2
      ;;
    --parallel-tests)
      parallel_tests=${2:-}
      shift 2
      ;;
    --dry-run)
      dry_run=true
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      usage >&2
      exit 2
      ;;
  esac
done

case "$mode" in
  auto|local|branch) ;;
  *)
    echo "invalid --mode: $mode" >&2
    exit 2
    ;;
esac

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

git rev-parse --show-toplevel >/dev/null

current_branch=$(git branch --show-current 2>/dev/null || true)
dirty=false
if [[ -n "$(git status --porcelain)" ]]; then
  dirty=true
fi

pr_url=
if [[ -z "$base_ref" && "$mode" != local ]] && command -v gh >/dev/null 2>&1; then
  if pr_lines=$(gh pr view --json baseRefName,url --jq '[.baseRefName, .url] | @tsv' 2>/dev/null); then
    base_name=${pr_lines%%$'\t'*}
    pr_url=${pr_lines#*$'\t'}
    if [[ -n "$base_name" ]]; then
      base_ref="origin/$base_name"
    fi
  fi
fi

if [[ -z "$base_ref" ]]; then
  base_ref=origin/main
fi

review_kind=
if [[ "$mode" == local || ( "$mode" == auto && "$dirty" == true ) ]]; then
  review_kind=local
elif [[ "$mode" == branch || ( "$mode" == auto && -n "$current_branch" && "$current_branch" != "main" ) ]]; then
  review_kind=branch
else
  echo "no review target: clean main checkout and no forced mode" >&2
  exit 1
fi

if [[ "$review_kind" == local ]]; then
  review_cmd=("$codex_bin" ${codex_args[@]+"${codex_args[@]}"} review --uncommitted)
else
  review_cmd=("$codex_bin" ${codex_args[@]+"${codex_args[@]}"} review --base "$base_ref")
fi

printf 'codex-review target: %s\n' "$review_kind"
printf 'branch: %s\n' "${current_branch:-detached}"
if [[ -n "$pr_url" ]]; then
  printf 'pr: %s\n' "$pr_url"
fi
printf 'review:'
printf ' %q' "${review_cmd[@]}"
printf '\n'
if [[ -n "$parallel_tests" ]]; then
  printf 'tests: %s\n' "$parallel_tests"
fi
if [[ "$review_kind" == branch ]]; then
  printf 'fetch: git fetch origin --quiet\n'
fi
if [[ -n "$output" ]]; then
  printf 'output: %s\n' "$output"
fi

if [[ "$dry_run" == true ]]; then
  exit 0
fi

if [[ "$review_kind" == branch ]]; then
  git fetch origin --quiet || {
    echo "warning: git fetch origin failed; reviewing with existing refs" >&2
  }
fi

review_output=$output
review_output_is_temp=false
if [[ -z "$review_output" ]]; then
  review_output=$(mktemp)
  review_output_is_temp=true
fi

cleanup() {
  if [[ "${review_output_is_temp:-false}" == true && -n "${review_output:-}" ]]; then
    rm -f "$review_output"
  fi
}
trap cleanup EXIT

run_review() {
  mkdir -p "$(dirname "$review_output")"
  "${review_cmd[@]}" 2>&1 | tee "$review_output"
}

elapsed_since() {
  local started_at=$1
  local finished_at
  finished_at=$(date +%s)
  printf '%s\n' "$((finished_at - started_at))"
}

format_elapsed() {
  local seconds=$1
  if (( seconds < 60 )); then
    printf '%ss\n' "$seconds"
  else
    printf '%sm%ss\n' "$((seconds / 60))" "$((seconds % 60))"
  fi
}

review_output_empty() {
  [[ ! -s "$review_output" ]] || ! grep -q '[^[:space:]]' "$review_output"
}

review_output_has_findings() {
  grep -Eq '\[P[0-3]\]' "$review_output"
}

report_clean_review_or_fail() {
  local elapsed_text
  elapsed_text=$(format_elapsed "${review_elapsed_seconds:-0}")

  if review_output_has_findings; then
    printf 'codex-review complete after %s\n' "$elapsed_text"
    printf 'codex-review findings: accepted/actionable findings reported\n'
    return 1
  fi
  if review_output_empty; then
    printf 'codex-review complete after %s; no output\n' "$elapsed_text"
    return 1
  fi
  printf 'codex-review complete after %s\n' "$elapsed_text"
  printf 'codex-review clean: no accepted/actionable findings reported\n'
}

if [[ -z "$parallel_tests" ]]; then
  review_started_at=$(date +%s)
  set +e
  run_review
  review_status=$?
  review_elapsed_seconds=$(elapsed_since "$review_started_at")
  set -e
  if [[ "$review_status" == 0 ]]; then
    report_clean_review_or_fail
    exit $?
  fi
  exit "$review_status"
fi

review_status_file=$(mktemp)
review_elapsed_file=$(mktemp)
tests_status_file=$(mktemp)

(
  set +e
  review_started_at=$(date +%s)
  run_review
  status=$?
  elapsed=$(elapsed_since "$review_started_at")
  printf '%s\n' "$status" > "$review_status_file"
  printf '%s\n' "$elapsed" > "$review_elapsed_file"
) &
review_pid=$!

(
  set +e
  bash -lc "$parallel_tests"
  status=$?
  printf '%s\n' "$status" > "$tests_status_file"
) &
tests_pid=$!

wait "$review_pid" || true
wait "$tests_pid" || true

review_status=$(cat "$review_status_file")
review_elapsed_seconds=$(cat "$review_elapsed_file")
tests_status=$(cat "$tests_status_file")
rm -f "$review_status_file" "$review_elapsed_file" "$tests_status_file"

printf 'codex-review exit: %s\n' "$review_status"
printf 'tests exit: %s\n' "$tests_status"

if [[ "$review_status" != 0 || "$tests_status" != 0 ]]; then
  exit 1
fi

report_clean_review_or_fail
```

Expected: file exists.

- [ ] **Step 3: Make the helper executable and syntax-check it**

Run:

```bash
chmod +x skills/codex-review/scripts/codex-review
bash -n skills/codex-review/scripts/codex-review
```

Expected: both commands exit `0`.

- [ ] **Step 4: Add the versioned skill contract**

Create `skills/codex-review/SKILL.md` with this exact content:

````markdown
---
name: codex-review
description: "Codex code review closeout: local dirty changes, PR branch vs main, parallel tests."
---

# Codex Review

Run Codex's built-in code review as a closeout check. This is code review (`codex review`), not Guardian `auto_review` approval routing.

Use when:
- user asks for Codex review / autoreview / second-model review
- after non-trivial code edits, before final/commit/ship
- reviewing a local branch or PR branch after fixes

## Contract

- Treat review output as advisory. Never blindly apply it.
- Verify every finding by reading the real code path and adjacent files.
- Read dependency docs/source/types when the finding depends on external behavior.
- Reject unrealistic edge cases, speculative risks, broad rewrites, and fixes that over-complicate the codebase.
- Prefer small fixes at the right ownership boundary; no refactor unless it clearly improves the bug class.
- Keep going until Codex review returns no accepted/actionable findings.
- If a review-triggered fix changes code, rerun focused tests and rerun Codex review.
- Never switch or override the review model. If the review hits model capacity, retry the same command a few times with the same model. If it hits sandbox/permission limits, use the helper's `--full-access` option instead of changing models.
- Stop as soon as the review command/helper exits 0 with no accepted/actionable findings. Do not run an extra direct `codex review` just to get a nicer "clean" line, a second opinion, or clearer closeout wording.
- Treat the helper's successful exit plus absence of actionable findings as the clean review result, even if the underlying Codex CLI output is terse.
- If rejecting a finding as intentional/not worth fixing, add a brief inline code comment only when it explains a real invariant or ownership decision that future reviewers should know.
- Do not push just to review. Push only when the user requested push/ship/PR update.

## Pick Target

Dirty local work:

```bash
codex review --uncommitted
```

Use this only when the patch is actually unstaged/staged/untracked in the
current checkout. For committed, pushed, or PR work, review the branch against
its base instead; do not force `--mode local` / `--uncommitted` just because the
helper docs mention dirty work first. A clean `--uncommitted` review only proves
there is no local patch.

Branch/PR work:

```bash
git fetch origin
codex review --base origin/main
```

Do not pass an inline prompt with `--base`; current CLI rejects `--base` + `[PROMPT]` even though help text is ambiguous. If custom instructions are needed, run the plain base review first, then do a local/manual follow-up pass.

If an open PR exists, use its actual base:

```bash
base=$(gh pr view --json baseRefName --jq .baseRefName)
codex review --base "origin/$base"
```

Committed single change:

```bash
codex review --commit HEAD
```

## Parallel Closeout

Format first if formatting can change line locations. Then it is OK to run tests and review in parallel:

```bash
~/.codex/skills/codex-review/scripts/codex-review --parallel-tests "<focused test command>"
```

Tradeoff: tests may force code changes that stale the review. If tests or review lead to code edits, rerun the affected tests and rerun review until no accepted/actionable findings remain. Once that rerun exits cleanly, stop; do not spend another long review cycle on redundant confirmation.

## Context Efficiency

Codex review is usually noisy. Default to a subagent filter when subagents are available. Ask it to run the review and return only:
- actionable findings it accepts
- findings it rejects, with one-line reason
- exact files/tests to rerun

Run inline only for tiny changes or when subagents are unavailable.

## Helper

Bundled helper:

```bash
~/.codex/skills/codex-review/scripts/codex-review --help
```

The helper:
- chooses dirty `--uncommitted` first
- otherwise uses current PR base if `gh pr view` works
- otherwise uses `origin/main` for non-main branches
- should be left in `--mode auto` or forced to `--mode branch` for committed/PR work; do not force `--mode local` after committing
- writes only to stdout unless `--output` or `CODEX_REVIEW_OUTPUT` is set
- supports `--dry-run` and `--parallel-tests`
- supports `--full-access` for nested review runs that need localhost bind/listen tests
- prints `codex-review clean: no accepted/actionable findings reported` when the selected review command exits 0

Recursion guard:
- The helper exports `CODEX_REVIEW_HELPER_LEVEL=1` to the nested `codex review` process.
- If a review session tries to invoke the helper again, the helper exits `78` with `nested codex-review invocation blocked`.
- Use `CODEX_REVIEW_ALLOW_NESTED=1` only for intentional debugging dry runs; do not use it in normal closeout, GoalBuddy conveyor, or PR review flows.

## Final Report

Include:
- review command used
- tests/proof run
- findings accepted/rejected, briefly why
- the clean review result from the final helper/review run, or why a remaining finding was consciously rejected

Do not run another Codex review solely to improve the final report wording. If the final helper run exited 0 and produced no accepted/actionable findings, report that exact run as clean.
````

Expected: file exists.

- [ ] **Step 5: Verify the versioned files**

Run:

```bash
test -x skills/codex-review/scripts/codex-review
bash -n skills/codex-review/scripts/codex-review
rg -n "Recursion guard|CODEX_REVIEW_HELPER_LEVEL|CODEX_REVIEW_ALLOW_NESTED" skills/codex-review/SKILL.md
```

Expected: every command exits `0`.

- [ ] **Step 6: Commit Task 1**

Run:

```bash
git add skills/codex-review/SKILL.md skills/codex-review/scripts/codex-review
git commit -m "Version codex review skill helper"
```

Expected: commit succeeds.

---

### Task 2: Add Adversarial Helper Tests

**Files:**
- Modify: `tests/test_workerctl.py`
- Test: `skills/codex-review/scripts/codex-review`

- [ ] **Step 1: Add helper path constants near existing install constants**

Modify `tests/test_workerctl.py` near `INSTALL_LOCAL_PATH = ROOT / "scripts" / "install-local"`:

```python
INSTALL_LOCAL_PATH = ROOT / "scripts" / "install-local"
CODEX_REVIEW_HELPER_PATH = ROOT / "skills" / "codex-review" / "scripts" / "codex-review"
```

Expected: constant is defined once.

- [ ] **Step 2: Add direct guard behavior tests**

Add these methods to `class CliTests` near the existing install-local tests:

```python
    def run_codex_review_helper(self, *args, env=None):
        merged_env = os.environ.copy()
        if env:
            merged_env.update(env)
        return subprocess.run(
            [str(CODEX_REVIEW_HELPER_PATH), *args],
            cwd=ROOT,
            env=merged_env,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )

    def test_codex_review_helper_blocks_nested_invocation(self):
        proc = self.run_codex_review_helper(
            "--mode",
            "local",
            env={"CODEX_REVIEW_HELPER_LEVEL": "1"},
        )

        self.assertEqual(proc.returncode, 78)
        self.assertIn("nested codex-review invocation blocked", proc.stderr)

    def test_codex_review_helper_rejects_invalid_level(self):
        proc = self.run_codex_review_helper(
            "--mode",
            "local",
            env={"CODEX_REVIEW_HELPER_LEVEL": "abc"},
        )

        self.assertEqual(proc.returncode, 2)
        self.assertIn("invalid CODEX_REVIEW_HELPER_LEVEL=abc", proc.stderr)

    def test_codex_review_helper_treats_zero_padded_zero_as_top_level(self):
        proc = self.run_codex_review_helper(
            "--mode",
            "local",
            "--codex-bin",
            "/bin/echo",
            "--dry-run",
            env={"CODEX_REVIEW_HELPER_LEVEL": "0000"},
        )

        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("review: /bin/echo review --uncommitted", proc.stdout)

    def test_codex_review_helper_allows_debug_nested_dry_run_with_leading_zero(self):
        proc = self.run_codex_review_helper(
            "--mode",
            "local",
            "--codex-bin",
            "/bin/echo",
            "--dry-run",
            env={"CODEX_REVIEW_HELPER_LEVEL": "08", "CODEX_REVIEW_ALLOW_NESTED": "1"},
        )

        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("review: /bin/echo review --uncommitted", proc.stdout)

    def test_codex_review_helper_huge_nested_level_fails_closed_without_overflow(self):
        proc = self.run_codex_review_helper(
            "--mode",
            "local",
            env={"CODEX_REVIEW_HELPER_LEVEL": "9223372036854775808"},
        )

        self.assertEqual(proc.returncode, 78)
        self.assertIn("nested codex-review invocation blocked", proc.stderr)
        self.assertNotIn("value too great for base", proc.stderr)
```

Expected: methods are inside `CliTests`.

- [ ] **Step 3: Run the new direct tests and verify they pass**

Run:

```bash
python -m unittest \
  tests.test_workerctl.CliTests.test_codex_review_helper_blocks_nested_invocation \
  tests.test_workerctl.CliTests.test_codex_review_helper_rejects_invalid_level \
  tests.test_workerctl.CliTests.test_codex_review_helper_treats_zero_padded_zero_as_top_level \
  tests.test_workerctl.CliTests.test_codex_review_helper_allows_debug_nested_dry_run_with_leading_zero \
  tests.test_workerctl.CliTests.test_codex_review_helper_huge_nested_level_fails_closed_without_overflow
```

Expected: all five tests pass.

- [ ] **Step 4: Add recursive fake Codex behavior test**

Add this method to `class CliTests` after the direct helper tests:

```python
    def test_codex_review_helper_blocks_recursive_fake_codex_shape(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            fake_codex = Path(tmpdir) / "fake-codex-review-recursive"
            nested_stdout = Path(tmpdir) / "nested.stdout"
            nested_stderr = Path(tmpdir) / "nested.stderr"
            fake_codex.write_text(
                "#!/usr/bin/env bash\n"
                "set -euo pipefail\n"
                "set +e\n"
                f"{CODEX_REVIEW_HELPER_PATH} --mode local >{nested_stdout} 2>{nested_stderr}\n"
                "nested_status=$?\n"
                "set -e\n"
                "echo \"nested-status:$nested_status\"\n"
                f"cat {nested_stderr}\n"
                "exit 0\n"
            )
            fake_codex.chmod(0o755)
            proc = self.run_codex_review_helper(
                "--mode",
                "local",
                "--codex-bin",
                str(fake_codex),
                env={"CODEX_REVIEW_HELPER_LEVEL": "0"},
            )

        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("nested-status:78", proc.stdout)
        self.assertIn("nested codex-review invocation blocked", proc.stdout)
```

Expected: method is inside `CliTests`.

- [ ] **Step 5: Run the recursive fake Codex test**

Run:

```bash
python -m unittest tests.test_workerctl.CliTests.test_codex_review_helper_blocks_recursive_fake_codex_shape
```

Expected: test passes and proves the real recursive shape is blocked.

- [ ] **Step 6: Commit Task 2**

Run:

```bash
git add tests/test_workerctl.py
git commit -m "Test codex review helper recursion guard"
```

Expected: commit succeeds.

---

### Task 3: Install Both Skills Reproducibly

**Files:**
- Modify: `scripts/install-local`
- Modify: `tests/test_workerctl.py`

- [ ] **Step 1: Write failing install tests for both skills and stale replacement**

Modify `test_install_local_prints_path_line` and `test_install_local_write_is_idempotent`, then add a stale replacement test.

Use this exact replacement for `test_install_local_prints_path_line`:

```python
    def test_install_local_prints_path_line(self):
        proc = subprocess.run(
            [str(INSTALL_LOCAL_PATH)],
            cwd=ROOT,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )

        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn(str(ROOT / "bin"), proc.stdout)
        self.assertIn("manage-codex-workers", proc.stdout)
        self.assertIn("codex-review", proc.stdout)
        self.assertIn("workerctl dispatch --watch --dispatcher-id dispatch-local", proc.stdout)
        self.assertIn("workerctl qa-plan dispatch-completion", proc.stdout)
```

Use this exact replacement for the assertion block at the end of `test_install_local_write_is_idempotent`:

```python
            profile_text = profile.read_text()
            path_line = f'export PATH="{ROOT / "bin"}:$PATH"'
            self.assertEqual(profile_text.count(path_line), 1)

            codex_home = Path(env["CODEX_HOME"])
            manage_skill_path = codex_home / "skills" / "manage-codex-workers" / "SKILL.md"
            review_skill_path = codex_home / "skills" / "codex-review" / "SKILL.md"
            review_helper_path = codex_home / "skills" / "codex-review" / "scripts" / "codex-review"
            self.assertTrue(manage_skill_path.exists())
            self.assertTrue(review_skill_path.exists())
            self.assertTrue(review_helper_path.exists())
            self.assertTrue(os.access(review_helper_path, os.X_OK))
            self.assertEqual(
                review_helper_path.read_text(),
                CODEX_REVIEW_HELPER_PATH.read_text(),
            )
            self.assertIn("workerctl dispatch --watch --dispatcher-id dispatch-local", proc.stdout)
            self.assertIn("workerctl qa-plan dispatch-completion", proc.stdout)
```

Add this new test after `test_install_local_write_is_idempotent`:

```python
    def test_install_local_replaces_stale_codex_review_skill(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            profile = Path(tmpdir) / ".zshrc"
            codex_home = Path(tmpdir) / "codex-home"
            stale_helper = codex_home / "skills" / "codex-review" / "scripts" / "codex-review"
            stale_helper.parent.mkdir(parents=True)
            stale_helper.write_text("#!/usr/bin/env bash\necho stale-helper\n")
            stale_helper.chmod(0o755)
            env = os.environ.copy()
            env["WORKERCTL_INSTALL_PROFILE"] = str(profile)
            env["CODEX_HOME"] = str(codex_home)

            proc = subprocess.run(
                [str(INSTALL_LOCAL_PATH), "--write"],
                cwd=ROOT,
                env=env,
                text=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                check=False,
            )

            self.assertEqual(proc.returncode, 0, proc.stderr)
            self.assertNotIn("stale-helper", stale_helper.read_text())
            self.assertEqual(stale_helper.read_text(), CODEX_REVIEW_HELPER_PATH.read_text())
```

Add this `--no-skill` test after the stale replacement test:

```python
    def test_install_local_no_skill_skips_all_skill_installs(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            profile = Path(tmpdir) / ".zshrc"
            codex_home = Path(tmpdir) / "codex-home"
            env = os.environ.copy()
            env["WORKERCTL_INSTALL_PROFILE"] = str(profile)
            env["CODEX_HOME"] = str(codex_home)

            proc = subprocess.run(
                [str(INSTALL_LOCAL_PATH), "--write", "--no-skill"],
                cwd=ROOT,
                env=env,
                text=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                check=False,
            )

            self.assertEqual(proc.returncode, 0, proc.stderr)
            self.assertFalse((codex_home / "skills" / "manage-codex-workers").exists())
            self.assertFalse((codex_home / "skills" / "codex-review").exists())
```

Expected: tests are added but fail before installer changes.

- [ ] **Step 2: Run the new install tests and verify failure**

Run:

```bash
python -m unittest \
  tests.test_workerctl.CliTests.test_install_local_prints_path_line \
  tests.test_workerctl.CliTests.test_install_local_write_is_idempotent \
  tests.test_workerctl.CliTests.test_install_local_replaces_stale_codex_review_skill \
  tests.test_workerctl.CliTests.test_install_local_no_skill_skips_all_skill_installs
```

Expected before implementation: at least one assertion fails because `codex-review` is not installed.

- [ ] **Step 3: Refactor install-local skill sources into an array**

Modify the top of `scripts/install-local`:

```bash
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN_DIR="$ROOT/bin"
SKILL_NAMES=(manage-codex-workers codex-review)
PROFILE="${WORKERCTL_INSTALL_PROFILE:-$HOME/.zshrc}"
CODEX_HOME_DIR="${CODEX_HOME:-$HOME/.codex}"
PATH_LINE="export PATH=\"$BIN_DIR:\$PATH\""
INSTALL_SKILL=true
```

Expected: `SKILL_SRC` is removed.

- [ ] **Step 4: Update the install-local usage text**

Replace the usage description line with:

```bash
Print or install the local workerctl PATH setup and Codex skills.
```

Replace the `--no-skill` option help with:

```bash
  --no-skill        Skip installing Codex skills.
```

Expected: preview text no longer implies only one skill.

- [ ] **Step 5: Validate all skill sources before preview/write**

Replace the single `SKILL_SRC` validation block with:

```bash
if [[ "$INSTALL_SKILL" == true ]]; then
  for skill_name in "${SKILL_NAMES[@]}"; do
    skill_src="$ROOT/skills/$skill_name"
    if [[ ! -f "$skill_src/SKILL.md" ]]; then
      echo "install-local: expected skill not found: $skill_src/SKILL.md" >&2
      exit 1
    fi
    if [[ "$skill_name" == "codex-review" && ! -x "$skill_src/scripts/codex-review" ]]; then
      echo "install-local: expected executable helper not found: $skill_src/scripts/codex-review" >&2
      exit 1
    fi
  done
fi
```

Expected: installer fails closed if the versioned helper is missing or not executable.

- [ ] **Step 6: Print both skill install targets in preview mode**

Replace the preview skill target block with:

```bash
  if [[ "$INSTALL_SKILL" == true ]]; then
    echo "Skill install targets:"
    for skill_name in "${SKILL_NAMES[@]}"; do
      echo "  $CODEX_HOME_DIR/skills/$skill_name"
    done
    echo
  fi
```

Expected: preview lists `manage-codex-workers` and `codex-review`.

- [ ] **Step 7: Install all skill directories on write**

Replace the single skill copy block with:

```bash
if [[ "$INSTALL_SKILL" == true ]]; then
  for skill_name in "${SKILL_NAMES[@]}"; do
    skill_src="$ROOT/skills/$skill_name"
    skill_dest="$CODEX_HOME_DIR/skills/$skill_name"
    mkdir -p "$(dirname "$skill_dest")"
    rm -rf "$skill_dest"
    cp -R "$skill_src" "$skill_dest"
    if [[ "$skill_name" == "codex-review" ]]; then
      chmod +x "$skill_dest/scripts/codex-review"
    fi
    echo "installed $skill_name skill in $skill_dest"
  done
fi
```

Expected: installer replaces stale copies.

- [ ] **Step 8: Update final install guidance**

Replace:

```bash
if [[ "$INSTALL_SKILL" == true ]]; then
  echo "Plain Codex sessions can use the installed manage-codex-workers skill after starting a new session."
fi
```

with:

```bash
if [[ "$INSTALL_SKILL" == true ]]; then
  echo "Plain Codex sessions can use the installed manage-codex-workers and codex-review skills after starting a new session."
fi
```

Expected: output names both installed skills.

- [ ] **Step 9: Run install tests and verify pass**

Run:

```bash
python -m unittest \
  tests.test_workerctl.CliTests.test_install_local_prints_path_line \
  tests.test_workerctl.CliTests.test_install_local_write_is_idempotent \
  tests.test_workerctl.CliTests.test_install_local_replaces_stale_codex_review_skill \
  tests.test_workerctl.CliTests.test_install_local_no_skill_skips_all_skill_installs
```

Expected: all four tests pass.

- [ ] **Step 10: Commit Task 3**

Run:

```bash
git add scripts/install-local tests/test_workerctl.py
git commit -m "Install codex review skill locally"
```

Expected: commit succeeds.

---

### Task 4: Surface Installed Helper Health in Doctor

**Files:**
- Modify: `workerctl/commands.py`
- Modify: `tests/test_workerctl.py`

- [ ] **Step 1: Add failing doctor test for codex-review checks**

Add this test near the existing install tests:

```python
    def test_doctor_self_reports_codex_review_skill_checks(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            codex_home = Path(tmpdir) / "codex-home"
            review_skill = codex_home / "skills" / "codex-review"
            review_helper = review_skill / "scripts" / "codex-review"
            review_helper.parent.mkdir(parents=True)
            (review_skill / "SKILL.md").write_text("review skill")
            review_helper.write_text("#!/usr/bin/env bash\nexit 0\n")
            review_helper.chmod(0o755)
            env = os.environ.copy()
            env["CODEX_HOME"] = str(codex_home)

            proc = subprocess.run(
                [sys.executable, str(WORKERCTL_PATH), "doctor-self", "--json"],
                cwd=ROOT,
                env=env,
                text=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                check=False,
            )

        self.assertIn("codex_review_skill_installed", proc.stdout)
        self.assertIn("codex_review_helper_installed", proc.stdout)
```

Expected before implementation: test fails because those check names are absent.

- [ ] **Step 2: Run the failing doctor test**

Run:

```bash
python -m unittest tests.test_workerctl.CliTests.test_doctor_self_reports_codex_review_skill_checks
```

Expected before implementation: failure mentions missing `codex_review_skill_installed` or `codex_review_helper_installed`.

- [ ] **Step 3: Add doctor-self codex-review paths**

Modify `command_doctor_self` in `workerctl/commands.py` after `skill_path = ...`:

```python
    codex_review_skill_path = _codex_home() / "skills" / "codex-review" / "SKILL.md"
    codex_review_helper_path = _codex_home() / "skills" / "codex-review" / "scripts" / "codex-review"
```

Expected: local variables are defined before `checks`.

- [ ] **Step 4: Add doctor-self checks**

Modify the `checks = [` list in `command_doctor_self` by adding these entries after `manage_skill_installed`:

```python
        {"name": "codex_review_skill_installed", "ok": codex_review_skill_path.exists(), "path": str(codex_review_skill_path)},
        {
            "name": "codex_review_helper_installed",
            "ok": codex_review_helper_path.exists() and os.access(codex_review_helper_path, os.X_OK),
            "path": str(codex_review_helper_path),
        },
```

Expected: doctor JSON includes both checks.

- [ ] **Step 5: Add the helper path to the doctor-self result**

Modify the result payload near `"skill_path": str(skill_path),`:

```python
        "skill_path": str(skill_path),
        "codex_review_skill_path": str(codex_review_skill_path),
        "codex_review_helper_path": str(codex_review_helper_path),
```

Expected: result payload reports exact paths.

- [ ] **Step 6: Run the doctor test**

Run:

```bash
python -m unittest tests.test_workerctl.CliTests.test_doctor_self_reports_codex_review_skill_checks
```

Expected: test passes.

- [ ] **Step 7: Commit Task 4**

Run:

```bash
git add workerctl/commands.py tests/test_workerctl.py
git commit -m "Report codex review helper install health"
```

Expected: commit succeeds.

---

### Task 5: Update Operator Docs and QA Smoke

**Files:**
- Modify: `README.md`
- Modify: `docs/qa/codex-review-recursion-guard.md`

- [ ] **Step 1: Update README install paragraph**

Replace this paragraph in `README.md`:

```markdown
`scripts/install-local --write` updates future shells and installs the
`manage-codex-workers` skill into `$CODEX_HOME/skills` or `~/.codex/skills`.
The `export` line makes `workerctl` available in the current shell.
```

with:

```markdown
`scripts/install-local --write` updates future shells and installs the
`manage-codex-workers` and `codex-review` skills into `$CODEX_HOME/skills` or
`~/.codex/skills`. The `codex-review` install includes the guarded review helper
used by the QA and PR closeout flows. The `export` line makes `workerctl`
available in the current shell.
```

Expected: README names both installed skills.

- [ ] **Step 2: Rewrite the QA smoke to install into a temporary Codex home**

Replace the opening paragraph and add setup commands in `docs/qa/codex-review-recursion-guard.md` so the first two sections are:

````markdown
# Codex Review Recursion Guard

Use this smoke after changing the versioned `codex-review` helper. It proves a
fresh local install blocks recursive review helper launches and does not leave
duplicate review processes running.

## Temporary Install

```bash
QA_CODEX_HOME=$(mktemp -d)
WORKERCTL_INSTALL_PROFILE="$QA_CODEX_HOME/.zshrc" \
  CODEX_HOME="$QA_CODEX_HOME" \
  scripts/install-local --write
REVIEW_HELPER="$QA_CODEX_HOME/skills/codex-review/scripts/codex-review"
test -x "$REVIEW_HELPER"
cmp -s skills/codex-review/scripts/codex-review "$REVIEW_HELPER"
```

## Baseline
````

Expected: QA doc no longer starts by assuming `/Users/neonwatty/.codex/...`.

- [ ] **Step 3: Replace hard-coded helper paths in the QA smoke**

In `docs/qa/codex-review-recursion-guard.md`, replace every command occurrence of:

```bash
/Users/neonwatty/.codex/skills/codex-review/scripts/codex-review
```

with:

```bash
"$REVIEW_HELPER"
```

Expected: direct nested block, fake recursive child, and outer helper call all use `$REVIEW_HELPER`.

- [ ] **Step 4: Add stale install disproof to the QA smoke**

Add this section before `## Baseline`:

````markdown
## Stale Install Disproof

```bash
printf '#!/usr/bin/env bash\necho stale-helper\n' >"$REVIEW_HELPER"
chmod +x "$REVIEW_HELPER"
WORKERCTL_INSTALL_PROFILE="$QA_CODEX_HOME/.zshrc" \
  CODEX_HOME="$QA_CODEX_HOME" \
  scripts/install-local --write
! rg "stale-helper" "$REVIEW_HELPER"
cmp -s skills/codex-review/scripts/codex-review "$REVIEW_HELPER"
```
````

Expected: QA proves install replaces stale helper content.

- [ ] **Step 5: Add process-leak disproof to the QA smoke**

Add this section after the normal `Cleanup Proof` section:

````markdown
## Cleanup Disproof

```bash
current_pid=$$
ps -eo pid=,args= | awk -v self="$current_pid" '
  $1 != self && $0 ~ /[c]odex.*review|[c]odex-review/ { print $1 }
' | sort -u >/tmp/codex-review-before.pids
(exec -a codex-review-stale sleep 20) &
stale_pid=$!
sleep 0.2
current_pid=$$
ps -eo pid=,args= | awk -v self="$current_pid" '
  $1 != self && $0 ~ /[c]odex.*review|[c]odex-review/ { print $1 }
' | sort -u >/tmp/codex-review-after.pids
comm -13 /tmp/codex-review-before.pids /tmp/codex-review-after.pids \
  >/tmp/codex-review-new.pids
rg "$stale_pid" /tmp/codex-review-new.pids
kill "$stale_pid" 2>/dev/null || true
```
````

Expected: QA proves the cleanup detector catches an injected review-like process.

- [ ] **Step 6: Run docs text checks**

Run:

```bash
rg -n "codex-review|Temporary Install|Stale Install Disproof|Cleanup Disproof|REVIEW_HELPER" README.md docs/qa/codex-review-recursion-guard.md
git diff --check
```

Expected: command exits `0`.

- [ ] **Step 7: Commit Task 5**

Run:

```bash
git add README.md docs/qa/codex-review-recursion-guard.md
git commit -m "Document installed codex review helper"
```

Expected: commit succeeds.

---

### Task 6: End-to-End Verification and Review

**Files:**
- All files modified by Tasks 1-5.

- [ ] **Step 1: Run focused unit tests**

Run:

```bash
python -m unittest \
  tests.test_workerctl.CliTests.test_codex_review_helper_blocks_nested_invocation \
  tests.test_workerctl.CliTests.test_codex_review_helper_rejects_invalid_level \
  tests.test_workerctl.CliTests.test_codex_review_helper_treats_zero_padded_zero_as_top_level \
  tests.test_workerctl.CliTests.test_codex_review_helper_allows_debug_nested_dry_run_with_leading_zero \
  tests.test_workerctl.CliTests.test_codex_review_helper_huge_nested_level_fails_closed_without_overflow \
  tests.test_workerctl.CliTests.test_codex_review_helper_blocks_recursive_fake_codex_shape \
  tests.test_workerctl.CliTests.test_install_local_prints_path_line \
  tests.test_workerctl.CliTests.test_install_local_write_is_idempotent \
  tests.test_workerctl.CliTests.test_install_local_replaces_stale_codex_review_skill \
  tests.test_workerctl.CliTests.test_install_local_no_skill_skips_all_skill_installs \
  tests.test_workerctl.CliTests.test_doctor_self_reports_codex_review_skill_checks
```

Expected: all listed tests pass.

- [ ] **Step 2: Run the QA smoke exactly from the doc**

Run the command blocks from `docs/qa/codex-review-recursion-guard.md` in order.

Expected:
- Temporary install creates an executable `$REVIEW_HELPER`.
- Stale install disproof overwrites `stale-helper`.
- Direct nested block exits `78`.
- Recursive shape smoke records `nested-status:78`.
- Cleanup proof finds no leaked new review-like processes.
- Cleanup disproof detects the injected `codex-review-stale` PID.

- [ ] **Step 3: Run broader checks**

Run:

```bash
bash -n scripts/install-local skills/codex-review/scripts/codex-review
python -m unittest tests.test_workerctl.CliTests
git diff --check
```

Expected: all commands exit `0`.

- [ ] **Step 4: Run codex-review toolkit**

Run:

```bash
skills/codex-review/scripts/codex-review --full-access --parallel-tests "bash -n scripts/install-local skills/codex-review/scripts/codex-review && python -m unittest tests.test_workerctl.CliTests && git diff --check"
```

Expected: review exits `0`, tests exit `0`, and output includes `codex-review clean: no accepted/actionable findings reported`.

- [ ] **Step 5: Commit any review-triggered fixes**

If Task 6 Step 4 reports accepted/actionable findings, fix only findings verified in code, rerun the focused failing test, rerun Step 4, then commit the reviewed files from this plan:

```bash
git add \
  skills/codex-review/SKILL.md \
  skills/codex-review/scripts/codex-review \
  scripts/install-local \
  workerctl/commands.py \
  tests/test_workerctl.py \
  README.md \
  docs/qa/codex-review-recursion-guard.md
git commit -m "Address codex review helper review findings"
```

Expected: no commit is made if there are no accepted/actionable findings.

---

### Task 7: PR, CI, Merge, and Post-Merge Proof

**Files:**
- Branch containing all commits from Tasks 1-6.

- [ ] **Step 1: Push the branch**

Run:

```bash
git push -u origin codex/versioned-codex-review-helper
```

Expected: branch pushes successfully.

- [ ] **Step 2: Create the PR**

Run:

```bash
gh pr create \
  --title "Version and install codex review helper" \
  --body "Adds a versioned codex-review skill/helper, installs it via scripts/install-local, surfaces install health in doctor-self, and updates the recursion-guard QA smoke to prove fresh installs, stale replacement, recursive blocking, and cleanup disproof." \
  --base main \
  --head codex/versioned-codex-review-helper
```

Expected: PR URL is printed.

- [ ] **Step 3: Monitor CI**

Run:

```bash
gh pr checks --watch
```

Expected: every required check passes. If a check fails, inspect logs, fix the failure, push, and rerun this step.

- [ ] **Step 4: Merge when green**

Run:

```bash
gh pr merge --squash --delete-branch
```

Expected: PR merges and local checkout updates or can be fast-forwarded to `origin/main`.

- [ ] **Step 5: Run post-merge install proof from main**

Run:

```bash
git checkout main
git pull --ff-only
QA_CODEX_HOME=$(mktemp -d)
WORKERCTL_INSTALL_PROFILE="$QA_CODEX_HOME/.zshrc" \
  CODEX_HOME="$QA_CODEX_HOME" \
  scripts/install-local --write
test -x "$QA_CODEX_HOME/skills/codex-review/scripts/codex-review"
cmp -s skills/codex-review/scripts/codex-review "$QA_CODEX_HOME/skills/codex-review/scripts/codex-review"
CODEX_REVIEW_HELPER_LEVEL=1 \
  "$QA_CODEX_HOME/skills/codex-review/scripts/codex-review" --mode local \
  >/tmp/post-merge-codex-review-nested.stdout \
  2>/tmp/post-merge-codex-review-nested.stderr; test "$?" -eq 78
rg "nested codex-review invocation blocked" /tmp/post-merge-codex-review-nested.stderr
```

Expected: install proof and nested block proof pass on `main`.

---

## Self-Review

- Spec coverage: The plan makes the helper versioned, installable, surfaced in doctor output, documented, QA-smoked, reviewed, CI-gated, and post-merge-proven.
- Adversarial proof coverage: Tests and QA attempt stale installed helper survival, missing helper executability, nested recursion, invalid guard values, leading-zero values, huge numeric overflow, inherited guard use in fake recursive shape, and stale process detection.
- Placeholder scan: No unfinished marker, "similar to", or unspecified future test command is used.
- Type/name consistency: Paths and check names are consistent: `skills/codex-review`, `codex_review_skill_installed`, `codex_review_helper_installed`, `CODEX_REVIEW_HELPER_LEVEL`, and `CODEX_REVIEW_ALLOW_NESTED`.
