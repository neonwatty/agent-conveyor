# T010 Worker Receipt: Dashboard Correlation Grouping Closure

Result: done

Implemented the small T009-recommended closure slice: dashboard correlation-chain grouping already existed, so this task added focused server coverage and corrected README wording.

Changed files:
- `dashboard/server/index.ts`
- `dashboard/server/workerctl.test.ts`
- `README.md`

Behavior/evidence:
- `dispatchChainEntries` is exported for focused unit coverage.
- `dashboard/server/index.ts` now guards `main()` so importing pure helpers in tests does not start the dashboard server.
- `dashboard/server/workerctl.test.ts` verifies dispatch correlation chains are grouped with command state/type, attempts, notification count, manager decision/cycle ids, reverse recency ordering, and side-effect risk.
- README now says dashboard grouping exists for bound-task dispatch chains instead of calling it a follow-up.

Verification:
- `npm test`
  - Result: pass, 17 tests.
- `npm run build`
  - Result: pass.
- `python3 -m unittest tests.test_workerctl.DispatchTests.test_replay_exposes_dispatch_correlation_chain -v`
  - Result: pass.
- `git diff --check`
  - Result: pass.

Follow-up decision:
- No follow-up issue is needed for the correlation-chain grouping itself.
- Richer UI polish, such as browser-level visual coverage or expanded per-attempt details, can be tracked later if desired, but it is not required for this dispatch gap closure.
