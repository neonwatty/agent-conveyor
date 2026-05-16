# Criteria Negotiation Loop Design

## Goal

Make `workerctl cycle` tell the manager when it should ask the worker to propose emergent acceptance criteria, without automating the manager's judgment or mutating criteria state.

## Background

The app's motivating workflow is a manager terminal supervising a worker terminal when the work cannot be fully planned up front. As implementation progresses, useful acceptance criteria emerge from discovered edges, scope boundaries, missing tests, and polish gaps. The current app can store, audit, replay, and export those criteria, but the manager has to remember when to initiate the criteria conversation.

The first product step should make that moment explicit in the control plane. `workerctl cycle` already returns `manager_context.acceptance_criteria`; this feature adds an adjacent recommendation that tells the manager whether the current criteria state suggests asking the worker for criteria.

## Design

Add `manager_context.criteria_negotiation` to `workerctl cycle` output.

Example:

```json
{
  "needed": true,
  "reason": "no_current_task_criteria",
  "prompt": "Please propose 2-4 acceptance criteria for the current slice. Split them into must-have current-task criteria and follow-up criteria. Include the verification you expect for each.",
  "suggested_actions": [
    "Ask the worker to split must-have current-task criteria from follow-up criteria.",
    "Record current-task criteria with workerctl criteria <task> --add ... --status accepted or proposed.",
    "Record follow-up criteria as deferred."
  ]
}
```

This field is advisory only. It does not send nudges, add criteria, accept criteria, or infer criteria from transcripts. The manager remains responsible for asking the worker, judging responses, and recording criteria with `workerctl criteria`.

## Rules

The v1 rules are intentionally simple and based only on durable criteria state:

- `needed: true`, `reason: "no_criteria"` when the task has no acceptance criteria.
- `needed: true`, `reason: "no_current_task_criteria"` when all criteria are `deferred` or `rejected`.
- `needed: false`, `reason: "active_criteria_present"` when there is at least one `proposed`, `accepted`, or `satisfied` criterion.

Rationale:

- `proposed` means criteria negotiation has started and the manager should adjudicate, not ask the same broad question again.
- `accepted` means there is an active acceptance surface.
- `satisfied` means the task has had an acceptance surface and proof; a final audit may still inspect state, but a broad criteria prompt is not needed.
- `deferred` and `rejected` do not represent current-task acceptance coverage.

Future versions can use transcript signals, worker state, or elapsed cycles to detect newly emerging scope. This version does not.

## Data Flow

`workerctl/supervise_cycle.py` already builds `manager_context` in `run_cycle`:

1. Resolve active task binding.
2. Ingest worker events.
3. Build `manager_context.acceptance_criteria`.
4. Return cycle JSON and persist the same status JSON in `manager_cycles`.

The new helper should live next to `_acceptance_criteria_context` and consume that existing context:

```python
criteria_context = _acceptance_criteria_context(conn, task_id=binding["task_id"])
criteria_negotiation = _criteria_negotiation_context(task_name=task_name, criteria_context=criteria_context)
```

Then include both fields:

```python
"manager_context": {
    "manager_config": ...,
    "worker_handoff": ...,
    "acceptance_criteria": criteria_context,
    "criteria_negotiation": criteria_negotiation,
}
```

Because `manager_cycles.status_json` persists the full cycle result, replay/debugging automatically retain the recommendation without a schema change.

## Prompt Text

The generated prompt should be ready for a manager to paste into `session-nudge`, but it should not include shell quoting. The manager can decide whether to use it verbatim.

Prompt:

```text
Please propose 2-4 acceptance criteria for the current slice. Split them into must-have current-task criteria and follow-up criteria. Include the verification you expect for each.
```

The suggested actions should reference the actual task name in examples where useful.

## Documentation

Update:

- `README.md`: document `manager_context.criteria_negotiation` in the cycle output section.
- `skills/manage-codex-workers/SKILL.md`: tell managers to inspect `criteria_negotiation` each cycle and use its prompt when `needed` is true.
- `workerctl qa-plan emergent-criteria`: add an expected observation and step that verify the field starts as needed and later turns off after active criteria exist.

## Testing

Add unit coverage in `tests/test_workerctl.py`:

- No criteria: cycle output includes `criteria_negotiation.needed == True` and `reason == "no_criteria"`.
- Only deferred/rejected criteria: `needed == True` and `reason == "no_current_task_criteria"`.
- Proposed/accepted/satisfied criteria: `needed == False` and `reason == "active_criteria_present"`.
- Persisted `manager_cycles.status_json` includes `manager_context.criteria_negotiation`.
- Manager prompt/doc tests include `criteria_negotiation`.
- QA plan test includes the new observation/step.

## Non-Goals

- No new CLI command.
- No automatic `session-nudge`.
- No automatic criteria creation or status changes.
- No transcript parsing or LLM inference.
- No schema migration.

## Self-Review

- Placeholder scan: no placeholders remain.
- Scope check: one bounded feature, contained to cycle context, docs, and tests.
- Ambiguity check: each status maps to one explicit recommendation reason.
- Consistency check: the design keeps the manager as the policy actor and makes the tool provide advisory grounding only.
