# T003 Worker Receipt

## Result

Done.

## Implementation

- Extended `create-disposable-binding` heartbeat recommendations with `wakeup_dispatch_command` and `delivery_receipt_commands` for sent/skipped/blocked app wake outcomes.
- Added manager bootstrap prompt guidance to run `app-wakeup-dispatch`, send only `send_ready=true` app-thread wake prompts, treat direct app-thread delivery as non-terminal, and record sent/skipped/blocked outcomes with `app-wakeup-record-delivery`.
- Hardened the worker bootstrap prompt to require exact commands, compact evidence for completion claims, blockers/residual risk, one next recommended worker task, idle receipt, and no heartbeat teardown authority.
- Added unit test assertions so omissions of wake dispatch, delivery receipts, manager send rules, skipped/blocked receipt handling, worker evidence, and heartbeat teardown rules fail.
- Updated README, manager recipe, manual QA checklist, package smoke, and installed skill guidance to point operators at generated bootstrap commands instead of reconstructing them manually.

## Changed Files

- `src/cli/typescript-runtime.ts`
- `src/cli/typescript-runtime.test.ts`
- `scripts/package-smoke`
- `README.md`
- `docs/manager-recipes.md`
- `docs/manual-qa-checklist.md`
- `skills/manage-codex-workers/SKILL.md`
- `docs/goals/codex-app-session-bootstrap-templates/notes/T003-worker.md`
- `docs/goals/codex-app-session-bootstrap-templates/state.yaml`

## Evidence

- `npm test -- --runInBand src/cli/typescript-runtime.test.ts`: passed, 173 tests.
- `npm run build:cli`: passed.
- Direct generated-output proof after rebuild: `./bin/conveyor create-disposable-binding bootstrap-proof ... --json` plus a 20-clause Node assertion passed. It verified role-specific `app-heartbeat`, direct `manager-inbox`/`worker-inbox`, `app-loop-status`, `app-wakeup-dispatch`, sent/skipped/blocked `app-wakeup-record-delivery` templates, `send_ready=true`, "direct app-thread delivery is not task completion", one-next-worker-task discipline, worker inbox, compact evidence for completion claims, and no heartbeat teardown.
- `scripts/package-smoke`: passed, including bootstrap recommendation assertions.
- `./bin/conveyor install-skills --json`: passed and installed `manage-codex-workers` plus `codex-review`.
- `git diff --check`: passed.

## Constraints

- No product code outside the approved files was edited.
- No generated `dist/` files are part of the intended commit.
- No Codex app thread tools were called from terminal package code.
- No app-thread messages were sent.
- No private phone or private thread content was inspected.

## Residual Risk

Low. The main residual risk is operator misuse of the generated templates, but the package output, docs, skill guidance, and smoke test now all point to the same dispatch/receipt flow.
