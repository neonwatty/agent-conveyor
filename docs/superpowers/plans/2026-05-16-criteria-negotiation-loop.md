# Criteria Negotiation Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add advisory criteria negotiation guidance to `workerctl cycle` so managers know when to ask workers for emergent acceptance criteria.

**Architecture:** Extend `workerctl/supervise_cycle.py` with a pure helper that derives `criteria_negotiation` from existing acceptance-criteria context. Include the result in `manager_context` and persisted `manager_cycles.status_json`. Update manager prompt/docs/QA plan to teach managers to inspect the new field; do not add commands, mutations, transcript parsing, or schema changes.

**Tech Stack:** Python standard library, SQLite, `unittest`, existing `workerctl` CLI and docs patterns.

---

## Files

- Modify: `workerctl/supervise_cycle.py`
  - Add `CRITERIA_NEGOTIATION_PROMPT`.
  - Add `_criteria_negotiation_context(task_name, criteria_context)`.
  - Include `criteria_negotiation` in `manager_context`.
- Modify: `tests/test_workerctl.py`
  - Add cycle tests for no criteria, only deferred/rejected criteria, and active criteria.
  - Extend existing prompt/doc/QA-plan tests.
- Modify: `workerctl/commands.py`
  - Update `manager_bootstrap_prompt`.
  - Update `qa-plan emergent-criteria` expected observations and steps.
- Modify: `README.md`
  - Document `manager_context.criteria_negotiation`.
- Modify: `skills/manage-codex-workers/SKILL.md`
  - Tell managers to inspect and use `criteria_negotiation`.

## Task 1: Add Cycle Recommendation Tests

**Files:**
- Modify: `tests/test_workerctl.py`

- [ ] **Step 1: Add no-criteria test**

Add this test to `SuperviseCycleCriteriaTests` after `test_run_cycle_groups_acceptance_criteria_in_manager_context`:

```python
    def test_run_cycle_recommends_criteria_negotiation_when_no_criteria_exist(self):
        from workerctl import supervise_cycle

        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)
            self._setup_bound_task(conn, tmpdir)

            result = supervise_cycle.run_cycle(
                conn,
                task_name="criteria-cycle",
                now="2026-05-15T14:32:15Z",
            )

            negotiation = result["manager_context"]["criteria_negotiation"]
            self.assertTrue(negotiation["needed"])
            self.assertEqual(negotiation["reason"], "no_criteria")
            self.assertIn("must-have current-task criteria", negotiation["prompt"])
            self.assertIn("follow-up criteria", negotiation["prompt"])
            self.assertTrue(any("workerctl criteria criteria-cycle --add" in action for action in negotiation["suggested_actions"]))

            row = conn.execute(
                "select status_json from manager_cycles where id = ?",
                (result["cycle_id"],),
            ).fetchone()
            persisted = json.loads(row["status_json"])
            self.assertEqual(
                persisted["manager_context"]["criteria_negotiation"],
                negotiation,
            )
```

- [ ] **Step 2: Add only deferred/rejected test**

Add:

```python
    def test_run_cycle_recommends_criteria_negotiation_when_only_non_current_criteria_exist(self):
        from workerctl import supervise_cycle

        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)
            self._setup_bound_task(conn, tmpdir)
            for status in ["deferred", "rejected"]:
                worker_db.insert_acceptance_criterion(
                    conn,
                    task_id="task-criteria-cycle",
                    criterion=f"{status} criterion",
                    status=status,
                    source="manager_inferred",
                )
            conn.commit()

            result = supervise_cycle.run_cycle(
                conn,
                task_name="criteria-cycle",
                now="2026-05-15T14:32:15Z",
            )

            negotiation = result["manager_context"]["criteria_negotiation"]
            self.assertTrue(negotiation["needed"])
            self.assertEqual(negotiation["reason"], "no_current_task_criteria")
```

- [ ] **Step 3: Add active criteria test**

Add:

```python
    def test_run_cycle_does_not_recommend_criteria_negotiation_when_active_criteria_exist(self):
        from workerctl import supervise_cycle

        for active_status in ["proposed", "accepted", "satisfied"]:
            with self.subTest(active_status=active_status):
                with tempfile.TemporaryDirectory() as tmpdir:
                    conn = self.open_db(tmpdir)
                    self._setup_bound_task(conn, tmpdir)
                    worker_db.insert_acceptance_criterion(
                        conn,
                        task_id="task-criteria-cycle",
                        criterion=f"{active_status} criterion",
                        status=active_status,
                        source="manager_inferred",
                    )
                    conn.commit()

                    result = supervise_cycle.run_cycle(
                        conn,
                        task_name="criteria-cycle",
                        now="2026-05-15T14:32:15Z",
                    )

                    negotiation = result["manager_context"]["criteria_negotiation"]
                    self.assertFalse(negotiation["needed"])
                    self.assertEqual(negotiation["reason"], "active_criteria_present")
                    self.assertEqual(negotiation["prompt"], None)
```

