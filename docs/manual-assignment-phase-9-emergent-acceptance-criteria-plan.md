# Phase 9 Emergent Acceptance Criteria Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a lightweight acceptance criteria ledger that lets a manager discover, record, track, and audit emergent acceptance criteria while supervising a worker.

**Architecture:** Keep SQLite as the control plane. Add criteria as task-scoped durable records, expose them through `workerctl criteria`, include them in `cycle` manager context, and make replay/export/final QA show how criteria moved from proposed to accepted, deferred, satisfied, or rejected.

**Tech Stack:** Python standard library, SQLite, argparse CLI, existing `workerctl` command/test patterns, `unittest`, tmux-backed live QA.

---

## Design Target

The manager should be able to ask the worker for reasonable acceptance criteria after progress reveals new details, then save the useful ones as a living task artifact. Criteria are not just static setup strings. They are supervision state.

The ledger should support these statuses:

- `proposed` - candidate criterion from the worker, manager, or user.
- `accepted` - in scope for the current task and not yet proven.
- `satisfied` - backed by a receipt, command, explanation, or verification result.
- `deferred` - valid but out of scope for the current task.
- `rejected` - considered and intentionally excluded.

The ledger should record provenance:

- `user_requested`
- `manager_inferred`
- `worker_proposed`
- `final_audit`

Each criterion should support optional proof metadata:

- `proof` - concise proof requirement or verification command.
- `rationale` - why this criterion matters.
- `evidence` - JSON payload recorded when satisfying, deferring, or rejecting.

## Files

- Modify: `workerctl/db.py` - schema migration, insert/list/update helpers.
- Modify: `workerctl/cli.py` - `criteria` subcommand and flags.
- Modify: `workerctl/commands.py` - command implementation, manager prompt helper text, permission-free audited mutations.
- Modify: `workerctl/supervise_cycle.py` - include criteria summary in `manager_context`.
- Modify: `workerctl/replay.py` - show criteria events in timeline/compact replay.
- Modify: `workerctl/export.py` - include criteria in task export.
- Modify: `tests/test_workerctl.py` - unit and CLI coverage.
- Modify: `README.md` - document emergent acceptance criteria and the new workflow.
- Modify: `skills/manage-codex-workers/SKILL.md` - teach managers to inspect and update criteria during supervision.

## Task 1: SQLite Criteria Ledger

**Files:**
- Modify: `workerctl/db.py`
- Test: `tests/test_workerctl.py`

- [ ] **Step 1: Write failing DB tests**

Add tests that create a task, insert criteria with different statuses/sources, list them by task, update a criterion to `satisfied`, and verify JSON payloads round-trip.

Run:

```bash
python3 -m unittest tests.test_workerctl.AcceptanceCriteriaDbTests -v
```

Expected: fails because helpers and table do not exist.

- [ ] **Step 2: Add schema migration**

Add an `acceptance_criteria` table:

```sql
create table if not exists acceptance_criteria(
  id integer primary key autoincrement,
  task_id text not null references tasks(id),
  criterion text not null,
  status text not null check (status in ('proposed','accepted','satisfied','deferred','rejected')),
  source text not null check (source in ('user_requested','manager_inferred','worker_proposed','final_audit')),
  proof text,
  rationale text,
  evidence_json text not null check (json_valid(evidence_json)),
  created_at text not null,
  updated_at text not null
);
create index if not exists acceptance_criteria_task_status
on acceptance_criteria(task_id, status, id);
```

Increment `SCHEMA_VERSION`, update `REQUIRED_TABLES`, and update `REQUIRED_INDEXES`.

- [ ] **Step 3: Add DB helpers**

Add focused helpers:

```python
def insert_acceptance_criterion(conn, *, task_id, criterion, status, source, proof=None, rationale=None, evidence=None) -> int: ...
def acceptance_criteria_for_task(conn, *, task_id, statuses=None) -> list[dict[str, Any]]: ...
def update_acceptance_criterion(conn, *, criterion_id, status, evidence=None, proof=None, rationale=None) -> dict[str, Any]: ...
```

Validate statuses and sources before writing so CLI errors are clear.

- [ ] **Step 4: Run DB tests**

Run:

```bash
python3 -m unittest tests.test_workerctl.AcceptanceCriteriaDbTests -v
```

