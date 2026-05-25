# Dispatch Loop Lab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a resettable sibling repo that repeatedly exercises the real worker/manager/Dispatch loop with a tiny failing pytest project and dashboard observation.

**Architecture:** The product repo keeps only the design/plan and the small dashboard fix already found during QA. The sibling lab repo contains the tiny Python project plus a `lab` operator script that shells out to this repo's `scripts/workerctl`. The lab script stores active run metadata in `.lab/run.env`, uses unique run names, and keeps reset/cleanup behavior explicit.

**Tech Stack:** Python 3, pytest, POSIX shell, git, tmux/Codex through `workerctl`, dashboard on localhost.

---

## File Structure

Current product repo:

- Existing: `dashboard/server/index.ts`
  - Already changed on this branch to ignore `gone` dashboard terminal registrations.
- Existing: `dashboard/server/workerctl.test.ts`
  - Already changed on this branch with a regression test for `gone` dashboard terminal registrations.
- Existing: `docs/superpowers/specs/2026-05-25-dispatch-loop-lab-design.md`
  - Design document for this lab.
- Create: `docs/superpowers/plans/2026-05-25-dispatch-loop-lab.md`
  - This implementation plan.

Sibling lab repo:

- Create directory: `/Users/neonwatty/Desktop/workerctl-dispatch-lab`
- Create: `/Users/neonwatty/Desktop/workerctl-dispatch-lab/.gitignore`
  - Ignore lab runtime metadata, pytest cache, virtualenvs, and Python cache.
- Create: `/Users/neonwatty/Desktop/workerctl-dispatch-lab/README.md`
  - Explain the purpose, commands, and manual QA flow.
- Create: `/Users/neonwatty/Desktop/workerctl-dispatch-lab/lab`
  - Operator script for reset/start/dashboard/cycle/status/cleanup.
- Create: `/Users/neonwatty/Desktop/workerctl-dispatch-lab/pyproject.toml`
  - Minimal pytest project metadata.
- Create: `/Users/neonwatty/Desktop/workerctl-dispatch-lab/src/dispatch_lab/__init__.py`
  - Package marker.
- Create: `/Users/neonwatty/Desktop/workerctl-dispatch-lab/src/dispatch_lab/calculator.py`
  - Intentionally wrong implementation at baseline.
- Create: `/Users/neonwatty/Desktop/workerctl-dispatch-lab/tests/test_calculator.py`
  - Tiny failing pytest.

---

### Task 0: Commit Current Dashboard QA Fix

**Files:**
- Modify: `dashboard/server/index.ts`
- Modify: `dashboard/server/workerctl.test.ts`
- Create: `docs/superpowers/specs/2026-05-25-dispatch-loop-lab-design.md`
- Create: `docs/superpowers/plans/2026-05-25-dispatch-loop-lab.md`

- [ ] **Step 1: Verify dashboard terminal regression tests**

Run:

```bash
npm test -- --runInBand
npm run build
git diff --check -- dashboard/server/index.ts dashboard/server/workerctl.test.ts docs/superpowers/specs/2026-05-25-dispatch-loop-lab-design.md docs/superpowers/plans/2026-05-25-dispatch-loop-lab.md
```

Expected:

```text
31 dashboard tests pass
vite build succeeds
git diff --check exits 0
```

- [ ] **Step 2: Confirm the regression exists in the test file**

Run:

```bash
rg -n "ignores gone registrations for dashboard terminals|isDashboardSession" dashboard/server/workerctl.test.ts dashboard/server/index.ts
```

Expected output includes:

```text
dashboard/server/index.ts:export function isDashboardSession
dashboard/server/workerctl.test.ts:test("ignores gone registrations for dashboard terminals"
```

- [ ] **Step 3: Commit current product-repo support work**

Run:

```bash
git add dashboard/server/index.ts dashboard/server/workerctl.test.ts docs/superpowers/specs/2026-05-25-dispatch-loop-lab-design.md docs/superpowers/plans/2026-05-25-dispatch-loop-lab.md
git commit -m "Prepare dispatch loop lab"
```

Expected:

```text
[codex/dashboard-hide-gone-registrations <sha>] Prepare dispatch loop lab
```

If the design doc or dashboard fix is already committed before this plan is executed, commit only the uncommitted plan file:

```bash
git add docs/superpowers/plans/2026-05-25-dispatch-loop-lab.md
git commit -m "Plan dispatch loop lab"
```

---

### Task 1: Scaffold the Sibling Lab Repo

