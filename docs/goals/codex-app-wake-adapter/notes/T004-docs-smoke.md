# T004 Worker/QA Receipt

## Result

Done.

## Documentation And Skill Updates

- `README.md` documents `app-wakeup-record-delivery`.
- `docs/manager-recipes.md` describes the app-manager adapter sequence: run `app-wakeup-dispatch`, call `send_message_to_thread` only for `send_ready=true`, then record delivery outcomes.
- `docs/manual-qa-checklist.md` adds an adapter receipt drill.
- `skills/manage-codex-workers/SKILL.md` now gives concrete send/skipped/blocked receipt instructions.

## Smoke Coverage

- `scripts/package-smoke` records a `sent` delivery receipt for a stale send-ready manager wake action.
- `scripts/package-smoke` verifies that attempting `sent` for a healthy skipped manager action fails.

## Evidence

- `scripts/package-smoke` passed.
- `./bin/conveyor install-skills --json` passed and installed the updated `manage-codex-workers` skill.

