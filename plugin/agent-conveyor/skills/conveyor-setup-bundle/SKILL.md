---
name: conveyor-setup-bundle
description: Draft, preflight, apply, and inspect Agent Conveyor setup bundles for manager-worker operating cells.
---

# Conveyor Setup Bundle

Use this skill when the operator wants to configure a manager/worker pair or
worker set with explicit planning, loop, PR review, what's-next, permissions,
and evidence policy before launch.

## Rules

- Use `.codex-workers/workerctl.db` under the current project unless the
  operator explicitly provides another path.
- Run `conveyor setup-bundle preview` before `apply`.
- If a required backend is missing, stop. Do not create sessions, bindings, or
  work prompts.
- Treat `conveyor setup-bundle show` as the ledger truth for what setup policy
  was approved.

## Commands

```bash
TASK="example-task"
LEDGER="$PWD/.codex-workers/workerctl.db"

conveyor tasks --create "$TASK" \
  --goal "Configure an autonomous manager-worker setup before launch." \
  --path "$LEDGER" \
  --json

conveyor setup-bundle preview "$TASK" \
  --preset autonomous_ship_it \
  --path "$LEDGER" \
  --json

conveyor setup-bundle apply "$TASK" \
  --preset autonomous_ship_it \
  --approve \
  --path "$LEDGER" \
  --json

conveyor setup-bundle show "$TASK" \
  --path "$LEDGER" \
  --json
```

Report the preset, planning backend, loop preset, PR review backend,
what's-next policy, missing required backends, approved hash, and exact next
action.