**Files:**
- Create: `/Users/neonwatty/Desktop/workerctl-dispatch-lab/.gitignore`
- Create: `/Users/neonwatty/Desktop/workerctl-dispatch-lab/README.md`
- Create: `/Users/neonwatty/Desktop/workerctl-dispatch-lab/pyproject.toml`
- Create: `/Users/neonwatty/Desktop/workerctl-dispatch-lab/src/dispatch_lab/__init__.py`
- Create: `/Users/neonwatty/Desktop/workerctl-dispatch-lab/src/dispatch_lab/calculator.py`
- Create: `/Users/neonwatty/Desktop/workerctl-dispatch-lab/tests/test_calculator.py`

- [ ] **Step 1: Create the repo directory**

Run:

```bash
mkdir -p /Users/neonwatty/Desktop/workerctl-dispatch-lab/src/dispatch_lab /Users/neonwatty/Desktop/workerctl-dispatch-lab/tests
cd /Users/neonwatty/Desktop/workerctl-dispatch-lab
git init
```

Expected:

```text
Initialized empty Git repository in /Users/neonwatty/Desktop/workerctl-dispatch-lab/.git/
```

- [ ] **Step 2: Create `.gitignore`**

Create `/Users/neonwatty/Desktop/workerctl-dispatch-lab/.gitignore` with:

```gitignore
.lab/
.pytest_cache/
.venv/
__pycache__/
*.pyc
dist/
build/
*.egg-info/
```

- [ ] **Step 3: Create `pyproject.toml`**

Create `/Users/neonwatty/Desktop/workerctl-dispatch-lab/pyproject.toml` with:

```toml
[project]
name = "workerctl-dispatch-lab"
version = "0.1.0"
description = "Resettable lab for workerctl manager/worker Dispatch QA."
requires-python = ">=3.11"

[tool.pytest.ini_options]
pythonpath = ["src"]
testpaths = ["tests"]
```

- [ ] **Step 4: Create package marker**

Create `/Users/neonwatty/Desktop/workerctl-dispatch-lab/src/dispatch_lab/__init__.py` with:

```python
"""Tiny intentionally-resettable project for workerctl Dispatch QA."""
```

- [ ] **Step 5: Create intentionally wrong implementation**

Create `/Users/neonwatty/Desktop/workerctl-dispatch-lab/src/dispatch_lab/calculator.py` with:

```python
def add(left: int, right: int) -> int:
    """Return the sum of two integers."""
    return left - right
```

- [ ] **Step 6: Create the failing test**

Create `/Users/neonwatty/Desktop/workerctl-dispatch-lab/tests/test_calculator.py` with:

```python
from dispatch_lab.calculator import add


def test_adds_two_numbers():
    assert add(2, 3) == 5
```

- [ ] **Step 7: Verify pytest fails at baseline**

Run:

```bash
cd /Users/neonwatty/Desktop/workerctl-dispatch-lab
python3 -m pytest -q
```

Expected:

```text
FAILED tests/test_calculator.py::test_adds_two_numbers
```

The failure should show `assert -1 == 5`.

- [ ] **Step 8: Commit failing baseline**

Run:

```bash
cd /Users/neonwatty/Desktop/workerctl-dispatch-lab
git add .gitignore pyproject.toml src/dispatch_lab/__init__.py src/dispatch_lab/calculator.py tests/test_calculator.py
git commit -m "Create failing dispatch lab baseline"
git tag failing-baseline
```

Expected:

```text
[main <sha>] Create failing dispatch lab baseline
```

---

### Task 2: Add Lab Script Metadata and Reset Commands

**Files:**
- Create: `/Users/neonwatty/Desktop/workerctl-dispatch-lab/lab`
- Modify: `/Users/neonwatty/Desktop/workerctl-dispatch-lab/README.md`

- [ ] **Step 1: Create `lab` script skeleton**

Create `/Users/neonwatty/Desktop/workerctl-dispatch-lab/lab` with:

