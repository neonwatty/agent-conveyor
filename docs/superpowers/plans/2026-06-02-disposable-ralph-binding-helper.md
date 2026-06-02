# Disposable Ralph Binding Helper Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a one-command helper that creates a disposable no-tmux manager/worker binding and optional Ralph-loop policy run for real operator slices.

**Architecture:** Keep the helper as CLI orchestration over existing SQLite primitives: create/find task, seed valid Codex rollout metadata JSONL files, register worker and manager sessions with `tmux_session=None`, bind them, and optionally create a template-backed or custom Ralph-loop run. Do not add new Dispatch machinery.

**Tech Stack:** Python standard library, SQLite-backed `workerctl`, existing `unittest` suite, Markdown docs.

---

### Task 1: CLI Helper And Tests

**Files:**
- Modify: `workerctl/cli.py`
- Modify: `workerctl/commands.py`
- Test: `tests/test_workerctl.py`

- [x] **Step 1: Write failing tests**

Add tests that prove `create-disposable-binding --help` is registered and that the command creates a managed task, no-tmux worker/manager sessions, an active binding, valid rollout JSONL files, and a Ralph-loop run when `--required-before-continue adversarial_check` is supplied.

- [x] **Step 2: Run failing tests**

Run:

```bash
python3 -m unittest \
  tests.test_workerctl.CliTests.test_create_disposable_binding_help_is_available \
  tests.test_workerctl.CliTests.test_create_disposable_binding_creates_no_tmux_pair_and_loop_run
```

Expected: fail because the command is not registered.

- [x] **Step 3: Implement command**

Add `command_create_disposable_binding(args)` and register `create-disposable-binding` in `workerctl/cli.py`.

Behavior:
- create the task if it does not exist;
- default worker/manager names from the task name;
- write non-empty rollout JSONL files under `--session-dir` or `<db parent>/disposable-sessions`;
- register worker and manager sessions with `tmux_session=None`;
- bind them to the task;
- when `--template` is provided, create a template-backed run;
- otherwise when `--required-before-continue` is provided, create a custom `purpose=ralph_loop` run;
- print stable JSON with task, sessions, binding, optional run, and replay commands.

- [x] **Step 4: Verify tests pass**

Run the two focused tests and a smoke flow through `enqueue-continue-iteration`, `dispatch`, and `loop-status`.

Receipt:
- Red test: `scripts/run-unittests-isolated -k create_disposable_binding` failed because `create-disposable-binding` was not registered.
- Green test: `scripts/run-unittests-isolated -k create_disposable_binding` passed.
- Disproof smoke: a template-backed `create-disposable-binding smoke-template-loop --template build_then_clear --adversarial` run created worker/manager sessions with `tmux_session=NULL`; `loop-status` showed `required_before_continue=["build_passed","cleanup","adversarial_check"]`.

### Task 2: Docs

**Files:**
- Modify: `README.md`
- Modify: `docs/manual-qa-checklist.md`
- Test: `tests/test_workerctl.py`

- [x] **Step 1: Add docs assertions**

Existing docs assertions already cover the Ralph loop operator guide and `loop-status`; the focused helper tests assert `create-disposable-binding`, `--required-before-continue`, `--adversarial`, and `--template` help output.

- [x] **Step 2: Update docs**

Document the helper as the recommended setup command for real no-tmux Ralph-loop slices.

- [x] **Step 3: Verify docs tests pass**

Run the focused docs tests and final smoke.

Receipt:
- `scripts/run-unittests-isolated -k docs_include_ralph_loop_operator_guide` passed.
- `python3 -m compileall workerctl/commands.py workerctl/cli.py` passed.
- `git diff --check` passed.
