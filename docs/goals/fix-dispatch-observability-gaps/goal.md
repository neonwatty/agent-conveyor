# Fix Dispatch Observability Gaps

## Original Request

Use GoalBuddy goal prep to plan the fixes for all gaps found by three independent reviewers while checking how well the current app matches the dispatch addition issue.

## Interpreted Outcome

The app should close the identified dispatch-observability gaps without broadening Dispatch beyond the mechanical role described in issue #113. Operators should see completion-only dispatch chains clearly, mixed dispatch chains should appear in truthful chronological order, suppressed duplicate dispatch races should be visible enough to diagnose, and replay/correlation behavior should be audited against the broader dispatch addition issue.

## Input Shape

specific

## Goal Oracle

A final Judge audit maps every known gap to implementation evidence and passing verification:

- Dashboard visible rows prefer human-meaningful notification or command summaries over opaque correlation ids.
- Mixed command-backed and notification-only dispatch chains sort consistently by event time before dashboard slicing/reversal.
- Duplicate completion-route suppression is represented in an operator-facing dispatch surface or explicitly justified with testable telemetry access.
- Replay/correlation-chain behavior for notification-only completions is reviewed against issue #113 and either fixed in scope or recorded as a deliberate follow-up.
- Focused Python and dashboard tests pass, along with format/check commands appropriate to the changed files.

## Non-Negotiable Constraints

- Preserve Dispatch as mechanical routing/execution only: no task success judgment, criteria decisions, finishing, strategy, merges, or human-operator routing.
- Do not regress existing dispatch command queue behavior, atomic claiming, stale-claim handling, side-effect recording, or direct nudge compatibility.
- Keep changes tightly scoped to the identified gaps.
- Do not overwrite unrelated user changes in the worktree.
- Worker tasks may edit only their explicit `allowed_files`.

## Known Gaps To Fix Or Deliberately Resolve

1. Dashboard client hides the clearer completion-only notification label by rendering `correlation_id || command_id || summary`.
2. Audit/dashboard mixed chain ordering can be misleading because command-backed chains are built before notification-only chains and dashboard mapping slices/reverses the resulting list.
3. `dispatch_signal_suppressed` telemetry is durable but not prominent in the Dispatch panel, so duplicate-route races can be invisible in the primary operator surface.
4. Notification-only replay/correlation chains do not yet connect to a next manager cycle/decision, and replay summaries may be poorly anchored for commandless chains.
5. Dispatch-specific manual QA guidance for the desired issue #113 flow may be missing or too implicit.

## Likely Misfire

The run could pass tests by adding narrow assertions while leaving the operator-facing dashboard still opaque or by treating the broader #113 replay-chain ideal as complete when only PR #136’s narrower observability slice is fixed.

## Completion Standard For This Tranche

The tranche is complete when the highest-confidence local fixes for the known gaps are implemented and verified, and a final audit states whether the broader issue #113 behavior is now fully satisfied or which residual items remain intentionally out of scope.