```bash
#!/usr/bin/env bash
set -euo pipefail

LAB_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PRODUCT_ROOT="${PRODUCT_ROOT:-/Users/neonwatty/Desktop/codex-terminal-manager}"
WORKERCTL="${WORKERCTL:-$PRODUCT_ROOT/scripts/workerctl}"
LAB_STATE_DIR="$LAB_ROOT/.lab"
RUN_ENV="$LAB_STATE_DIR/run.env"
DASHBOARD_PORT="${DASHBOARD_PORT:-8797}"
DASHBOARD_HOST="${DASHBOARD_HOST:-127.0.0.1}"
DASHBOARD_DISPATCHER_ID="${DASHBOARD_DISPATCHER_ID:-qa-dispatch-dashboard}"

usage() {
  cat <<'USAGE'
Usage: ./lab <command>

Commands:
  reset       Reset repo to failing baseline and clear lab run metadata.
  new-run     Create a fresh lab run id and metadata without starting sessions.
  status      Print current lab metadata and useful commands.
USAGE
}

require_workerctl() {
  if [[ ! -x "$WORKERCTL" ]]; then
    echo "workerctl not found or not executable: $WORKERCTL" >&2
    exit 1
  fi
}

load_run_env() {
  if [[ ! -f "$RUN_ENV" ]]; then
    echo "No active lab run. Run ./lab new-run or ./lab start first." >&2
    exit 1
  fi
  # shellcheck disable=SC1090
  source "$RUN_ENV"
}

write_run_env() {
  mkdir -p "$LAB_STATE_DIR"
  local stamp
  stamp="$(date +%Y%m%d-%H%M%S)"
  local run_id="dispatch-lab-$stamp"
  cat > "$RUN_ENV" <<EOF
RUN_ID=$run_id
TASK=$run_id
WORKER=${run_id}-worker
MANAGER=${run_id}-manager
DASHBOARD_URL=http://$DASHBOARD_HOST:$DASHBOARD_PORT/?task=$run_id
EOF
  echo "Created run metadata: $RUN_ENV"
  cat "$RUN_ENV"
}

cmd_reset() {
  git -C "$LAB_ROOT" reset --hard failing-baseline
  git -C "$LAB_ROOT" clean -fd
  rm -rf "$LAB_STATE_DIR" "$LAB_ROOT/.pytest_cache"
  find "$LAB_ROOT" -type d -name __pycache__ -prune -exec rm -rf {} +
  echo "Reset to failing baseline."
}

cmd_new_run() {
  write_run_env
}

cmd_status() {
  require_workerctl
  load_run_env
  cat "$RUN_ENV"
  cat <<EOF

Useful commands:
  ./lab dashboard
  ./lab cycle
  "$WORKERCTL" audit "$TASK" --json
  "$WORKERCTL" telemetry --actor dispatch --event-type dispatch_watch_heartbeat --newest --limit 1 --json
EOF
}

case "${1:-}" in
  reset) cmd_reset ;;
  new-run) cmd_new_run ;;
  status) cmd_status ;;
  -h|--help|"") usage ;;
  *)
    echo "Unknown command: $1" >&2
    usage >&2
    exit 1
    ;;
esac
```

- [ ] **Step 2: Make script executable**

Run:

```bash
chmod +x /Users/neonwatty/Desktop/workerctl-dispatch-lab/lab
```

- [ ] **Step 3: Verify reset returns to failing baseline**

Run:

```bash
cd /Users/neonwatty/Desktop/workerctl-dispatch-lab
python3 - <<'PY'
from pathlib import Path
path = Path("src/dispatch_lab/calculator.py")
path.write_text('def add(left: int, right: int) -> int:\n    return left + right\n')
PY
./lab reset
python3 -m pytest -q
```

Expected:

```text
Reset to failing baseline.
FAILED tests/test_calculator.py::test_adds_two_numbers
```

- [ ] **Step 4: Verify run metadata creation**

Run:

```bash
cd /Users/neonwatty/Desktop/workerctl-dispatch-lab
./lab new-run
test -f .lab/run.env
./lab status
```

Expected:

```text
RUN_ID=dispatch-lab-
TASK=dispatch-lab-
WORKER=dispatch-lab-
MANAGER=dispatch-lab-
DASHBOARD_URL=http://127.0.0.1:8797/?task=dispatch-lab-
```

- [ ] **Step 5: Create `README.md`**

Create `/Users/neonwatty/Desktop/workerctl-dispatch-lab/README.md` with:

```markdown
# workerctl Dispatch Lab

This is a resettable real-integration lab for the `workerctl` manager/worker
Dispatch loop.

The baseline intentionally fails:

```bash
python3 -m pytest -q
```

The intended loop is:

```bash
./lab reset
./lab start
./lab dashboard
./lab cycle
# worker fixes the test in the real session
./lab cycle
./lab status
./lab cleanup
./lab reset
```

The dashboard should show Dispatch active and should eventually show
worker/manager routing evidence in the Dispatch conversation lane.
```

- [ ] **Step 6: Commit reset script**

Run:

```bash
cd /Users/neonwatty/Desktop/workerctl-dispatch-lab
git add README.md lab
git commit -m "Add resettable lab operator script"
```

Expected:

```text
[main <sha>] Add resettable lab operator script
```

---

### Task 3: Add Real Pair, Dashboard, Cycle, and Cleanup Commands

**Files:**
- Modify: `/Users/neonwatty/Desktop/workerctl-dispatch-lab/lab`
- Modify: `/Users/neonwatty/Desktop/workerctl-dispatch-lab/README.md`

- [ ] **Step 1: Extend usage text**

In `/Users/neonwatty/Desktop/workerctl-dispatch-lab/lab`, replace the `usage()` body with:

```bash
usage() {
  cat <<'USAGE'
Usage: ./lab <command>

Commands:
  reset       Reset repo to failing baseline and clear lab run metadata.
  new-run     Create a fresh lab run id and metadata without starting sessions.
  start       Create a real workerctl pair for the active or new run.
  dashboard   Start dashboard with Dispatch ensured for the active run.
  cycle       Run one manager cycle for the active run.
  status      Print current lab metadata and useful commands.
  cleanup     Stop lab sessions where possible and reconcile workerctl state.
USAGE
}
```

- [ ] **Step 2: Add `ensure_run_env` helper**

Add after `write_run_env()`:

```bash
ensure_run_env() {
  if [[ ! -f "$RUN_ENV" ]]; then
    write_run_env
  fi
  # shellcheck disable=SC1090
  source "$RUN_ENV"
}
```

- [ ] **Step 3: Add `start` command**

Add after `cmd_new_run()`:

```bash
cmd_start() {
  require_workerctl
  ensure_run_env
  "$WORKERCTL" pair \
    --task "$TASK" \
    --worker-name "$WORKER" \
    --manager-name "$MANAGER" \
    --cwd "$LAB_ROOT" \
    --codex-profile yolo \
    --manager-mode strict \
    --task-goal "Fix the failing pytest in the workerctl Dispatch lab." \
    --task-summary "Real manager/worker Dispatch QA loop in a resettable lab repo." \
    --task-prompt "You are the worker for a resettable Dispatch QA lab. Inspect the failing pytest, make the smallest code change so python3 -m pytest -q passes, run the test, then report completion with the commands and evidence you used." \
    --manager-objective "Verify the worker fixed the failing pytest in the lab repo with evidence." \
    --manager-acceptance "python3 -m pytest -q passes in the lab repo." \
    --manager-acceptance "git diff shows only the minimal calculator fix unless the worker explains otherwise."
  echo
  echo "Dashboard: $DASHBOARD_URL"
}
```

- [ ] **Step 4: Add `dashboard` command**

Add after `cmd_start()`:

```bash
cmd_dashboard() {
  require_workerctl
  load_run_env
  "$WORKERCTL" dashboard \
    --task "$TASK" \
    --ensure-dispatch \
    --dispatcher-id "$DASHBOARD_DISPATCHER_ID" \
    --host "$DASHBOARD_HOST" \
    --port "$DASHBOARD_PORT"
}
```

- [ ] **Step 5: Add `cycle` command**

Add after `cmd_dashboard()`:

```bash
cmd_cycle() {
  require_workerctl
  load_run_env
  "$WORKERCTL" cycle "$TASK"
}
```

- [ ] **Step 6: Add `cleanup` command**

Add after `cmd_cycle()`:

```bash
cmd_cleanup() {
  require_workerctl
  load_run_env
  "$WORKERCTL" finish-task "$TASK" \
    --capture-transcript-before-stop \
    --stop-manager \
    --stop-worker || true
  "$WORKERCTL" reconcile --apply --stale-cycles-seconds 1 || true
  echo
  echo "Remaining active lab sessions:"
  "$WORKERCTL" sessions --state active | python3 -m json.tool | rg "$RUN_ID|\\[\\]" || true
}
```

- [ ] **Step 7: Wire the new commands in `case`**

Replace the `case` block with:

```bash
case "${1:-}" in
  reset) cmd_reset ;;
  new-run) cmd_new_run ;;
  start) cmd_start ;;
  dashboard) cmd_dashboard ;;
  cycle) cmd_cycle ;;
  status) cmd_status ;;
  cleanup) cmd_cleanup ;;
  -h|--help|"") usage ;;
  *)
    echo "Unknown command: $1" >&2
    usage >&2
    exit 1
    ;;
esac
```

- [ ] **Step 8: Verify dry syntax and non-mutating commands**

