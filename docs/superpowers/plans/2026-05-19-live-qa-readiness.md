# Live QA Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the stale live smoke path with a current, repeatable QA gate and use it to decide manual QA readiness for `codex-terminal-manager`.

**Architecture:** Keep the existing stdlib Python/unittest approach for deterministic coverage, and make the live QA smoke a Bash-driven integration gate around the current `workerctl` CLI. The live gate should exercise real tmux/Codex lifecycle behavior, write evidence artifacts under `docs/live-qa-artifacts/`, and leave no active sessions, tmux panes, dangling bindings, or stuck tasks.

**Tech Stack:** Bash, Python stdlib `unittest`, SQLite via existing `workerctl`, tmux, Codex CLI, GitHub Actions.

---

## Current Baseline

- Unit tests pass locally: `python3 -m unittest discover -s tests -v` ran 346 tests successfully.
- Compile check passes locally: `python3 -m py_compile scripts/workerctl workerctl/*.py`.
- Current CI: [.github/workflows/test.yml](../../.github/workflows/test.yml) runs unittest and py_compile on `macos-latest`.
- Current live smoke is stale: [scripts/live-smoke](../../scripts/live-smoke) calls removed commands including `promote`, `task-status`, `pause-manager`, `resume-manager`, and `recover`.
- Current high-risk behavior: `pair`, `cycle`, `session-nudge`, criteria audit, transcript capture before stop, finish cleanup, replay/export.

## File Structure

- Modify: `scripts/live-smoke`
  - Owns the current live integration flow.
  - Must use only commands present in `scripts/workerctl --help`.
- Modify: `tests/test_workerctl.py`
  - Add or update tests that keep `scripts/live-smoke` aligned with the current CLI surface.
- Modify: `.github/workflows/test.yml`
  - Keep fast unit/compile CI as-is.
  - Add a manual/scheduled live-smoke job only after the script is stable.
- Modify: `README.md`
  - Document the smoke command, prerequisites, expected cleanup, and when to run it.
- Modify: `docs/live-qa-log.md`
  - Record the first passing run of the refreshed smoke.
- Create: `docs/live-qa-artifacts/YYYY-MM-DD-live-smoke-current-cli/`
  - Store command outputs and exported task evidence for the first run.

---

### Task 1: Add a Regression Test That Detects Stale Live-Smoke Commands

**Files:**
- Modify: `tests/test_workerctl.py`
- Read: `scripts/live-smoke`
- Read: `workerctl/cli.py`

- [ ] **Step 1: Add the failing test**

Add a test class near the existing CLI/script tests in `tests/test_workerctl.py`:

```python
class LiveSmokeScriptTests(unittest.TestCase):
    def test_live_smoke_uses_existing_workerctl_subcommands(self):
        parser = worker_cli.build_parser()
        subcommands = set(parser._subparsers._group_actions[0].choices)
        script = (ROOT / "scripts" / "live-smoke").read_text()

        used = set()
        for line in script.splitlines():
            stripped = line.strip()
            if "WORKERCTL" not in stripped and "workerctl" not in stripped:
                continue
            parts = stripped.replace('"${WORKERCTL}"', "workerctl").replace('"$WORKERCTL"', "workerctl").split()
            if "workerctl" not in parts:
                continue
            index = parts.index("workerctl")
            if index + 1 < len(parts):
                candidate = parts[index + 1]
                if candidate and not candidate.startswith("-"):
                    used.add(candidate)

        missing = sorted(command for command in used if command not in subcommands)
        self.assertEqual([], missing)
```

If `workerctl.cli` is not already imported as `worker_cli`, add:

```python
from workerctl import cli as worker_cli
```

- [ ] **Step 2: Run the focused test and verify it fails before the script is fixed**

Run:

```bash
python3 -m unittest tests.test_workerctl.LiveSmokeScriptTests.test_live_smoke_uses_existing_workerctl_subcommands -v
```

Expected before fixing `scripts/live-smoke`: failure listing stale commands such as `promote`, `task-status`, `pause-manager`, `resume-manager`, or `recover`.

