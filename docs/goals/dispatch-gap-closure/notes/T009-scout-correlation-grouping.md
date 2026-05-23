# T009 Scout Receipt: Dispatch Correlation Grouping

Result: done

Read-only Scout: Raman (`019e56e8-699e-7482-931c-d4469fac9f79`)

Current visibility:
- `workerctl/db.py` builds correlation chains that link command ids, attempt ids, routed notification ids, manager decision ids, and manager cycle ids.
- `task_audit()` includes commands, command attempts, routed notifications, and correlation chains.
- `workerctl/replay.py` already surfaces dispatch attempts, routed notifications, and correlation-chain entries.
- `dashboard/server/index.ts` already derives dispatch chain entries, joins audit chains to attempt and command metadata, flags side-effect risk, limits to recent chains, and returns `dispatch.chains`.
- `dashboard/client/main.tsx` already renders a Dispatch panel with correlation id, command type/state, cycle, decision, attempt count, and notification count.

Gap:
- README wording is stale because it still says dashboard grouping for dispatch correlation chains is a follow-up.
- Replay/audit correlation behavior has Python coverage, but dashboard chain grouping lacks direct server-side test coverage.

Recommendation:
- Implement now as a small dashboard test/docs slice rather than creating a new follow-up issue.
- Smallest useful slice: export or otherwise unit-test dashboard dispatch chain grouping from `dashboard/server/index.ts`, add a focused test in `dashboard/server/workerctl.test.ts`, and update README to state dashboard grouping exists for bound-task dispatch chains.

Suggested files:
- `dashboard/server/index.ts`
- `dashboard/server/workerctl.test.ts`
- `README.md`

Suggested verification:
- `npm test`
- `npm run build`
- `python3 -m unittest tests.test_workerctl.DispatchTests.test_replay_exposes_dispatch_correlation_chain -v`
- `git diff --check`
