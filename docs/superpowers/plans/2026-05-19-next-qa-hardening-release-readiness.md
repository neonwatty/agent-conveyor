# Next QA Hardening And Release Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move `codex-terminal-manager` from “ready for focused manual QA” to “manual QA complete, live smoke repeatable, warning-clean enough for CI gates, and ready for a release/readiness decision.”

**Architecture:** Treat the current `qa-live-smoke-readiness` branch as the baseline. First land or preserve that branch, then build confidence through repeated live runs, a documented manual QA pass, and a deterministic warning-clean test gate. Keep live QA evidence in `docs/live-qa-artifacts/`, operator decisions in `docs/live-qa-log.md`, and automation in small scripts/workflows that fit the repo’s current stdlib/no-packaging style.

**Tech Stack:** Bash, Python stdlib `unittest`, SQLite, tmux, Codex CLI, GitHub Actions, GitHub CLI.

---

## Current Starting Point

- Branch: `qa-live-smoke-readiness`.
- Latest local commits:
  - `7ef0ae7 docs: record qa readiness decision`
  - `e187061 ci: add manual live smoke workflow`
  - `1f6e30d docs: document qa gates`
  - `7496f6c docs: record current cli live smoke`
  - `122bea3 fix: refresh live smoke for current cli`
  - `50603cd test: guard live smoke command surface`
- Current decision in `docs/live-qa-log.md`: ready for focused manual QA, not yet ready to reduce manual QA dependence.
- Known remaining risks:
  - Live smoke has passed once, not repeatedly.
  - Manual checklist exists but has not been run end-to-end as a named pass.
  - Unit tests pass but emit non-fatal `ResourceWarning: unclosed database` warnings under Python 3.14.
  - Manual GitHub Actions live smoke skips when `codex` is unavailable on the runner, so local smoke remains authoritative.

## File Structure

- Modify: `scripts/live-smoke`
  - Keep as the single-run live lifecycle gate.
  - Add small quality improvements only when they reduce repeated-run ambiguity.
- Create: `scripts/live-smoke-repeat`
  - Runs `scripts/live-smoke` multiple times, records each run’s stdout/stderr/exit, validates cleanup after each run, and writes a summary JSON.
- Modify: `tests/test_workerctl.py`
  - Add Bash syntax coverage for `scripts/live-smoke-repeat`.
  - Add command-surface guard coverage if the repeat script shells out to `workerctl` directly.
  - Add warning-clean regression tests after ResourceWarning sources are fixed.
- Modify: `.github/workflows/test.yml`
  - Add a ResourceWarning gate only after the suite is warning-clean.
- Modify: `README.md`
  - Document the repeat smoke and release/readiness gates.
- Modify: `docs/manual-qa-checklist.md`
  - Convert from a generic checklist into a pass template with fields for task/worker/manager/artifact paths.
- Modify: `docs/live-qa-log.md`
  - Record repeated smoke results, manual QA pass, warning-clean decision, and final release-readiness decision.
- Create: `docs/live-qa-artifacts/YYYY-MM-DD-live-smoke-repeat-*/`
  - Stores repeated smoke run logs and summary.
- Create: `docs/live-qa-artifacts/YYYY-MM-DD-manual-qa-pass-*/`
  - Stores manual QA pass command outputs and exported task evidence.

---

### Task 1: Land Or Preserve The QA-Readiness Branch

**Files:**
- Read: `git status`
- Read: `.github/workflows/test.yml`
- Read: `.github/workflows/live-smoke.yml`
- Optional GitHub PR creation with `gh`

- [ ] **Step 1: Confirm branch is clean**

Run:

```bash
git status --short
git branch --show-current
git log --oneline main..HEAD
```

Expected:

- `git status --short` is empty.
- Current branch is `qa-live-smoke-readiness`.
- Six QA-readiness commits appear ahead of `main`.

- [ ] **Step 2: Run deterministic verification**

Run:

```bash
python3 -m unittest discover -s tests -v
python3 -m py_compile scripts/workerctl workerctl/*.py
bash -n scripts/live-smoke
```