- [ ] **Step 3: Commit only the failing test if using strict TDD**

```bash
git add tests/test_workerctl.py
git commit -m "test: guard live smoke command surface"
```

Skip this commit if working in a single local patch, but still keep the test before implementation.

---

### Task 2: Rewrite `scripts/live-smoke` Around Current CLI Commands

**Files:**
- Modify: `scripts/live-smoke`

- [ ] **Step 1: Replace stale flow with current command flow**

The refreshed smoke should:

1. Verify required tools: `tmux`, `codex`, `rg`.
2. Generate unique names.
3. Run `pair` with seeded manager config.
4. Run `cycle`.
5. Exercise `session-nudge --dry-run`.
6. Add and satisfy one acceptance criterion.
7. Run `finish-task --require-criteria-audit --capture-transcript-before-stop --stop-manager --stop-worker`.
8. Run `transcript-show`, `mutation-audit`, `replay`, `export-task`, `sessions`, and `reconcile`.
9. Fail if cleanup leaves active smoke sessions or stuck state.

Use this structure:

```bash
#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKERCTL="${ROOT}/scripts/workerctl"
SMOKE_ID="smoke-$(date +%Y%m%d%H%M%S)"
TASK="codex-smoke-task-${SMOKE_ID}"
WORKER="codex-smoke-worker-${SMOKE_ID}"
MANAGER="codex-smoke-manager-${SMOKE_ID}"
ARTIFACT_ROOT="${ROOT}/docs/live-qa-artifacts/$(date +%Y-%m-%d)-live-smoke-current-cli-${SMOKE_ID}"

require_tool() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "missing required tool: $1" >&2
    exit 1
  fi
}

run_capture() {
  local name="$1"
  shift
  "$@" > "${ARTIFACT_ROOT}/${name}.stdout" 2> "${ARTIFACT_ROOT}/${name}.stderr"
  printf '%s\n' "$?" > "${ARTIFACT_ROOT}/${name}.exit"
}

cleanup() {
  tmux kill-session -t "codex-${WORKER}" 2>/dev/null || true
  tmux kill-session -t "codex-${MANAGER}" 2>/dev/null || true
}

trap cleanup EXIT

require_tool tmux
require_tool codex
require_tool rg

mkdir -p "${ARTIFACT_ROOT}"
cd "${ROOT}"

echo "artifact root: ${ARTIFACT_ROOT}"
echo "smoke task: ${TASK}"
echo "smoke worker: ${WORKER}"
echo "smoke manager: ${MANAGER}"

run_capture "01-pair" "${WORKERCTL}" pair \
  --task "${TASK}" \
  --worker-name "${WORKER}" \
  --manager-name "${MANAGER}" \
  --cwd "${ROOT}" \
  --task-goal "Live smoke test worker-manager lifecycle" \
  --task-summary "Current CLI live smoke" \
  --task-prompt "Smoke test worker. Do not edit files. Wait for manager instructions and report status only." \
  --manager-mode strict \
  --manager-objective "Verify live smoke lifecycle without editing product files." \
  --manager-guideline "Use workerctl cycle before deciding." \
  --manager-acceptance "The worker remains status-only and no product files are edited." \
  --manager-reference "scripts/live-smoke" \
  --sandbox workspace-write \
  --ask-for-approval never \
  --timeout-seconds 90

run_capture "02-cycle" "${WORKERCTL}" cycle "${TASK}" --busy-wait-seconds 5
run_capture "03-session-nudge-dry-run" "${WORKERCTL}" session-nudge "${WORKER}" "dry-run status request" --dry-run

CRITERION_ID="$("${WORKERCTL}" criteria "${TASK}" --add \
  --criterion "Live smoke reached current CLI criterion mutation path" \
  --source manager_inferred \
  --status accepted \
  --proof "Added by scripts/live-smoke" \
  --evidence-json '{"command":"scripts/live-smoke","status":"running"}' \
  | tee "${ARTIFACT_ROOT}/04-criteria-add.stdout" \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["affected_criterion"]["id"])')"
printf '%s\n' "${CRITERION_ID}" > "${ARTIFACT_ROOT}/04-criteria-id.txt"

run_capture "05-criteria-satisfy" "${WORKERCTL}" criteria "${TASK}" --satisfy "${CRITERION_ID}" \
  --proof "Current CLI smoke criterion satisfied" \
  --evidence-json '{"command":"scripts/live-smoke criteria satisfy","status":"pass"}'

run_capture "06-criteria-list" "${WORKERCTL}" criteria "${TASK}" --list
run_capture "07-finish-task" "${WORKERCTL}" finish-task "${TASK}" \
  --reason "live smoke complete" \
  --require-criteria-audit \
  --capture-transcript-before-stop \
  --capture-transcript-mode excerpt \
  --capture-transcript-lines 120 \
  --stop-manager \
  --stop-worker

run_capture "08-transcript-show" "${WORKERCTL}" transcript-show "${TASK}" --json --limit 20
run_capture "09-mutation-audit" "${WORKERCTL}" mutation-audit "${TASK}" --json
run_capture "10-replay" "${WORKERCTL}" replay "${TASK}" --json
run_capture "11-export-task" "${WORKERCTL}" export-task "${TASK}" --output "${ARTIFACT_ROOT}/export" --zip --include-transcripts
run_capture "12-sessions-active" "${WORKERCTL}" sessions --state active
run_capture "13-reconcile" "${WORKERCTL}" reconcile --stale-cycles-seconds 1

if rg "${WORKER}|${MANAGER}" "${ARTIFACT_ROOT}/12-sessions-active.stdout" >/dev/null; then
  echo "live smoke left smoke sessions active" >&2
  exit 1
fi

python3 - "${ARTIFACT_ROOT}/13-reconcile.stdout" <<'PY'
import json
import sys

data = json.load(open(sys.argv[1]))
for key in ("dangling_bindings", "dead_pid_sessions", "stuck_tasks"):
    if data.get(key):
        raise SystemExit(f"reconcile reported {key}: {data[key]}")
PY

echo "live smoke passed"
```