Run:

```bash
cd /Users/neonwatty/Desktop/workerctl-dispatch-lab
bash -n ./lab
./lab --help
./lab reset
./lab new-run
./lab status
```

Expected:

```text
Usage: ./lab <command>
Reset to failing baseline.
Created run metadata: .lab/run.env
Useful commands:
```

- [ ] **Step 9: Verify `start` dry-run command shape without starting sessions**

Run this from the lab repo:

```bash
source .lab/run.env
/Users/neonwatty/Desktop/codex-terminal-manager/scripts/workerctl pair \
  --task "$TASK" \
  --worker-name "$WORKER" \
  --manager-name "$MANAGER" \
  --cwd "$PWD" \
  --codex-profile yolo \
  --manager-mode strict \
  --task-goal "Fix the failing pytest in the workerctl Dispatch lab." \
  --task-summary "Real manager/worker Dispatch QA loop in a resettable lab repo." \
  --task-prompt "You are the worker for a resettable Dispatch QA lab. Inspect the failing pytest, make the smallest code change so python3 -m pytest -q passes, run the test, then report completion with the commands and evidence you used." \
  --manager-objective "Verify the worker fixed the failing pytest in the lab repo with evidence." \
  --manager-acceptance "python3 -m pytest -q passes in the lab repo." \
  --manager-acceptance "git diff shows only the minimal calculator fix unless the worker explains otherwise." \
  --dry-run \
  --json | python3 -m json.tool
```

Expected JSON contains:

```text
"ensure_dispatch": true
"dispatch_command"
"--watch"
"dispatch-pair"
```

- [ ] **Step 10: Commit real loop commands**

Run:

```bash
cd /Users/neonwatty/Desktop/workerctl-dispatch-lab
git add lab README.md
git commit -m "Add real workerctl loop commands"
```

Expected:

```text
[main <sha>] Add real workerctl loop commands
```

---

### Task 4: Run One Lab Smoke Without Worker Edits

**Files:**
- No planned file changes.

- [ ] **Step 1: Reset and create a new run**

Run:

```bash
cd /Users/neonwatty/Desktop/workerctl-dispatch-lab
./lab reset
./lab new-run
./lab status
python3 -m pytest -q
```

Expected:

```text
Reset to failing baseline.
FAILED tests/test_calculator.py::test_adds_two_numbers
```

- [ ] **Step 2: Start the real pair**

Run:

```bash
cd /Users/neonwatty/Desktop/workerctl-dispatch-lab
./lab start
```

Expected:

```text
Dashboard: http://127.0.0.1:8797/?task=dispatch-lab-
```

This command will start real tmux/Codex sessions. If Codex startup fails, run:

```bash
/Users/neonwatty/Desktop/codex-terminal-manager/scripts/workerctl doctor
/Users/neonwatty/Desktop/codex-terminal-manager/scripts/workerctl sessions --state active
```

- [ ] **Step 3: Start the dashboard**

Run in a separate terminal or background session:

```bash
cd /Users/neonwatty/Desktop/workerctl-dispatch-lab
./lab dashboard
```

Expected:

```text
dashboard
tsx dashboard/server/index.ts
```

- [ ] **Step 4: Confirm dashboard API sees Dispatch**

Run:

```bash
source /Users/neonwatty/Desktop/workerctl-dispatch-lab/.lab/run.env
curl -fsS "http://127.0.0.1:8797/api/observation" \
  | python3 -c 'import json,sys; o=json.load(sys.stdin); h=o["dispatch"]["health"]; print(h["core_status"], h["heartbeat"].get("dispatcher_id"))'
```

Expected:

```text
active qa-dispatch-dashboard
```

- [ ] **Step 5: Run one manager cycle**

Run:

```bash
cd /Users/neonwatty/Desktop/workerctl-dispatch-lab
./lab cycle
```

Expected:

```text
manager_context
```

or JSON/text output showing a cycle for the active lab task.

- [ ] **Step 6: Cleanup the smoke run**

Run:

```bash
cd /Users/neonwatty/Desktop/workerctl-dispatch-lab
./lab cleanup
./lab reset
```

Expected:

```text
Reset to failing baseline.
```

---

### Task 5: Manual Chrome QA Pass

**Files:**
- No planned file changes unless the QA pass finds a bug.

- [ ] **Step 1: Reset and start a fresh run**

Run:

```bash
cd /Users/neonwatty/Desktop/workerctl-dispatch-lab
./lab reset
./lab start
```

Expected:

