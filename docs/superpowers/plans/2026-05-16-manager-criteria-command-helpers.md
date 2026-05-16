# Manager Criteria Command Helpers

## Goal

Make emergent acceptance criteria less manual for a manager session.

When `workerctl cycle <task>` reports `manager_context.criteria_negotiation.needed`,
the manager should be able to ask the worker for criteria, then turn the
worker's response into a small reviewed set of `workerctl criteria ... --add`
commands for accepted current-task criteria and deferred follow-up criteria.

This should preserve the manager's judgment. The helper drafts commands; it does
not automatically mutate task criteria unless the operator explicitly runs them.

## Motivation

The current flow works but is hand-assembled:

1. `cycle` detects missing current-task criteria.
2. The manager asks the worker to propose must-have and follow-up criteria.
3. The manager reads the worker response.
4. The manager manually writes one or more `workerctl criteria ... --add`
   commands.

That is exactly where the tool can help: the manager has enough context to make
the acceptance criteria concrete, but command construction is repetitive and
easy to vary across runs.

## Non-Goals

- Do not parse arbitrary transcripts with brittle heuristics in the first pass.
- Do not auto-accept every worker proposal.
- Do not add LLM calls inside `workerctl`.
- Do not change the acceptance criteria database schema.
- Do not replace manager review; the helper should make review easier.

## Proposed CLI

Add a read-only helper:

```bash
workerctl criteria-plan <task> --from-worker-response response.md
workerctl criteria-plan <task> --from-text "..."
workerctl criteria-plan <task> --from-stdin
workerctl criteria-plan <task> --json
```

Output in text mode:

```text
Suggested criteria commands for <task>

Accepted current-task criteria:
1. workerctl criteria <task> --add --criterion "..." --source worker_proposed --status accepted

Deferred follow-up criteria:
1. workerctl criteria <task> --add --criterion "..." --source worker_proposed --status deferred --rationale "Follow-up after this QA slice."

Review these commands before running them.
```

Output in JSON mode:

```json
{
  "task": "task-name",
  "suggestions": [
    {
      "criterion": "README and workerctl help are inspected.",
      "source": "worker_proposed",
      "status": "accepted",
      "rationale": null,
      "command": ["workerctl", "criteria", "task-name", "--add", "--criterion", "...", "--source", "worker_proposed", "--status", "accepted"]
    }
  ],
  "warnings": []
}
```

## Parsing Strategy

Keep the first parser intentionally conservative:

- Prefer headings that include `must-have`, `current-task`, `accepted`, or
  `follow-up` / `deferred`.
- Treat numbered or bulleted lines under current-task headings as `accepted`.
- Treat numbered or bulleted lines under follow-up headings as `deferred`.
- Strip Markdown list markers and surrounding backticks.
- Ignore empty lines, prose paragraphs, and nested explanatory text.
- If no clear headings are found, return no suggestions and a warning asking
  the manager to request separated must-have and follow-up criteria.

This matches the prompt already emitted by `criteria_negotiation.prompt` and the
live QA worker response shape.

## Safety Rules

- Every suggestion must include `source=worker_proposed`.
- Deferred suggestions should include a default rationale:
  `Follow-up after this QA slice.`
- Never emit shell strings only. JSON should include argv arrays so future
  callers can run commands safely without shell escaping bugs.
- Text output may render shell-quoted commands for humans.
- If the task name requires quoting, use the same quoting helper pattern already
  used by `criteria_negotiation.suggested_actions`.
- The command should be read-only; it should not insert criteria.

## Implementation Steps

1. Add a pure parser helper in `workerctl/criteria_plan.py`. ✅
   - Input: raw worker response text.
   - Output: structured accepted/deferred suggestions plus warnings.
2. Add command rendering helpers. ✅
   - `suggestion_to_argv(task, suggestion)`.
   - `suggestion_to_shell(task, suggestion)` using `shlex.quote`.
3. Add `command_criteria_plan` in `workerctl/commands.py`. ✅
   - Resolve task by name/ID to fail early on unknown tasks.
   - Read from `--from-worker-response`, `--from-text`, or `--from-stdin`.
   - Print JSON or reviewed text output.
4. Wire `criteria-plan` into `workerctl/cli.py`. ✅
5. Update manager prompt/docs to mention the helper after a worker proposes
   criteria. ✅
6. Extend `qa-plan emergent-criteria`. ✅
   - Add an optional step: run `criteria-plan` on the worker response, review
     suggestions, then run chosen `workerctl criteria ... --add` commands.
7. Add tests. ✅
   - Parser: must-have and deferred headings.
   - Parser: ambiguous prose returns warning and no suggestions.
   - CLI JSON shape.
   - CLI text output includes reviewed commands and no mutation.
   - QA plan mentions `criteria-plan`.

## Acceptance Criteria

- `workerctl criteria-plan <task> --from-text ... --json` returns deterministic
  suggestions for a worker response with separated must-have and deferred
  sections.
- Ambiguous input produces warnings and no criteria suggestions.
- The helper does not mutate `acceptance_criteria`, `events`, or `commands`.
- Suggested commands use `worker_proposed` and the expected statuses.
- Existing `criteria` mutation flow remains unchanged.
- Focused unit tests and full `python3 -m unittest -v` pass.

## Open Questions

- Should `criteria-plan` optionally read the latest worker `task_complete`
  message from `codex_events` by task, or should v1 require explicit text input?
  The safer v1 is explicit input.
- Should manager-inferred suggestions be supported later? V1 should stay
  `worker_proposed`; manager-inferred criteria are a separate decision.
- Should this become a mutating command with `--apply` later? Only after the
  read-only helper has been dogfooded.
