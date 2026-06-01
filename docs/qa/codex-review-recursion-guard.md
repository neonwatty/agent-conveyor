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