Expected: pass.

## Task 2: `workerctl criteria` CLI

**Files:**
- Modify: `workerctl/cli.py`
- Modify: `workerctl/commands.py`
- Test: `tests/test_workerctl.py`

- [ ] **Step 1: Write failing CLI tests**

Cover:

- `criteria <task> --add --criterion ... --source worker_proposed --status proposed`
- `criteria <task> --list`
- `criteria <task> --accept <id>`
- `criteria <task> --satisfy <id> --evidence-json '{"command":"python3 -m unittest"}'`
- invalid status/source errors
- all mutations write an `events` row

Run:

```bash
python3 -m unittest tests.test_workerctl.AcceptanceCriteriaCliTests -v
```

Expected: fails because command is missing.

- [ ] **Step 2: Wire argparse**

Add `criteria` with mutually exclusive actions:

```text
workerctl criteria <task> --list [--status accepted --status proposed]
workerctl criteria <task> --add --criterion TEXT --source SOURCE [--status proposed] [--proof TEXT] [--rationale TEXT] [--evidence-json JSON]
workerctl criteria <task> --accept ID
workerctl criteria <task> --satisfy ID [--evidence-json JSON] [--proof TEXT]
workerctl criteria <task> --defer ID [--evidence-json JSON]
workerctl criteria <task> --reject ID [--evidence-json JSON]
```

- [ ] **Step 3: Implement command behavior**

Return stable JSON:

```json
{
  "task": {"id": "...", "name": "..."},
  "criteria": [],
  "summary": {
    "proposed": 0,
    "accepted": 2,
    "satisfied": 1,
    "deferred": 0,
    "rejected": 0
  }
}
```

For mutations, record `acceptance_criterion_added` or `acceptance_criterion_updated` in `events`.

- [ ] **Step 4: Run CLI tests**

Run:

```bash
python3 -m unittest tests.test_workerctl.AcceptanceCriteriaCliTests -v
```

Expected: pass.

## Task 3: Cycle Context Integration

**Files:**
- Modify: `workerctl/supervise_cycle.py`
- Test: `tests/test_workerctl.py`

- [ ] **Step 1: Write failing cycle test**

Create a task with criteria in all statuses. Run `run_cycle`. Assert `manager_context.acceptance_criteria` includes grouped lists and counts.

Run:

```bash
python3 -m unittest tests.test_workerctl.SuperviseCycleCriteriaTests -v
```

Expected: fails because cycle context omits criteria.

- [ ] **Step 2: Add criteria context**

Extend `manager_context`:

```json
"acceptance_criteria": {
  "summary": {"accepted": 2, "proposed": 1, "satisfied": 0, "deferred": 0, "rejected": 0},
  "open": [],
  "proposed": [],
  "satisfied": [],
  "deferred": [],
  "rejected": []
}
```

Define `open` as accepted criteria that are not satisfied, deferred, or rejected.

- [ ] **Step 3: Run cycle tests**

Run:

```bash
python3 -m unittest tests.test_workerctl.SuperviseCycleCriteriaTests -v
```

Expected: pass.

## Task 4: Manager Prompting And Skill Guidance

**Files:**
- Modify: `workerctl/commands.py`
- Modify: `skills/manage-codex-workers/SKILL.md`
- Modify: `README.md`
- Test: `tests/test_workerctl.py`

- [ ] **Step 1: Add bootstrap prompt assertions**

Extend existing prompt tests to assert the manager is told to inspect acceptance criteria and ask the worker for emergent criteria when the work reveals new scope.

Run:

```bash
python3 -m unittest tests.test_workerctl.ManagerBootstrapPromptTests -v
```

Expected: fails until prompt text changes.

- [ ] **Step 2: Update manager bootstrap**

Add guidance:

```text
- Treat acceptance criteria as living supervision state.
- If worker progress reveals new edge cases, tests, polish, or scope boundaries, ask the worker to propose must-have versus follow-up criteria.
- Record useful criteria with `scripts/workerctl criteria`.
- Before finishing, compare worker receipts and verification against accepted open criteria.
```

- [ ] **Step 3: Update bundled skill**

Add a section after manager loop guidance:

```text
- Inspect `manager_context.acceptance_criteria` every cycle.
- When progress reveals a new requirement, ask the worker:
  "Propose must-have acceptance criteria for the slice you just uncovered.
   Separate current-task criteria from follow-up criteria."
- Record current-task criteria as `accepted` or `proposed`.
- Record follow-up criteria as `deferred`.
- Do not finish while accepted criteria remain open unless the user explicitly
  accepts the gap.
```

- [ ] **Step 4: Update README workflow docs**

Document a short example:

```bash
workerctl criteria my-task --add \
  --criterion "CLI rejects missing task goal with an actionable hint" \
  --source worker_proposed \
  --status accepted \
  --proof "PairCommandTests covers missing --task-goal"
workerctl criteria my-task --satisfy 1 \
  --evidence-json '{"command":"python3 -m unittest tests.test_workerctl.PairCommandTests -v","status":"pass"}'
```

- [ ] **Step 5: Run prompt/doc-focused tests**

Run:

```bash
python3 -m unittest tests.test_workerctl.ManagerBootstrapPromptTests -v
```

Expected: pass.

## Task 5: Replay, Export, And Audit Surface

**Files:**
- Modify: `workerctl/replay.py`
- Modify: `workerctl/export.py`
- Test: `tests/test_workerctl.py`

- [ ] **Step 1: Write failing replay/export tests**

Create a task with criteria mutations. Assert:

- replay includes criterion added/updated timeline entries
- compact replay includes criteria state transitions
- export writes `acceptance-criteria.json`
- manifest includes the new file

Run:

```bash
python3 -m unittest tests.test_workerctl.AcceptanceCriteriaReplayExportTests -v
```

Expected: fails until replay/export read criteria.

- [ ] **Step 2: Add criteria to task audit**

Extend `task_audit` in `workerctl/db.py` to return `acceptance_criteria`.

- [ ] **Step 3: Add replay entries**

Represent criteria mutations from the durable `events` rows. Summaries should be short:

```text
accepted criterion #3: CLI rejects missing task goal with actionable hint
satisfied criterion #3: proof recorded
deferred criterion #5: follow-up polish outside current task
```

- [ ] **Step 4: Add export file**

Write `acceptance-criteria.json` from the audit payload and add it to `manifest.json`.

- [ ] **Step 5: Run replay/export tests**

Run:

```bash
python3 -m unittest tests.test_workerctl.AcceptanceCriteriaReplayExportTests -v
```

Expected: pass.

## Task 6: Final Audit Gate

**Files:**
- Modify: `workerctl/cli.py`
- Modify: `workerctl/commands.py`
- Test: `tests/test_workerctl.py`

- [ ] **Step 1: Write failing finish-task tests**

Cover:

- `finish-task <task> --require-criteria-audit` fails when accepted criteria remain open.
- It succeeds when all accepted criteria are satisfied, deferred, or rejected.
- The failure message lists open criterion ids.
- The success path records final audit metadata in the event payload.

Run:

```bash
python3 -m unittest tests.test_workerctl.CriteriaFinalAuditTests -v
```

Expected: fails until the flag exists.

- [ ] **Step 2: Add finish flag**

Add:

```text
finish-task <task> --require-criteria-audit
```

The flag should not become the default yet. The first release should let us dogfood the behavior before making it stricter.

- [ ] **Step 3: Implement audit check**

Before marking a task done:

- list accepted criteria
- treat `satisfied`, `deferred`, and `rejected` as closed
- fail if any accepted criterion remains open
- include open ids and criterion text in the error
- on success, write final audit payload to `events`

- [ ] **Step 4: Run final audit tests**

Run:

```bash
python3 -m unittest tests.test_workerctl.CriteriaFinalAuditTests -v
```

Expected: pass.

## Task 7: Full Test Pass And Docs Review

**Files:**
- Modify: `README.md`
- Modify: `skills/manage-codex-workers/SKILL.md`
- Test: `tests/test_workerctl.py`

- [ ] **Step 1: Run full unit suite**

Run:

```bash
python3 -m unittest discover -s tests -v
```

Expected: pass.

- [ ] **Step 2: Run compile check**

Run:

```bash
python3 -m py_compile workerctl/*.py
```

Expected: exit 0.

- [ ] **Step 3: Review user-facing docs**

Check that README and skill docs explain:

- why emergent acceptance criteria matter
- how the manager asks the worker for criteria
- how criteria are recorded
- how cycle context shows open criteria
- how final audit uses criteria

## Live QA With Real Worker/Manager Pairs

Run these after the unit suite passes. Use throwaway task names and clean up registrations after each scenario.

### QA 1: Worker-Proposed Criteria From Progressive Disclosure

**Purpose:** Validate that the manager can discover criteria after the worker uncovers new implementation details.

- [ ] Start pair:

```bash
workerctl pair \
  --task qa-emergent-cli \
  --worker-name qa-emergent-cli-worker \
  --manager-name qa-emergent-cli-manager \
  --cwd "$PWD" \
  --task-goal "Make a tiny documented CLI behavior improvement in this repo." \
  --task-prompt "Inspect the CLI help/tests and identify one tiny behavior improvement. Do not edit until instructed."
```

- [ ] In the manager, run `workerctl cycle qa-emergent-cli`.
- [ ] Nudge the worker:

```text
Propose 2-4 acceptance criteria for the smallest useful slice you found.
Separate must-have current-task criteria from follow-up criteria.
```

- [ ] Record at least one must-have criterion as `accepted`.
- [ ] Record at least one follow-up as `deferred`.
- [ ] Let the worker implement the tiny slice.
- [ ] Satisfy the accepted criterion with evidence.
- [ ] Finish with `--require-criteria-audit`.

Pass criteria:

- cycle output includes criteria in `manager_context`
- replay shows criterion add/update events
- final audit blocks if an accepted criterion is left open
- final audit succeeds after satisfaction/defer/reject closes all accepted criteria

### QA 2: Manager-Inferred Criteria From Worker Output

**Purpose:** Validate that criteria can be manager-inferred when the worker does not propose enough proof.

- [ ] Start pair with a task that asks the worker to update docs only.
- [ ] Let the worker make progress.
- [ ] Manager observes that tests or `py_compile` should still be run even though the worker did not mention it.
- [ ] Manager records a criterion with `--source manager_inferred`.
- [ ] Manager nudges worker to satisfy the criterion.
- [ ] Manager records evidence and finishes with criteria audit.

Pass criteria:

- manager-inferred criteria are visible in list/cycle/replay/export
- worker can be steered by a criterion that did not exist at setup
- final audit treats manager-inferred accepted criteria the same as worker-proposed ones

### QA 3: Compaction With Criteria Preserved

**Purpose:** Validate that criteria survive worker context compaction and continue guiding the manager.

- [ ] Start a pair and record accepted criteria.
- [ ] Record a worker handoff.
- [ ] Enable `worker_compact_clear` in manager config.
- [ ] Run `workerctl compact-worker <task> --reason "QA compaction after criteria handoff" --prompt-only`.
- [ ] Run another cycle.

Pass criteria:

- criteria remain in SQLite and cycle context
- worker handoff plus criteria gives enough context to continue
- replay shows handoff, compaction request, and criteria state

### QA 4: Negative Finish Gate

**Purpose:** Confirm the audit gate prevents premature completion.

- [ ] Create a task and pair.
- [ ] Add one accepted criterion.
- [ ] Attempt:

```bash
workerctl finish-task <task> --reason "QA premature finish" --require-criteria-audit
```

Pass criteria:

- command exits non-zero
- stderr names the open criterion id
- task remains active/managed
- after satisfying or deferring the criterion, finish succeeds

## Open Product Questions

- Should accepted criteria be automatically created from `manager-config --acceptance`, or should static setup criteria remain separate from emergent criteria for one release?
- Should `criteria --accept` change `proposed` to `accepted`, or should `--add --status accepted` be the normal path for direct manager judgment?
- Should final audit treat `deferred` accepted criteria as closed by default, or require an explicit evidence payload explaining why deferral is acceptable?
- Should the manager bootstrap always mention criteria, or only when `manager-config.supervision_mode` is `guided` or `strict`?

## Suggested Implementation Order

1. DB ledger and helpers.
2. CLI add/list/update.
3. Cycle context.
4. Prompt and skill guidance.
5. Replay/export.
6. Optional final audit gate.
7. Live QA.

This order gives us value early: once Tasks 1-3 land, manager/worker pairs can start dogfooding emergent acceptance criteria even before replay/export and final audit are polished.