- [ ] **Step 2: Run the command-surface test**

Run:

```bash
python3 -m unittest tests.test_workerctl.LiveSmokeScriptTests.test_live_smoke_uses_existing_workerctl_subcommands -v
```

Expected: `OK`.

- [ ] **Step 3: Run shell syntax check**

Run:

```bash
bash -n scripts/live-smoke
```

Expected: no output and exit code 0.

- [ ] **Step 4: Run full unit suite**

Run:

```bash
python3 -m unittest discover -s tests -v
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add scripts/live-smoke tests/test_workerctl.py
git commit -m "fix: refresh live smoke for current cli"
```

---

### Task 3: Run the Refreshed Live Smoke and Capture Evidence

**Files:**
- Create: `docs/live-qa-artifacts/YYYY-MM-DD-live-smoke-current-cli-*/`
- Modify: `docs/live-qa-log.md`

- [ ] **Step 1: Confirm environment health**

Run:

```bash
scripts/workerctl doctor
scripts/workerctl sessions --state active
scripts/workerctl reconcile --stale-cycles-seconds 1
```

Expected:

- `doctor` reports `"ok": true`.
- No smoke sessions are active before starting.
- `reconcile` reports empty `dangling_bindings`, `dead_pid_sessions`, and `stuck_tasks`.

- [ ] **Step 2: Run the live smoke**

Run:

```bash
scripts/live-smoke
```

Expected:

- Final stdout includes `live smoke passed`.
- Artifact directory is printed.
- No product source files are modified by the worker.

- [ ] **Step 3: Inspect smoke artifacts**

Run, replacing the directory with the printed artifact root:

```bash
ARTIFACT_ROOT="docs/live-qa-artifacts/<printed-live-smoke-dir>"
find "$ARTIFACT_ROOT" -maxdepth 2 -type f | sort
cat "$ARTIFACT_ROOT/07-finish-task.stdout"
cat "$ARTIFACT_ROOT/13-reconcile.stdout"
```

Expected:

- `07-finish-task.stdout` includes transcript capture summary and stopped sessions.
- `13-reconcile.stdout` has empty `dangling_bindings`, `dead_pid_sessions`, and `stuck_tasks`.
- `export/manifest.json` exists.

- [ ] **Step 4: Record the QA log entry**

Append to `docs/live-qa-log.md`:

```markdown
## 2026-05-19: Current CLI Live Smoke

Scenario:

- Script: `scripts/live-smoke`
- Evidence bundle: `docs/live-qa-artifacts/<printed-live-smoke-dir>/`
- Codex model: current Codex CLI default

Validated:

- `pair` created a session-bound worker and manager using current CLI flags.
- `cycle` returned a manager observation for the task.
- `session-nudge --dry-run` resolved the worker session target.
- Acceptance criteria add/list/satisfy flow worked.
- `finish-task --require-criteria-audit --capture-transcript-before-stop --stop-manager --stop-worker` completed.
- `transcript-show`, `mutation-audit`, `replay`, and `export-task` produced evidence.
- Post-run `sessions --state active` and `reconcile --stale-cycles-seconds 1` showed no smoke cleanup issues.

Findings:

- None if all checks passed.
```

- [ ] **Step 5: Commit**

```bash
git add docs/live-qa-log.md docs/live-qa-artifacts/
git commit -m "docs: record current cli live smoke"
```

---

### Task 4: Document QA Gates and Manual QA Checklist

**Files:**
- Modify: `README.md`
- Optionally create: `docs/manual-qa-checklist.md`

- [ ] **Step 1: Update README QA section**

Add this under the testing/verification section:

