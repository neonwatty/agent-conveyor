# Codex Review Recursion Guard

Use this smoke after changing the versioned `codex-review` helper. It proves a
fresh local install blocks recursive review helper launches and does not leave
duplicate review processes running.

## Temporary Install

```bash
set -euo pipefail
QA_CODEX_HOME=$(mktemp -d)
WORKERCTL_INSTALL_PROFILE="$QA_CODEX_HOME/.zshrc" \
  CODEX_HOME="$QA_CODEX_HOME" \
  scripts/install-local --write
REVIEW_HELPER="$QA_CODEX_HOME/skills/codex-review/scripts/codex-review"
export QA_CODEX_HOME REVIEW_HELPER
test -x "$REVIEW_HELPER"
cmp -s skills/codex-review/scripts/codex-review "$REVIEW_HELPER"
```

## Stale Install Disproof

```bash
set -euo pipefail
printf '#!/usr/bin/env bash\necho stale-helper\n' >"$REVIEW_HELPER"
chmod +x "$REVIEW_HELPER"
WORKERCTL_INSTALL_PROFILE="$QA_CODEX_HOME/.zshrc" \
  CODEX_HOME="$QA_CODEX_HOME" \
  scripts/install-local --write
! rg "stale-helper" "$REVIEW_HELPER"
cmp -s skills/codex-review/scripts/codex-review "$REVIEW_HELPER"
```

## Baseline

```bash
set -euo pipefail
current_pid=$$
ps -eo pid=,args= | awk -v self="$current_pid" '
  $1 != self && $0 ~ /[c]odex.*review|[c]odex-review/ { print $1 }
' | sort -u >/tmp/codex-review-before.pids
```

## Direct Nested Block

```bash
set -euo pipefail
set +e
CODEX_REVIEW_HELPER_LEVEL=1 \
  "$REVIEW_HELPER" --mode local \
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
set -euo pipefail
cat >/tmp/fake-codex-review-recursive <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
set +e
"$REVIEW_HELPER" --mode local \
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
  "$REVIEW_HELPER" \
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
set -euo pipefail
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

## Cleanup Disproof

```bash
set -euo pipefail
current_pid=$$
ps -eo pid=,args= | awk -v self="$current_pid" '
  $1 != self && $0 ~ /[c]odex.*review|[c]odex-review/ { print $1 }
' | sort -u >/tmp/codex-review-before.pids
(exec -a codex-review-stale sleep 20) &
stale_pid=$!
trap 'kill "$stale_pid" 2>/dev/null || true' EXIT
sleep 0.2
current_pid=$$
ps -eo pid=,args= | awk -v self="$current_pid" '
  $1 != self && $0 ~ /[c]odex.*review|[c]odex-review/ { print $1 }
' | sort -u >/tmp/codex-review-after.pids
comm -13 /tmp/codex-review-before.pids /tmp/codex-review-after.pids \
  >/tmp/codex-review-new.pids
rg "$stale_pid" /tmp/codex-review-new.pids
kill "$stale_pid" 2>/dev/null || true
trap - EXIT
```
