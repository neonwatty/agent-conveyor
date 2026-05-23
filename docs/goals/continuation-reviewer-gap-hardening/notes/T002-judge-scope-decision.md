# T002 Judge Receipt - Scope Decision

## Decision

Approved with consolidation.

## Required In This Tranche

One Worker package should cover all required continuation-reviewer hardening that is already clear from evidence:

1. Fix reviewer automation failure routing so automation failures require operator routing even when the manager config uses `nudge_on_completion="auto-proceed"`.
2. Add deterministic tests for:
   - failed reviewer command with `auto-proceed`;
   - unavailable sandbox engine / setup failure;
   - invalid JSON stdout;
   - timeout;
   - temporary cwd and stripped environment;
   - DB `-wal` and `-shm` sidecar denial.
3. Preserve redaction guarantees for failure output and telemetry.
4. Update docs only if the behavior/guarantee wording changes.

## Broader `.codex-workers` Artifacts

Out of scope for this implementation tranche.

Rationale:

- PR #132 and README deliberately guarantee denial for bound rollout files and workerctl DB, not a deny-by-default filesystem container.
- Issue #130 is closed and substantially satisfied by the targeted boundary.
- Broad `.codex-workers` containment may require a different design because transcripts, captures, task state, and other compatibility artifacts have broader operational semantics.

Required follow-up: PM should create a separate repo issue for "general reviewer containment / broader `.codex-workers` artifact denial" unless Worker discovers that the current patch naturally covers it without extra risk.

## Approved Worker Package

Objective: implement the core hardening and missing QA coverage for continuation-reviewer failure routing and isolation proof.

Allowed files:

- `workerctl/commands.py`
- `tests/test_workerctl.py`
- `README.md`
- `docs/goals/continuation-reviewer-gap-hardening/notes`

Verification:

- `python3 -m unittest tests.test_workerctl.PairCommandTests -v`
- `python3 -m unittest tests.test_workerctl -v`
- `python3 -m py_compile workerctl/*.py`
- `git diff --check`
- `./scripts/rc-check`

Stop if:

- The fix requires unrelated dispatch/dashboard changes.
- A test requires real private rollout, prompt, transcript, DB, or secret content.
- Failure output or telemetry would expose raw stdout/stderr, rollout content, DB content, prompts, transcripts, or secrets.
- Broader filesystem denial is required to make focused tests pass.
- The deterministic no-`sandbox-exec` branch cannot be exercised without unsafe monkeypatching or platform assumptions.

## Superseded Task

T004 is superseded by this consolidated T003 package for cwd/env and DB sidecar proof. Its broader artifact-denial portion is intentionally deferred to PM issue hygiene rather than implemented in this tranche.