- [ ] **Step 4: Run tests and verify failure**

Run:

```bash
python3 -m unittest tests.test_workerctl.SuperviseCycleCriteriaTests -v
```

Expected before implementation:

- New tests fail with missing `criteria_negotiation`.

## Task 2: Implement Criteria Negotiation Context

**Files:**
- Modify: `workerctl/supervise_cycle.py`

- [ ] **Step 1: Add prompt constant**

Near `ACCEPTANCE_CRITERION_STATUSES`, add:

```python
CRITERIA_NEGOTIATION_PROMPT = (
    "Please propose 2-4 acceptance criteria for the current slice. "
    "Split them into must-have current-task criteria and follow-up criteria. "
    "Include the verification you expect for each."
)
```

- [ ] **Step 2: Add helper**

Below `_acceptance_criteria_context`, add:

```python
def _criteria_negotiation_context(
    *,
    task_name: str,
    criteria_context: dict[str, Any],
) -> dict[str, Any]:
    summary = criteria_context["summary"]
    active_count = summary["proposed"] + summary["accepted"] + summary["satisfied"]
    total_count = sum(summary.values())
    if total_count == 0:
        needed = True
        reason = "no_criteria"
    elif active_count == 0:
        needed = True
        reason = "no_current_task_criteria"
    else:
        return {
            "needed": False,
            "reason": "active_criteria_present",
            "prompt": None,
            "suggested_actions": [],
        }

    return {
        "needed": needed,
        "reason": reason,
        "prompt": CRITERIA_NEGOTIATION_PROMPT,
        "suggested_actions": [
            "Ask the worker to split must-have current-task criteria from follow-up criteria.",
            f"Record current-task criteria with workerctl criteria {task_name} --add --criterion \"...\" --source worker_proposed --status accepted or proposed.",
            f"Record follow-up criteria with workerctl criteria {task_name} --add --criterion \"...\" --source worker_proposed --status deferred.",
        ],
    }
```

- [ ] **Step 3: Include field in manager_context**

Replace:

```python
    manager_context = {
        "manager_config": worker_db.manager_config(conn, task_id=binding["task_id"]),
        "worker_handoff": worker_db.latest_worker_handoff(conn, task_id=binding["task_id"]),
        "acceptance_criteria": _acceptance_criteria_context(conn, task_id=binding["task_id"]),
    }
```

With:

```python
    criteria_context = _acceptance_criteria_context(conn, task_id=binding["task_id"])
    manager_context = {
        "manager_config": worker_db.manager_config(conn, task_id=binding["task_id"]),
        "worker_handoff": worker_db.latest_worker_handoff(conn, task_id=binding["task_id"]),
        "acceptance_criteria": criteria_context,
        "criteria_negotiation": _criteria_negotiation_context(
            task_name=task_name,
            criteria_context=criteria_context,
        ),
    }
```

- [ ] **Step 4: Run focused cycle tests**

Run:

```bash
python3 -m unittest tests.test_workerctl.SuperviseCycleCriteriaTests -v
```

Expected:

- All `SuperviseCycleCriteriaTests` pass.

## Task 3: Update Manager Prompt, QA Plan, And Docs

**Files:**
- Modify: `workerctl/commands.py`
- Modify: `README.md`
- Modify: `skills/manage-codex-workers/SKILL.md`
- Modify: `tests/test_workerctl.py`

- [ ] **Step 1: Update prompt test**

In `ManagerBootstrapPromptTests.test_prompt_includes_living_criteria_guidance_and_runnable_examples`, add:

```python
        self.assertIn("manager_context.criteria_negotiation", prompt)
        self.assertIn("use its prompt when needed is true", prompt)
```

- [ ] **Step 2: Update docs test**

In `test_docs_include_criteria_context_and_capture_id_examples`, inside the `for document in (readme, skill)` loop, add:

```python
            self.assertIn("manager_context.criteria_negotiation", document)
            self.assertIn('"criteria_negotiation"', document)
```

- [ ] **Step 3: Update QA plan test**

In `test_qa_plan_emergent_criteria_outputs_criteria_flow`, add assertions:

```python
        self.assertTrue(any("manager_context.criteria_negotiation" in step for step in payload["steps"]))
        self.assertTrue(
            any("criteria_negotiation.needed starts true" in observation
                for observation in payload["expected_observations"])
        )
```

- [ ] **Step 4: Run tests and verify failure**

Run:

