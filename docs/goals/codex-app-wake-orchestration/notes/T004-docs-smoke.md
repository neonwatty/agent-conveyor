# T004 Worker/QA Receipt

## Result

Done.

## Documentation And Skill Updates

- `README.md` documents `app-wakeup-dispatch`.
- `docs/manager-recipes.md` adds the command to app-native loop recovery and explains the adapter boundary.
- `docs/manual-qa-checklist.md` adds an app wake orchestration drill.
- `skills/manage-codex-workers/SKILL.md` tells managers to use `app-wakeup-dispatch` for auditable prepared/skipped/blocked wake receipts.

## Smoke Coverage

- `scripts/package-smoke` now runs `app-wakeup-dispatch` for a healthy loop and verifies both roles are skipped.
- It also creates a stale app-loop fixture with app thread ids, ages the session heartbeats, runs `app-wakeup-dispatch`, and verifies both roles are `ready_to_send`, missing Dispatch remains required, prompts exist, and a telemetry receipt is returned.

## Skill Install

- `./bin/conveyor install-skills --json` installed the updated `manage-codex-workers` and `codex-review` skills into `/Users/neonwatty/.codex/skills`.

## Evidence

- `scripts/package-smoke` passed after the stale fixture correction.
- `./bin/conveyor install-skills --json` passed and reported `manage-codex-workers` as installed from this repository.