Expected:

- 347 tests pass.
- Compile check passes.
- `bash -n` is silent.

- [ ] **Step 3: Push branch and open PR**

Run:

```bash
git push -u origin qa-live-smoke-readiness
gh pr create \
  --title "Refresh live smoke and record QA readiness" \
  --body-file - <<'EOF'
## Summary
- refresh `scripts/live-smoke` to use the current workerctl CLI
- add a regression test that catches stale live-smoke subcommands
- run and record a current CLI live smoke pass
- document deterministic/live QA gates and manual QA checklist
- add a manual GitHub Actions live-smoke workflow
- record the current QA readiness decision

## Verification
- `python3 -m unittest discover -s tests -v`
- `python3 -m py_compile scripts/workerctl workerctl/*.py`
- `bash -n scripts/live-smoke`
- `scripts/live-smoke`
- `scripts/workerctl sessions --state active`
- `scripts/workerctl reconcile --stale-cycles-seconds 1`

## Readiness
Ready for focused manual QA. Not yet ready to reduce manual QA dependence until live smoke is stable across repeated runs.
EOF
```

Expected:

- Branch pushes successfully.
- PR opens against `main`.

- [ ] **Step 4: If PR creation is not desired, record local handoff**

If this work should stay local, append this to `docs/live-qa-log.md` instead:

```markdown
## 2026-05-19: QA Readiness Branch Handoff

Branch:

- `qa-live-smoke-readiness`

Decision:

- Keep branch local for continued QA hardening before opening a PR.

Verification:

- `python3 -m unittest discover -s tests -v`
- `python3 -m py_compile scripts/workerctl workerctl/*.py`
- `bash -n scripts/live-smoke`

Next:

- Run repeat live smoke and focused manual QA before merging.
```

Then commit:

```bash
git add docs/live-qa-log.md
git commit -m "docs: record qa readiness branch handoff"
```

---

### Task 2: Add Repeat Live-Smoke Runner

**Files:**
- Create: `scripts/live-smoke-repeat`
- Modify: `tests/test_workerctl.py`

- [ ] **Step 1: Add failing Bash syntax test**

In `tests/test_workerctl.py`, add this method to `CliTests` near `test_live_smoke_script_has_valid_bash_syntax`:

```python
    def test_live_smoke_repeat_script_has_valid_bash_syntax(self):
        proc = subprocess.run(
            ["bash", "-n", str(ROOT / "scripts" / "live-smoke-repeat")],
            cwd=ROOT,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )

        self.assertEqual(proc.returncode, 0, proc.stderr)
```

- [ ] **Step 2: Run test and verify it fails**

Run:

```bash
python3 -m unittest tests.test_workerctl.CliTests.test_live_smoke_repeat_script_has_valid_bash_syntax -v
```

Expected:

- Fails because `scripts/live-smoke-repeat` does not exist yet.

- [ ] **Step 3: Create `scripts/live-smoke-repeat`**

Create `scripts/live-smoke-repeat` with executable mode:

```bash
#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKERCTL="${ROOT}/scripts/workerctl"
COUNT="${1:-3}"
RUN_ID="repeat-$(date +%Y%m%d%H%M%S)"
ARTIFACT_ROOT="${ROOT}/docs/live-qa-artifacts/$(date +%Y-%m-%d)-live-smoke-repeat-${RUN_ID}"
SUMMARY="${ARTIFACT_ROOT}/summary.jsonl"

if ! [[ "${COUNT}" =~ ^[0-9]+$ ]] || [ "${COUNT}" -lt 1 ]; then
  echo "usage: scripts/live-smoke-repeat [positive-count]" >&2
  exit 2
fi

mkdir -p "${ARTIFACT_ROOT}"
cd "${ROOT}"

echo "repeat artifact root: ${ARTIFACT_ROOT}"
echo "repeat count: ${COUNT}"

for index in $(seq 1 "${COUNT}"); do
  run_dir="${ARTIFACT_ROOT}/run-${index}"
  mkdir -p "${run_dir}"
  echo "live smoke repeat run ${index}/${COUNT}"

  set +e
  scripts/live-smoke > "${run_dir}/live-smoke.stdout" 2> "${run_dir}/live-smoke.stderr"
  status="$?"
  set -e
  printf '%s\n' "${status}" > "${run_dir}/live-smoke.exit"

  "${WORKERCTL}" sessions --state active > "${run_dir}/sessions-active.stdout" 2> "${run_dir}/sessions-active.stderr"
  "${WORKERCTL}" reconcile --stale-cycles-seconds 1 > "${run_dir}/reconcile.stdout" 2> "${run_dir}/reconcile.stderr"

  python3 - "${index}" "${status}" "${run_dir}/live-smoke.stdout" "${run_dir}/reconcile.stdout" >> "${SUMMARY}" <<'PY'
import json
import sys

index = int(sys.argv[1])
status = int(sys.argv[2])
stdout_path = sys.argv[3]
reconcile_path = sys.argv[4]
stdout = open(stdout_path).read()
artifact_line = next((line for line in stdout.splitlines() if line.startswith("artifact root: ")), "")
artifact_root = artifact_line.removeprefix("artifact root: ") if artifact_line else None
reconcile = json.load(open(reconcile_path))
record = {
    "run": index,
    "status": status,
    "artifact_root": artifact_root,
    "reconcile_clean": not (
        reconcile.get("dangling_bindings")
        or reconcile.get("dead_pid_sessions")
        or reconcile.get("stuck_tasks")
    ),
}
print(json.dumps(record, sort_keys=True))
PY

  if [ "${status}" -ne 0 ]; then
    echo "live smoke repeat failed on run ${index}; see ${run_dir}" >&2
    exit "${status}"
  fi

  python3 - "${run_dir}/reconcile.stdout" <<'PY'
import json
import sys

data = json.load(open(sys.argv[1]))
for key in ("dangling_bindings", "dead_pid_sessions", "stuck_tasks"):
    if data.get(key):
        raise SystemExit(f"reconcile reported {key}: {data[key]}")
PY
done

echo "live smoke repeat passed"
```

Then run:

```bash
chmod +x scripts/live-smoke-repeat
```

- [ ] **Step 4: Run focused test**

Run:

```bash
python3 -m unittest tests.test_workerctl.CliTests.test_live_smoke_repeat_script_has_valid_bash_syntax -v
```

Expected:

- Test passes.

- [ ] **Step 5: Run shell syntax directly**

Run:

```bash
bash -n scripts/live-smoke-repeat
```

Expected:

- No output.

- [ ] **Step 6: Commit**

```bash
git add scripts/live-smoke-repeat tests/test_workerctl.py
git commit -m "test: add repeat live smoke runner"
```

---

### Task 3: Prove Live-Smoke Repeatability

**Files:**
- Create: `docs/live-qa-artifacts/YYYY-MM-DD-live-smoke-repeat-*/`
- Modify: `docs/live-qa-log.md`

- [ ] **Step 1: Run repeat smoke**

Run:

```bash
scripts/live-smoke-repeat 3
```

Expected:

- Final stdout includes `live smoke repeat passed`.
- Three child runs are recorded.
- Each run has `live-smoke.exit` equal to `0`.
- Each run has clean `reconcile.stdout`.

- [ ] **Step 2: Inspect summary**

Run:

```bash
ARTIFACT_ROOT="$(ls -td docs/live-qa-artifacts/*live-smoke-repeat* | head -1)"
cat "$ARTIFACT_ROOT/summary.jsonl"
find "$ARTIFACT_ROOT" -maxdepth 2 -type f | sort
```

Expected:

- `summary.jsonl` has three JSON lines.
- Every line has `"status": 0` and `"reconcile_clean": true`.

- [ ] **Step 3: Record log entry**

Append to `docs/live-qa-log.md`:

```markdown
## 2026-05-19: Repeat Live Smoke

