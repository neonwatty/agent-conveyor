# Tmux Integration Test Capability Guard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make real-tmux integration tests skip cleanly when tmux is installed but unusable in the current environment, such as nested Codex review sandboxes that cannot access the tmux socket.

**Architecture:** Keep unit and mocked tmux coverage unchanged. Add a small test helper in `tests/test_workerctl.py` that performs a real tmux smoke check by creating and killing a throwaway session. Use that helper only in `TmuxTests`, the class that directly creates real tmux sessions with `subprocess.run(["tmux", "new-session", ...])`.

**Tech Stack:** Python `unittest`, `subprocess`, `shutil.which`, existing `tests/test_workerctl.py` patterns.

---

## Problem

The PR review sandbox failed three tests with:

```text
error connecting to /private/tmp/tmux-501/default (Operation not permitted)
```

The affected tests are the only tests in `tests/test_workerctl.py` that create real tmux sessions directly:

- `TmuxTests.test_send_text_pastes_and_submits_line`
- `TmuxTests.test_open_refuses_second_window_without_force`
- `TmuxTests.test_open_refuses_after_prior_attempt_without_force`

The current class-level guard only checks whether `tmux` is installed:

```python
@unittest.skipIf(shutil.which("tmux") is None, "tmux is not installed")
class TmuxTests(unittest.TestCase):
```

That is insufficient because `tmux` can be on `PATH` but blocked by sandbox permissions.

## Desired Behavior

- If tmux is missing: skip `TmuxTests`.
- If tmux is installed but cannot create a session: skip `TmuxTests` with the tmux error in the skip reason.
- If tmux is usable: run the same real integration tests as today.
- Do not skip mocked tmux tests such as `SessionTmuxTests`, `SessionActionCliTests`, `StartWorkerTests`, `StartManagerTests`, or pane-signal tests. Those do not need a real tmux server and should continue to run everywhere.

## Files

- Modify: `tests/test_workerctl.py`
  - Add `_tmux_integration_skip_reason()`.
  - Replace the current class-level `@unittest.skipIf(shutil.which("tmux") is None, ...)` guard with a method-scoped skip decorator.
  - Add focused tests for the skip helper and method-scoped skip behavior by mocking `shutil.which` and `subprocess.run`.

## Task 1: Add A Runtime Capability Helper

**Files:**
- Modify: `tests/test_workerctl.py`

- [ ] **Step 1: Add the helper above `TmuxTests`**

Place this helper immediately before `class TmuxTests`:

```python
def _tmux_integration_skip_reason() -> str | None:
    if shutil.which("tmux") is None:
        return "tmux is not installed"

    session = f"workerctl-test-probe-{os.getpid()}"
    try:
        subprocess.run(
            ["tmux", "kill-session", "-t", session],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=2,
        )
        proc = subprocess.run(
            ["tmux", "new-session", "-d", "-s", session, "sleep 1"],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=2,
        )
    except subprocess.TimeoutExpired:
        return "tmux integration unavailable: probe timed out"

    if proc.returncode != 0:
        detail = (proc.stderr or proc.stdout or "tmux new-session failed").strip()
        return f"tmux integration unavailable: {detail}"

    try:
        subprocess.run(
            ["tmux", "kill-session", "-t", session],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=2,
        )
    except subprocess.TimeoutExpired:
        return "tmux integration unavailable: probe timed out"

    return None
```

Why this shape:

- It probes the exact capability the failing tests require: creating a detached tmux session.
- It uses a unique session name based on the current process id.
- It attempts cleanup both before and after the probe.
- It uses short timeouts because this runs at import time; test discovery must not hang before `unittest` can report skips.
- It returns a string compatible with `unittest.skipIf`.

- [ ] **Step 2: Replace the current class decorator with a method-scoped decorator**

Replace:

```python
@unittest.skipIf(shutil.which("tmux") is None, "tmux is not installed")
class TmuxTests(unittest.TestCase):
```

With:

```python
TMUX_INTEGRATION_SKIP_REASON = _tmux_integration_skip_reason()
requires_tmux_integration = unittest.skipIf(TMUX_INTEGRATION_SKIP_REASON, TMUX_INTEGRATION_SKIP_REASON)


class TmuxTests(unittest.TestCase):
    @requires_tmux_integration
    def test_send_text_pastes_and_submits_line(self):
        ...

    @requires_tmux_integration
    def test_open_refuses_second_window_without_force(self):
        ...

    @requires_tmux_integration
    def test_open_refuses_after_prior_attempt_without_force(self):
        ...
```

Do not decorate `test_open_manager_dry_run_resolves_task_manager`; it patches
`commands.run` and does not create a real tmux session.

- [ ] **Step 3: Run the real-tmux class locally**

Run:

```bash
python3 -m unittest tests.test_workerctl.TmuxTests -v
```

Expected on a machine where tmux is usable:

```text
Ran 4 tests
OK
```

Expected in a sandbox where tmux is blocked:

```text
skipped 'tmux integration unavailable: ... Operation not permitted ...'
```

## Task 2: Add Helper Unit Coverage

**Files:**
- Modify: `tests/test_workerctl.py`

- [ ] **Step 1: Add a small test class near `TmuxTests`**

Add this class before `TmuxTests`:

```python
class TmuxIntegrationCapabilityTests(unittest.TestCase):
    def test_tmux_integration_skip_reason_when_tmux_missing(self):
        with mock.patch("tests.test_workerctl.shutil.which", return_value=None):
            self.assertEqual(_tmux_integration_skip_reason(), "tmux is not installed")

    def test_tmux_integration_skip_reason_when_new_session_fails(self):
        calls = []

        def fake_run(cmd, **kwargs):
            calls.append((cmd, kwargs))
            if cmd[:2] == ["tmux", "new-session"]:
                return subprocess.CompletedProcess(cmd, 1, "", "Operation not permitted")
            return subprocess.CompletedProcess(cmd, 0, "", "")

        with mock.patch("tests.test_workerctl.shutil.which", return_value="/usr/bin/tmux"):
            with mock.patch("tests.test_workerctl.subprocess.run", side_effect=fake_run):
                reason = _tmux_integration_skip_reason()

        self.assertEqual(reason, "tmux integration unavailable: Operation not permitted")
        self.assertEqual(calls[0][0][:2], ["tmux", "kill-session"])
        self.assertEqual(calls[0][1]["timeout"], 2)
        self.assertEqual(calls[1][0][:2], ["tmux", "new-session"])
        self.assertEqual(calls[1][1]["timeout"], 2)

    def test_tmux_integration_skip_reason_when_probe_succeeds(self):
        calls = []

        def fake_run(cmd, **kwargs):
            calls.append((cmd, kwargs))
            return subprocess.CompletedProcess(cmd, 0, "", "")

        with mock.patch("tests.test_workerctl.shutil.which", return_value="/usr/bin/tmux"):
            with mock.patch("tests.test_workerctl.subprocess.run", side_effect=fake_run):
                reason = _tmux_integration_skip_reason()

        self.assertIsNone(reason)
        self.assertEqual(calls[0][0][:2], ["tmux", "kill-session"])
        self.assertEqual(calls[1][0][:2], ["tmux", "new-session"])
        self.assertEqual(calls[2][0][:2], ["tmux", "kill-session"])
        self.assertTrue(all(call_kwargs["timeout"] == 2 for _, call_kwargs in calls))

    def test_tmux_integration_skip_reason_when_probe_times_out(self):
        def fake_run(cmd, **kwargs):
            raise subprocess.TimeoutExpired(cmd, kwargs["timeout"])

        with mock.patch("tests.test_workerctl.shutil.which", return_value="/usr/bin/tmux"):
            with mock.patch("tests.test_workerctl.subprocess.run", side_effect=fake_run):
                reason = _tmux_integration_skip_reason()

        self.assertEqual(reason, "tmux integration unavailable: probe timed out")

    def test_real_tmux_skip_is_method_scoped(self):
        self.assertFalse(getattr(TmuxTests, "__unittest_skip__", False))
        self.assertEqual(
            getattr(TmuxTests.test_send_text_pastes_and_submits_line, "__unittest_skip__", False),
            bool(TMUX_INTEGRATION_SKIP_REASON),
        )
        self.assertEqual(
            getattr(TmuxTests.test_open_refuses_second_window_without_force, "__unittest_skip__", False),
            bool(TMUX_INTEGRATION_SKIP_REASON),
        )
        self.assertEqual(
            getattr(TmuxTests.test_open_refuses_after_prior_attempt_without_force, "__unittest_skip__", False),
            bool(TMUX_INTEGRATION_SKIP_REASON),
        )
        self.assertFalse(getattr(TmuxTests.test_open_manager_dry_run_resolves_task_manager, "__unittest_skip__", False))
```