```markdown
## QA Gates

Fast deterministic gate:

```bash
python3 -m unittest discover -s tests -v
python3 -m py_compile scripts/workerctl workerctl/*.py
```

Live local smoke gate:

```bash
scripts/live-smoke
```

The live smoke requires macOS, `tmux`, `codex`, and `rg`. It starts disposable
Codex worker/manager sessions, exercises `pair`, `cycle`, `session-nudge`,
criteria mutation, transcript capture before stop, replay, mutation audit, and
export, then verifies cleanup with `sessions --state active` and `reconcile`.
```

- [ ] **Step 2: Add manual QA checklist**

Create `docs/manual-qa-checklist.md`:

```markdown
# Manual QA Checklist

Run this after unit tests and `scripts/live-smoke` pass.

- [ ] `scripts/workerctl doctor` reports `ok: true`.
- [ ] `scripts/workerctl db-doctor` reports schema health ok.
- [ ] `scripts/workerctl pair` creates worker and manager with seeded manager config.
- [ ] `scripts/workerctl cycle <task>` reports pane signal and manager context.
- [ ] `scripts/workerctl session-nudge <worker> --dry-run` resolves the target.
- [ ] `scripts/workerctl session-nudge <worker> "..."` sends text to the correct pane in a disposable run.
- [ ] `scripts/workerctl criteria <task> --add/--satisfy/--list` records expected state.
- [ ] `scripts/workerctl finish-task <task> --require-criteria-audit` blocks when accepted criteria remain open.
- [ ] `scripts/workerctl finish-task <task> --capture-transcript-before-stop --stop-manager --stop-worker` captures transcript and stops both sessions.
- [ ] `scripts/workerctl transcript-show <task> --json` returns captured transcript records.
- [ ] `scripts/workerctl replay <task> --json` includes cycle, criteria, finish, and transcript evidence.
- [ ] `scripts/workerctl export-task <task> --zip --include-transcripts` writes a manifest and zip.
- [ ] `scripts/workerctl sessions --state active` has no disposable QA sessions after cleanup.
- [ ] `scripts/workerctl reconcile --stale-cycles-seconds 1` reports no dangling bindings, dead PID sessions, or stuck tasks.
```

- [ ] **Step 3: Commit**

```bash
git add README.md docs/manual-qa-checklist.md
git commit -m "docs: document qa gates"
```

---

### Task 5: Add a Manual GitHub Actions Live-Smoke Workflow

**Files:**
- Create: `.github/workflows/live-smoke.yml`

- [ ] **Step 1: Add workflow file**

Create `.github/workflows/live-smoke.yml`:

```yaml
name: Live Smoke

on:
  workflow_dispatch:

jobs:
  live-smoke:
    runs-on: macos-latest
    timeout-minutes: 30

    steps:
      - name: Check out repository
        uses: actions/checkout@v4

      - name: Show Python version
        run: python3 --version

      - name: Install required tools
        run: |
          brew install tmux ripgrep

      - name: Check Codex CLI availability
        run: |
          if ! command -v codex >/dev/null 2>&1; then
            echo "codex CLI is not available in GitHub Actions; run scripts/live-smoke locally instead"
            exit 78
          fi

      - name: Run live smoke
        run: scripts/live-smoke

      - name: Upload live smoke artifacts
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: live-smoke-artifacts
          path: docs/live-qa-artifacts/
```

This is intentionally `workflow_dispatch` only. If Codex CLI is unavailable in hosted CI, the workflow exits neutral with code `78` instead of pretending CI can run live QA.

- [ ] **Step 2: Run workflow syntax-adjacent checks locally**

Run:

```bash
python3 -m py_compile scripts/workerctl workerctl/*.py
python3 -m unittest discover -s tests -v
```

Expected: both pass.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/live-smoke.yml
git commit -m "ci: add manual live smoke workflow"
```

---

### Task 6: Final Readiness Review

**Files:**
- Read: `docs/live-qa-log.md`
- Read: `docs/manual-qa-checklist.md`
- Read: GitHub Actions results for unit CI and optional live smoke

- [ ] **Step 1: Run final deterministic verification**

Run:

```bash
python3 -m unittest discover -s tests -v
python3 -m py_compile scripts/workerctl workerctl/*.py
bash -n scripts/live-smoke
scripts/workerctl sessions --state active
scripts/workerctl reconcile --stale-cycles-seconds 1
git status --short
```

Expected:

- Tests pass.
- Compile passes.
- `bash -n` is silent.
- No active disposable sessions remain.
- Reconcile is clean.
- Git status contains only intentional files before commit, or is clean after commit.

- [ ] **Step 2: Make readiness decision**

Use this decision rule:

- Ready for manual QA if unit tests pass, live smoke passes locally, cleanup is clean, and the manual checklist exists.
- Ready to reduce manual QA only after live smoke runs reliably at least three times and covers transcript capture, criteria audit, replay/export, and cleanup.
- Not ready for release if live smoke is failing, stale, or skipped.

- [ ] **Step 3: Record final status**

Append a short status block to `docs/live-qa-log.md`:

```markdown
## 2026-05-19: QA Readiness Decision

Decision:

- Ready for focused manual QA: yes/no.
- Automated QA confidence: unit/regression coverage is green; live lifecycle coverage is passing/failing/skipped.

Evidence:

- Unit tests: `python3 -m unittest discover -s tests -v`
- Compile: `python3 -m py_compile scripts/workerctl workerctl/*.py`
- Live smoke: `scripts/live-smoke`
- Cleanup: `scripts/workerctl reconcile --stale-cycles-seconds 1`

Remaining risks:

- Real Codex/tmux behavior still requires manual inspection until live smoke is stable across repeated runs.
```

- [ ] **Step 4: Commit**

```bash
git add docs/live-qa-log.md
git commit -m "docs: record qa readiness decision"
```

---

## Self-Review

- Spec coverage: the plan covers stale smoke repair, current CLI live smoke, manual QA checklist, CI integration, evidence capture, and readiness decision.
- Placeholder scan: no implementation step depends on unspecified command names.
- Type/signature consistency: commands match current help output for `pair`, `cycle`, `criteria`, `session-nudge`, `finish-task`, `transcript-show`, `mutation-audit`, and `export-task`.
- Known risk: live smoke depends on a locally authenticated Codex CLI and can be slower or flaky when Codex startup is slow. Keep the timeout explicit and record startup failures as QA evidence rather than silently retrying forever.