Scenario:

- Script: `scripts/live-smoke-repeat 3`
- Evidence bundle: `docs/live-qa-artifacts/<repeat-artifact-dir>/`

Validated:

- Three consecutive `scripts/live-smoke` runs passed.
- Each run wrote an artifact root.
- Each post-run `sessions --state active` check completed.
- Each post-run `reconcile --stale-cycles-seconds 1` reported clean state.

Decision:

- Live smoke is repeatable enough to proceed to focused manual QA.
```

- [ ] **Step 4: Commit**

```bash
git add docs/live-qa-log.md docs/live-qa-artifacts/
git commit -m "docs: record repeat live smoke"
```

---

### Task 4: Run Focused Manual QA Pass

**Files:**
- Modify: `docs/manual-qa-checklist.md`
- Modify: `docs/live-qa-log.md`
- Create: `docs/live-qa-artifacts/YYYY-MM-DD-manual-qa-pass-*/`

- [ ] **Step 1: Convert checklist into a run template**

Modify `docs/manual-qa-checklist.md` so the top of the file includes:

```markdown
# Manual QA Checklist

Run this after unit tests and `scripts/live-smoke-repeat 3` pass.

## Run Metadata

- Date:
- Operator:
- Task:
- Worker:
- Manager:
- Evidence bundle:
- Result: pending