```text
Dashboard: http://127.0.0.1:8797/?task=dispatch-lab-
```

- [ ] **Step 2: Start dashboard**

Run:

```bash
cd /Users/neonwatty/Desktop/workerctl-dispatch-lab
./lab dashboard
```

Expected:

```text
Dispatch is active in the dashboard after page load.
```

- [ ] **Step 3: Open the dashboard in Chrome**

Use the Codex Chrome Extension to open the `DASHBOARD_URL` from `.lab/run.env`.

Expected visible state:

```text
Terminal A and Terminal B show the current lab worker/manager or clean shell state.
Dispatch banner is active.
Heartbeat shows qa-dispatch-dashboard, age, iteration, processed count, live.
```

- [ ] **Step 4: Drive the loop**

Run:

```bash
cd /Users/neonwatty/Desktop/workerctl-dispatch-lab
./lab cycle
```

Then use the dashboard terminals or attached tmux sessions to let the worker fix the test. The expected worker edit is:

```python
def add(left: int, right: int) -> int:
    """Return the sum of two integers."""
    return left + right
```

Expected verification command:

```bash
python3 -m pytest -q
```

Expected output:

```text
1 passed
```

- [ ] **Step 5: Confirm Dispatch conversation evidence**

Run:

```bash
cd /Users/neonwatty/Desktop/workerctl-dispatch-lab
./lab cycle
```

Expected dashboard evidence after refresh:

```text
Dispatch conversation lane includes routed notification and manager cycle evidence.
Dispatch remains active.
No stale/not observed warning appears.
```

- [ ] **Step 6: Cleanup and reset**

Run:

```bash
cd /Users/neonwatty/Desktop/workerctl-dispatch-lab
./lab cleanup
./lab reset
python3 -m pytest -q
```

Expected:

```text
FAILED tests/test_calculator.py::test_adds_two_numbers
```

---

### Task 6: Publish the Product-Repo Support Branch

**Files:**
- No planned file changes.

- [ ] **Step 1: Verify current product repo branch**

Run:

```bash
cd /Users/neonwatty/Desktop/codex-terminal-manager
git status --short --branch
git log --oneline -5
```

Expected:

```text
## codex/dashboard-hide-gone-registrations
<sha> Plan dispatch loop lab
<sha> Design resettable dispatch loop lab
<sha> Hide gone dashboard terminal registrations
```

- [ ] **Step 2: Run final product checks**

Run:

```bash
npm test -- --runInBand
npm run build
git diff --check
```

Expected:

```text
31 dashboard tests pass
vite build succeeds
git diff --check exits 0
```

- [ ] **Step 3: Push the support branch**

Run:

```bash
git push -u origin codex/dashboard-hide-gone-registrations
```

Expected:

```text
branch 'codex/dashboard-hide-gone-registrations' set up to track
```

- [ ] **Step 4: Open a PR**

Run:

```bash
gh pr create \
  --base main \
  --head codex/dashboard-hide-gone-registrations \
  --title "Hide stale dashboard terminal registrations and design Dispatch lab" \
  --body "## Summary
- hide gone dashboard terminal registrations from live terminal state
- add a resettable Dispatch loop lab design and implementation plan

## Verification
- npm test -- --runInBand
- npm run build
- git diff --check"
```

Expected:

```text
https://github.com/neonwatty/codex-terminal-manager/pull/<number>
```

---

### Task 7: Final Lab Receipt

**Files:**
- Modify: `/Users/neonwatty/Desktop/workerctl-dispatch-lab/README.md`

- [ ] **Step 1: Add receipt section after first successful manual QA**

After the first successful end-to-end lab run, append this section to
`/Users/neonwatty/Desktop/workerctl-dispatch-lab/README.md`:

```markdown
## First Successful Run

- Date:
- Run id:
- Dashboard URL:
- Worker:
- Manager:
- Evidence:
  - `python3 -m pytest -q` passed after worker edit.
  - Dashboard Dispatch banner showed active.
  - Dashboard Dispatch conversation lane showed routed notification and manager cycle evidence.
- Cleanup:
  - `./lab cleanup` completed.
  - `./lab reset` restored the failing baseline.
```

Fill in the date, run id, worker, manager, and any concrete evidence paths from
the run.

- [ ] **Step 2: Commit receipt**

Run:

```bash
cd /Users/neonwatty/Desktop/workerctl-dispatch-lab
git add README.md
git commit -m "Record first dispatch lab run"
```

Expected:

```text
[main <sha>] Record first dispatch lab run
```