```bash
python3 -m unittest tests.test_workerctl.ManagerBootstrapPromptTests tests.test_workerctl.CliTests.test_qa_plan_emergent_criteria_outputs_criteria_flow -v
```

Expected before docs/prompt implementation:

- Tests fail because the new strings are absent.

- [ ] **Step 5: Update manager bootstrap prompt**

In `workerctl/commands.py`, update the supervision loop bullets to include:

```text
- Inspect `manager_context.criteria_negotiation`; when `needed` is true, use its prompt to ask the worker for must-have current-task criteria versus follow-up criteria.
```

- [ ] **Step 6: Update emergent QA plan**

In `command_qa_plan`, add expected observation:

```python
"criteria_negotiation.needed starts true before active current-task criteria exist and turns false after proposed, accepted, or satisfied criteria exist",
```

Add steps near the first cycle and post-recording cycle:

```python
"Verify manager_context.criteria_negotiation.needed is true and reason is no_criteria on the first cycle.",
"Run workerctl cycle qa-emergent-criteria again and verify criteria_negotiation.needed is false after active criteria exist.",
```

- [ ] **Step 7: Update README**

In the `cycle` output JSON example, add:

```json
"criteria_negotiation": {
  "needed": true,
  "reason": "no_criteria",
  "prompt": "Please propose 2-4 acceptance criteria for the current slice...",
  "suggested_actions": [...]
}
```

Below the cycle output explanation, add:

```markdown
`manager_context.criteria_negotiation` is advisory. When `needed` is true, the
manager should ask the worker for must-have current-task criteria versus
follow-up criteria, then record the result with `workerctl criteria`. The field
does not send nudges or mutate criteria automatically.
```

- [ ] **Step 8: Update skill docs**

In `skills/manage-codex-workers/SKILL.md`, add the same JSON field to the sample cycle output and add guidance:

```markdown
Inspect `manager_context.criteria_negotiation` every cycle. When `needed` is
true, use its `prompt` as the worker nudge or adapt it to the situation before
recording criteria.
```

- [ ] **Step 9: Run focused docs/prompt tests**

Run:

```bash
python3 -m unittest tests.test_workerctl.ManagerBootstrapPromptTests tests.test_workerctl.CliTests.test_qa_plan_emergent_criteria_outputs_criteria_flow -v
```

Expected:

- Tests pass.

## Task 4: Full Verification And Review

**Files:**
- All modified files.

- [ ] **Step 1: Run targeted tests**

Run:

```bash
python3 -m unittest tests.test_workerctl.SuperviseCycleCriteriaTests tests.test_workerctl.ManagerBootstrapPromptTests tests.test_workerctl.CliTests.test_qa_plan_emergent_criteria_outputs_criteria_flow -v
```

Expected:

- Tests pass.

- [ ] **Step 2: Run full suite and checks**

Run:

```bash
python3 -m unittest tests.test_workerctl -v
python3 -m py_compile workerctl/*.py
git diff --check
```

Expected:

- All commands exit 0. ResourceWarnings may appear from pre-existing connection handling, but they must not fail the suite.

- [ ] **Step 3: Commit**

Run:

```bash
git add workerctl/supervise_cycle.py workerctl/commands.py tests/test_workerctl.py README.md skills/manage-codex-workers/SKILL.md docs/superpowers/plans/2026-05-16-criteria-negotiation-loop.md
git commit -m "Add criteria negotiation cycle guidance"
```

- [ ] **Step 4: Review and PR**

Run:

```bash
~/.codex/skills/codex-review/scripts/codex-review --full-access
git push -u origin feature/criteria-negotiation-loop
gh pr create --title "Add criteria negotiation cycle guidance" --body "$(cat <<'EOF'
## Summary
- Add advisory `manager_context.criteria_negotiation` to cycle output.
- Recommend criteria negotiation when no active current-task criteria exist.
- Document manager usage and update emergent-criteria QA coverage.

## Test Plan
- [ ] `python3 -m unittest tests.test_workerctl.SuperviseCycleCriteriaTests tests.test_workerctl.ManagerBootstrapPromptTests tests.test_workerctl.CliTests.test_qa_plan_emergent_criteria_outputs_criteria_flow -v`
- [ ] `python3 -m unittest tests.test_workerctl -v`
- [ ] `python3 -m py_compile workerctl/*.py`
- [ ] `git diff --check`
EOF
)"
```

If review reports actionable findings, fix them, rerun relevant tests, rerun review, and update the PR.

## Self-Review

- Spec coverage: cycle context, docs, QA plan, and tests are covered.
- Placeholder scan: no placeholders or TBDs remain.
- Type consistency: helper consumes the existing criteria context shape and returns JSON-serializable values.
- Scope: no new command, no schema migration, no automatic nudges, and no transcript inference.