## Checklist
```

Keep the existing checklist items below `## Checklist`.

- [ ] **Step 2: Create manual QA artifact directory**

Run:

```bash
QA_ID="manual-qa-$(date +%Y%m%d%H%M%S)"
QA_ROOT="docs/live-qa-artifacts/$(date +%Y-%m-%d)-manual-qa-pass-${QA_ID}"
mkdir -p "$QA_ROOT"
printf '%s\n' "$QA_ROOT"
```

Expected:

- Prints a new artifact directory path.

- [ ] **Step 3: Run preflight commands and capture outputs**

Run:

```bash
scripts/workerctl doctor > "$QA_ROOT/01-doctor.stdout" 2> "$QA_ROOT/01-doctor.stderr"
scripts/workerctl db-doctor > "$QA_ROOT/02-db-doctor.stdout" 2> "$QA_ROOT/02-db-doctor.stderr"
scripts/workerctl sessions --state active > "$QA_ROOT/03-sessions-before.stdout" 2> "$QA_ROOT/03-sessions-before.stderr"
scripts/workerctl reconcile --stale-cycles-seconds 1 > "$QA_ROOT/04-reconcile-before.stdout" 2> "$QA_ROOT/04-reconcile-before.stderr"
```

Expected:

- Doctor and db-doctor report ok.
- Sessions before manual QA are either empty or only unrelated known sessions.
- Reconcile before manual QA is clean.

- [ ] **Step 4: Run disposable manual QA pair**

Run:

```bash
QA_TASK="manual-qa-task-$(date +%Y%m%d%H%M%S)"
QA_WORKER="manual-qa-worker-${QA_TASK}"
QA_MANAGER="manual-qa-manager-${QA_TASK}"
printf '%s\n' "$QA_TASK" > "$QA_ROOT/task.txt"
printf '%s\n' "$QA_WORKER" > "$QA_ROOT/worker.txt"
printf '%s\n' "$QA_MANAGER" > "$QA_ROOT/manager.txt"

scripts/workerctl pair \
  --task "$QA_TASK" \
  --worker-name "$QA_WORKER" \
  --manager-name "$QA_MANAGER" \
  --task-goal "Manual QA pass for current workerctl lifecycle" \
  --task-summary "Disposable focused manual QA run" \
  --task-prompt "Manual QA worker. Do not edit product files. Wait for manager instructions and report status only." \
  --cwd "$PWD" \
  --manager-mode strict \
  --manager-objective "Run a focused manual QA pass without product edits." \
  --manager-acceptance "No product source files are edited." \
  --manager-acceptance "Finish captures transcript before stopping both sessions." \
  --manager-reference "docs/manual-qa-checklist.md" \
  --sandbox workspace-write \
  --ask-for-approval never \
  > "$QA_ROOT/05-pair.stdout" 2> "$QA_ROOT/05-pair.stderr"
```

