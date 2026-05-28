#!/usr/bin/env bash
set -euo pipefail

PRODUCT_ROOT="${PRODUCT_ROOT:-/Users/neonwatty/Desktop/codex-terminal-manager}"
LAB_ROOT="${LAB_ROOT:-/Users/neonwatty/Desktop/workerctl-dispatch-lab}"
GOAL_ROOT="$PRODUCT_ROOT/docs/goals/subscription-billing-dispatch-qa"
PATCH_FILE="$GOAL_ROOT/notes/T009-subscription-billing-lab.patch"
CHECKER="/Users/neonwatty/.codex/plugins/cache/goalbuddy/goalbuddy/0.3.7/skills/goalbuddy/scripts/check-goal-state.mjs"

require_file() {
  local path="$1"
  if [[ ! -e "$path" ]]; then
    echo "Missing required path: $path" >&2
    exit 1
  fi
}

require_clean_repo() {
  local repo="$1"
  local dirty
  dirty="$(git -C "$repo" status --porcelain --untracked-files=all)"
  if [[ -n "$dirty" ]]; then
    echo "Refusing to continue with dirty repo: $repo" >&2
    echo "$dirty" >&2
    exit 1
  fi
}

probe_write() {
  local dir="$1"
  local probe="$dir/.codex-write-probe-$$"
  : > "$probe"
  rm -f "$probe"
}

echo "== Checking inputs =="
require_file "$PATCH_FILE"
require_file "$LAB_ROOT/lab"
require_file "$PRODUCT_ROOT/scripts/workerctl"
require_file "$GOAL_ROOT/state.yaml"

echo "== Checking write access =="
probe_write "$LAB_ROOT"
probe_write "$PRODUCT_ROOT/.git"

echo "== Checking clean repos =="
require_clean_repo "$LAB_ROOT"

echo "== Checking GoalBuddy state =="
node "$CHECKER" "$GOAL_ROOT/state.yaml"

echo "== Applying subscription-billing lab patch =="
cd "$LAB_ROOT"
git apply --recount "$PATCH_FILE"

echo "== Verifying scenario fixture =="
bash -n lab
export UV_CACHE_DIR="${UV_CACHE_DIR:-/tmp/uv-cache-workerctl-dispatch-lab}"
LAB_SCENARIO=subscription-billing ./lab reset --force
set +e
.venv/bin/python -m pytest -q
pytest_status=$?
set -e
if [[ "$pytest_status" -eq 0 ]]; then
  echo "Expected subscription-billing baseline to be red before worker fix, but pytest passed." >&2
  exit 1
fi
echo "Baseline is intentionally red as expected."
git diff --check

cat <<EOF

Subscription-billing fixture is applied and red.

Next dashboard QA commands:
  cd "$LAB_ROOT"
  LAB_SCENARIO=subscription-billing ./lab qa-start
  ./lab cycle

After the worker completes:
  ./lab cycle

Required dashboard evidence:
  - Dispatch core active
  - worker_task_complete delivered
  - source event id visible
  - manager cycle consumed the routed fact
  - finish_task succeeds after consumption
  - task state done
  - accepted criteria satisfied

Cleanup:
  ./lab cleanup
  LAB_SCENARIO=complex-refactor ./lab reset --force

Commit lab scenario after successful dashboard QA:
  git add README.md lab scenarios/subscription-billing
  git commit -m "Add subscription billing dispatch QA scenario"
  git push
EOF