Why add this:

- The helper is evaluated at import time for `TmuxTests`, so direct testing protects the edge cases without requiring a real blocked tmux environment.
- The tests verify missing tmux, blocked tmux, and usable tmux paths.

- [ ] **Step 2: Run the helper tests**

Run:

```bash
python3 -m unittest tests.test_workerctl.TmuxIntegrationCapabilityTests -v
```

Expected:

```text
Ran 5 tests
OK
```

## Task 3: Verify Full Behavior

**Files:**
- Test only.

- [ ] **Step 1: Run targeted tmux tests**

Run:

```bash
python3 -m unittest tests.test_workerctl.TmuxIntegrationCapabilityTests tests.test_workerctl.TmuxTests -v
```

Expected in normal local tmux environment:

```text
Ran 9 tests
OK
```

Expected in restricted environment:

```text
Ran 9 tests
OK (skipped=3)
```

- [ ] **Step 2: Run the full workerctl suite**

Run:

```bash
python3 -m unittest tests.test_workerctl -v
```

Expected:

- Normal local tmux environment: all tests pass.
- Restricted review sandbox: full suite passes with only the three real-session `TmuxTests` methods skipped.

- [ ] **Step 3: Run syntax and whitespace checks**

Run:

```bash
python3 -m py_compile workerctl/*.py
git diff --check
```

Expected:

- Both commands exit 0.

## Task 4: Review And Ship

**Files:**
- Modify: `tests/test_workerctl.py`

- [ ] **Step 1: Commit**

Run:

```bash
git add tests/test_workerctl.py docs/superpowers/plans/2026-05-15-tmux-integration-test-capability-guard.md
git commit -m "Skip tmux integration tests when tmux is unavailable"
```

- [ ] **Step 2: Open PR**

Run:

```bash
git push -u origin feature/tmux-integration-test-guard
gh pr create --title "Skip tmux integration tests when tmux is unavailable" --body "$(cat <<'EOF'
## Summary
- Add a runtime tmux capability probe for real tmux integration tests.
- Skip only `TmuxTests` when tmux is missing or blocked by sandbox permissions.
- Keep mocked tmux/unit coverage running in all environments.

## Test Plan
- [ ] `python3 -m unittest tests.test_workerctl.TmuxIntegrationCapabilityTests tests.test_workerctl.TmuxTests -v`
- [ ] `python3 -m unittest tests.test_workerctl -v`
- [ ] `python3 -m py_compile workerctl/*.py`
- [ ] `git diff --check`
EOF
)"
```

- [ ] **Step 3: Run Codex review**

Run:

```bash
~/.codex/skills/codex-review/scripts/codex-review --full-access
```

Expected:

```text
codex-review clean: no accepted/actionable findings reported
```

If review reports an actionable issue, fix it, rerun the targeted tests, and rerun Codex review.

## Self-Review

- Spec coverage: The plan covers missing tmux, installed-but-blocked tmux, usable tmux, and preserving mocked tmux coverage.
- Placeholder scan: No `TBD`, `TODO`, or unspecified test steps remain.
- Type consistency: The helper returns `str | None`, matching `unittest.skipIf(condition, reason)` usage, and the method-scoped decorator keeps non-real-tmux tests active.