Expected:

- Pair command exits 0.
- Output includes worker and manager registration details.

- [ ] **Step 5: Exercise observation, nudge, and criteria flow**

Run:

```bash
scripts/workerctl cycle "$QA_TASK" --busy-wait-seconds 5 > "$QA_ROOT/06-cycle.stdout" 2> "$QA_ROOT/06-cycle.stderr"
scripts/workerctl session-nudge "$QA_WORKER" "manual QA dry-run status request" --dry-run > "$QA_ROOT/07-session-nudge-dry-run.stdout" 2> "$QA_ROOT/07-session-nudge-dry-run.stderr"
scripts/workerctl criteria "$QA_TASK" --add \
  --criterion "Manual QA criterion can be recorded and satisfied" \
  --source manager_inferred \
  --status accepted \
  --proof "Manual QA pass criterion" \
  --evidence-json '{"command":"manual QA criteria add","status":"pass"}' \
  > "$QA_ROOT/08-criteria-add.stdout" 2> "$QA_ROOT/08-criteria-add.stderr"
CRITERION_ID="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["affected_criterion"]["id"])' "$QA_ROOT/08-criteria-add.stdout")"
scripts/workerctl finish-task "$QA_TASK" --require-criteria-audit \
  > "$QA_ROOT/09-finish-blocked.stdout" 2> "$QA_ROOT/09-finish-blocked.stderr" || true
scripts/workerctl criteria "$QA_TASK" --satisfy "$CRITERION_ID" \
  --proof "Manual QA criterion satisfied" \
  --evidence-json '{"command":"manual QA criteria satisfy","status":"pass"}' \
  > "$QA_ROOT/10-criteria-satisfy.stdout" 2> "$QA_ROOT/10-criteria-satisfy.stderr"
```

Expected:

- `09-finish-blocked` exits nonzero and explains accepted criteria remain open.
- Criteria satisfy exits 0.

- [ ] **Step 6: Finish, export, and cleanup**

Run:

```bash
scripts/workerctl finish-task "$QA_TASK" \
  --reason "manual QA pass complete" \
  --require-criteria-audit \
  --capture-transcript-before-stop \
  --capture-transcript-mode excerpt \
  --capture-transcript-lines 120 \
  --stop-manager \
  --stop-worker \
  > "$QA_ROOT/11-finish.stdout" 2> "$QA_ROOT/11-finish.stderr"
scripts/workerctl transcript-show "$QA_TASK" --json > "$QA_ROOT/12-transcript-show.stdout" 2> "$QA_ROOT/12-transcript-show.stderr"
scripts/workerctl replay "$QA_TASK" --json > "$QA_ROOT/13-replay.stdout" 2> "$QA_ROOT/13-replay.stderr"
scripts/workerctl export-task "$QA_TASK" --output "$QA_ROOT/export" --zip --include-transcripts > "$QA_ROOT/14-export.stdout" 2> "$QA_ROOT/14-export.stderr"
scripts/workerctl sessions --state active > "$QA_ROOT/15-sessions-after.stdout" 2> "$QA_ROOT/15-sessions-after.stderr"
scripts/workerctl reconcile --stale-cycles-seconds 1 > "$QA_ROOT/16-reconcile-after.stdout" 2> "$QA_ROOT/16-reconcile-after.stderr"
```

Expected:

- Finish exits 0 and reports `killed_worker: true`, `killed_manager: true`.
- Transcript show returns transcript records.
- Replay includes cycle, criteria, finish, transcript evidence.
- Export writes `manifest.json` and zip.
- Sessions after contains no manual QA worker/manager.
- Reconcile after is clean.

- [ ] **Step 7: Record manual QA result**

Append to `docs/live-qa-log.md`:

```markdown
## 2026-05-19: Focused Manual QA Pass

Scenario:

- Checklist: `docs/manual-qa-checklist.md`
- Evidence bundle: the `QA_ROOT` path printed by Step 2.

Validated:

- Preflight doctor/db-doctor/reconcile passed.
- Disposable pair with seeded manager config was created.
- `cycle`, `session-nudge --dry-run`, criteria add/list/satisfy, blocked audited finish, final audited finish, transcript-show, replay, and export were exercised.
- Final cleanup left no manual QA sessions active and reconcile clean.

Decision:

- Focused manual QA passed.
```

- [ ] **Step 8: Commit**

```bash
git add docs/manual-qa-checklist.md docs/live-qa-log.md docs/live-qa-artifacts/
git commit -m "docs: record focused manual qa pass"
```

---

### Task 5: Fix ResourceWarning Test Hygiene

**Files:**
- Modify: `tests/test_workerctl.py`
- Modify production files only if the warnings come from production connection ownership, likely one of:
  - `workerctl/commands.py`
  - `workerctl/db.py`
  - `workerctl/lifecycle.py`

- [x] **Step 1: Reproduce warnings with allocation traces**

Run:

```bash
PYTHONTRACEMALLOC=10 python3 -W always::ResourceWarning -m unittest discover -s tests -v
```

Expected:

- ResourceWarning output includes allocation traces for unclosed SQLite
  connections.
- Note the first warning test and traceback.

- [x] **Step 2: Isolate the first warning area**

Run the first warning test by name, replacing the example:

```bash
PYTHONTRACEMALLOC=10 python3 -W always::ResourceWarning -m unittest tests.test_workerctl.CaptureErrorVisibilityTests.test_wait_for_status_update_writes_capture_failed_event_on_capture_error -v
```

Expected:

- Same ResourceWarning output appears in a smaller run.

- [x] **Step 3: Fix connection ownership**

Use the traceback to identify each `worker_db.connect(...)` call that is not closed. The preferred fix pattern is:

```python
with worker_db.connect(db_path) as conn:
    worker_db.initialize_database(conn)
    # existing database work
    conn.commit()
```

If the connection is returned to the caller, do not close it in the callee. Instead, update the test to close it with `self.addCleanup(conn.close)` or a `with` block.

- [x] **Step 4: Verify targeted warning-clean test**

Run the targeted test again. If the first failing test is still the known
capture-error case, use:

```bash
PYTHONTRACEMALLOC=10 python3 -W always::ResourceWarning -m unittest tests.test_workerctl.CaptureErrorVisibilityTests.test_wait_for_status_update_writes_capture_failed_event_on_capture_error -v
```

Expected:

- The targeted test passes without ResourceWarning. If Step 1 identified a
  different first failing test, run that exact test name and record it in the
  commit message body.

- [x] **Step 5: Repeat until full warning-clean suite passes**

Run:

```bash
scripts/check-resource-warnings
```

Expected:

- Full test suite passes with no ResourceWarning output.

- [x] **Step 6: Run normal verification**

Run:

```bash
python3 -m unittest discover -s tests -v
python3 -m py_compile scripts/workerctl scripts/check-resource-warnings workerctl/*.py
```

Expected:

- Normal suite and compile pass.

- [x] **Step 7: Commit**

```bash
git add tests/test_workerctl.py workerctl
git commit -m "test: close database resources cleanly"
```

---

### Task 6: Add ResourceWarning Gate To CI

**Files:**
- Modify: `.github/workflows/test.yml`
- Modify: `README.md`

- [x] **Step 1: Update CI workflow**

Modify `.github/workflows/test.yml` so the test job includes this step after the normal unittest step:

```yaml
      - name: Fail on ResourceWarning output
        run: scripts/check-resource-warnings
```

- [x] **Step 2: Update README QA gate**

In `README.md`, update the deterministic gate block to:

```bash
python3 -m unittest discover -s tests -v
scripts/check-resource-warnings
python3 -m py_compile scripts/workerctl scripts/check-resource-warnings workerctl/*.py
```

- [x] **Step 3: Run verification**

Run:

```bash
python3 -m unittest discover -s tests -v
scripts/check-resource-warnings
python3 -m py_compile scripts/workerctl scripts/check-resource-warnings workerctl/*.py
```

Expected:

- All three commands pass.

- [x] **Step 4: Commit**

```bash
git add .github/workflows/test.yml README.md
git commit -m "ci: fail on resource warnings"
```

---

### Task 7: Final Release Readiness Decision

**Files:**
- Modify: `docs/live-qa-log.md`
- Read: PR checks or local verification output

- [ ] **Step 1: Run final gates**

Run:

```bash
python3 -m unittest discover -s tests -v
scripts/check-resource-warnings
python3 -m py_compile scripts/workerctl scripts/check-resource-warnings workerctl/*.py
bash -n scripts/live-smoke
bash -n scripts/live-smoke-repeat
scripts/live-smoke-repeat 3
scripts/workerctl sessions --state active
scripts/workerctl reconcile --stale-cycles-seconds 1
git status --short
```

Expected:

- Unit tests pass.
- ResourceWarning output gate passes.
- Compile passes.
- Both scripts are syntax-clean.
- Repeat live smoke passes.
- Active sessions are empty or contain only explicitly unrelated sessions.
- Reconcile is clean.
- Git status contains only intended artifacts/log entries before final commit.

- [ ] **Step 2: Record final decision**

Append one of these concrete decision blocks to `docs/live-qa-log.md`.

Use this block when all gates pass:

```markdown
## 2026-05-19: Release Readiness Decision

Decision:

- Ready for release candidate: yes.
- Ready to reduce manual QA dependence: yes.

Evidence:

- Unit tests: `python3 -m unittest discover -s tests -v` passed.
- ResourceWarning gate: `scripts/check-resource-warnings` passed.
- Compile: `python3 -m py_compile scripts/workerctl scripts/check-resource-warnings workerctl/*.py` passed.
- Repeat live smoke: `scripts/live-smoke-repeat 3` passed.
- Focused manual QA: focused manual QA pass recorded in `docs/live-qa-log.md`.
- Cleanup: `scripts/workerctl sessions --state active` and `scripts/workerctl reconcile --stale-cycles-seconds 1` were clean.
- CI: GitHub PR checks passed, or local-only CI equivalent was recorded if the branch was not pushed.

Remaining risks:

- Hosted GitHub live-smoke remains manual and skips the live step when `codex`
  is unavailable on the runner.
```

Use this block when any required gate fails:

```markdown
## 2026-05-19: Release Readiness Decision

Decision:

- Ready for release candidate: no.
- Ready to reduce manual QA dependence: no.

Evidence:

- Unit tests: record pass or failing command.
- ResourceWarning gate: record pass or failing command.
- Compile: record pass or failing command.
- Repeat live smoke: record pass or failing run artifact path.
- Focused manual QA: record pass or failing manual QA artifact path.
- Cleanup: record `sessions --state active` and `reconcile` result.
- CI: record PR check state if available.

Remaining risks:

- The failed gate above must be fixed before a release candidate decision.
```

- [ ] **Step 3: Commit**

```bash
git add docs/live-qa-log.md docs/live-qa-artifacts/
git commit -m "docs: record release readiness decision"
```

---

## Self-Review

- Spec coverage: this plan covers the clear next work after current QA readiness: branch landing, repeated live smoke, focused manual QA, ResourceWarning cleanup, CI hardening, and release-readiness decision.
- Placeholder scan: no task uses `TBD`, vague “fix it” language, or commands without required arguments.
- Type and command consistency:
  - `pair` includes required task/worker/manager/goal flags and manager config flags where seeded config is expected.
  - `session-nudge` includes required text even with `--dry-run`.
  - `criteria` actions are split into mutually exclusive commands.
  - Live smoke repeat calls current scripts and current `workerctl` commands only.
- Scope note: do not add packaging, type checking, linting, or platform expansion in this plan. Those are useful later, but the immediate goal is QA/release confidence.
