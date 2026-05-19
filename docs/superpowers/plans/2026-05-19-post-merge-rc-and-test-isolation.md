# Post-Merge RC And Test Isolation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cut a disciplined release candidate from the merged QA branch, then remove the biggest remaining automation fragility: shared test state when suites are run concurrently.

**Architecture:** Keep the release-candidate path sequential and explicit: a small shell wrapper runs the same deterministic gates the README lists, with live smoke as an opt-in expensive gate. Then harden tests by giving each test process its own `.codex-workers` root and namespacing the few real-tmux integration sessions. Keep the existing `unittest` stack and avoid adding new dependencies.

**Tech Stack:** Python standard library, `unittest`, Bash, GitHub Actions, `tmux`, existing `workerctl` scripts.

---

## File Structure

- Create: `scripts/rc-check`
  - Sequential local release-candidate gate runner.
  - Runs unit tests, ResourceWarning output gate, compile, shell syntax checks, and optionally repeat live smoke.
- Modify: `.github/workflows/test.yml`
  - Keep hosted CI deterministic and serial.
  - Optionally switch CI to `scripts/rc-check --skip-live-smoke-repeat` after the wrapper is proven.
- Modify: `README.md`
  - Document the RC check wrapper and when to run the expensive live gate.
- Modify: `docs/live-qa-log.md`
  - Record the post-merge RC result after gates run on `main`.
- Create: `docs/release-candidates/2026-05-19-rc1.md`
  - Human-readable RC evidence receipt.
- Modify: `tests/test_workerctl.py`
  - Add focused tests for the ResourceWarning detector.
  - Add process namespace helpers for tests that touch real tmux sessions.
  - Add tests for new scripts.
- Create: `scripts/run-unittests-isolated`
  - Runs `unittest` with a temporary `WORKERCTL_STATE_ROOT` and `WORKERCTL_TEST_NAMESPACE`.
  - Useful locally when a developer wants to run multiple suites at once.

---

### Task 1: Record The Post-Merge Release Candidate Baseline

**Files:**
- Create: `docs/release-candidates/2026-05-19-rc1.md`
- Modify: `docs/live-qa-log.md`

- [ ] **Step 1: Create the RC evidence file**

Create `docs/release-candidates/2026-05-19-rc1.md`:

```markdown
# Release Candidate 2026-05-19 RC1

Base:

- Branch: `main`
- Source PR: `https://github.com/neonwatty/codex-terminal-manager/pull/76`
- Commit: pending

Required gates:

- [ ] `python3 -m unittest discover -s tests -v`
- [ ] `scripts/check-resource-warnings`
- [ ] `python3 -m py_compile scripts/workerctl scripts/check-resource-warnings workerctl/*.py`
- [ ] `bash -n scripts/live-smoke`
- [ ] `bash -n scripts/live-smoke-repeat`
- [ ] `scripts/live-smoke-repeat 3`
- [ ] `scripts/workerctl sessions --state active`
- [ ] `scripts/workerctl reconcile --stale-cycles-seconds 1`

Results:

- Unit tests:
- ResourceWarning gate:
- Compile:
- Shell syntax:
- Repeat live smoke artifact:
- Active sessions:
- Reconcile:

Decision:

- RC accepted: no
- Notes:
```

- [ ] **Step 2: Fill the current commit**

Run:

```bash
python3 - <<'PY'
from pathlib import Path
import subprocess

path = Path("docs/release-candidates/2026-05-19-rc1.md")
commit = subprocess.check_output(["git", "rev-parse", "--short", "HEAD"], text=True).strip()
text = path.read_text()
text = text.replace("Commit: pending", f"Commit: `{commit}`")
path.write_text(text)
PY
```

Expected:

- The RC file contains the current short commit hash.

- [ ] **Step 3: Run the deterministic gates**

Run sequentially:

```bash
python3 -m unittest discover -s tests -v
scripts/check-resource-warnings
python3 -m py_compile scripts/workerctl scripts/check-resource-warnings workerctl/*.py
bash -n scripts/live-smoke
bash -n scripts/live-smoke-repeat
```

Expected:

- All commands exit `0`.
- Do not run these in parallel; the current full suite still shares tmux and `.codex-workers` state.

- [ ] **Step 4: Run the live RC gate**

Run:

```bash
scripts/live-smoke-repeat 3
scripts/workerctl sessions --state active
scripts/workerctl reconcile --stale-cycles-seconds 1
```

Expected:

- `scripts/live-smoke-repeat 3` exits `0`.
- `sessions --state active` prints `[]` or only explicitly unrelated sessions.
- `reconcile` reports empty `dangling_bindings`, `dead_pid_sessions`, and `stuck_tasks`.

- [ ] **Step 5: Update the RC file and live QA log**

Append a short entry near the top of `docs/live-qa-log.md`:

```markdown
## 2026-05-19: Post-Merge RC1

Decision:

- RC accepted: yes

Evidence:

- Release candidate receipt: `docs/release-candidates/2026-05-19-rc1.md`
- Unit tests, ResourceWarning gate, compile, shell syntax, repeat live smoke,
  active-session cleanup, and reconcile all passed on `main`.
```

Update `docs/release-candidates/2026-05-19-rc1.md` checkboxes and result fields with the actual artifact path.

- [ ] **Step 6: Commit**

Run:

```bash
git add docs/release-candidates/2026-05-19-rc1.md docs/live-qa-log.md docs/live-qa-artifacts/
git commit -m "docs: record rc1 verification"
```

Expected:

- One documentation/evidence commit on `main`.

---

### Task 2: Add A Sequential RC Check Wrapper

**Files:**
- Create: `scripts/rc-check`
- Modify: `README.md`
- Modify: `tests/test_workerctl.py`

- [ ] **Step 1: Add a script syntax test**

In `tests/test_workerctl.py`, add this method to `CliTests` near the existing script syntax tests:

```python
    def test_rc_check_script_has_valid_bash_syntax(self):
        proc = subprocess.run(["bash", "-n", str(ROOT / "scripts" / "rc-check")], text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.assertEqual(proc.returncode, 0, proc.stderr)
```

- [ ] **Step 2: Run the new test and confirm it fails**

Run:

```bash
python3 -m unittest tests.test_workerctl.CliTests.test_rc_check_script_has_valid_bash_syntax -v
```

Expected:

- Fails because `scripts/rc-check` does not exist yet.

- [ ] **Step 3: Create the RC check script**

Create `scripts/rc-check`:

```bash
#!/usr/bin/env bash
set -euo pipefail

RUN_LIVE_SMOKE_REPEAT=0

for arg in "$@"; do
  case "$arg" in
    --with-live-smoke-repeat)
      RUN_LIVE_SMOKE_REPEAT=1
      ;;
    --skip-live-smoke-repeat)
      RUN_LIVE_SMOKE_REPEAT=0
      ;;
    -h|--help)
      cat <<'EOF'
usage: scripts/rc-check [--with-live-smoke-repeat]

Runs the deterministic release-candidate gates sequentially. The repeat live
smoke gate is opt-in because it requires live tmux/codex behavior.
EOF
      exit 0
      ;;
    *)
      echo "rc-check: unknown argument: $arg" >&2
      exit 2
      ;;
  esac
done

echo "== unit tests =="
python3 -m unittest discover -s tests -v

echo "== ResourceWarning output gate =="
scripts/check-resource-warnings

echo "== py_compile =="
python3 -m py_compile scripts/workerctl scripts/check-resource-warnings scripts/rc-check workerctl/*.py

echo "== shell syntax =="
bash -n scripts/live-smoke
bash -n scripts/live-smoke-repeat

if [[ "$RUN_LIVE_SMOKE_REPEAT" == "1" ]]; then
  echo "== repeat live smoke =="
  scripts/live-smoke-repeat 3

  echo "== cleanup checks =="
  scripts/workerctl sessions --state active
  scripts/workerctl reconcile --stale-cycles-seconds 1
else
  echo "== repeat live smoke skipped =="
  echo "run scripts/rc-check --with-live-smoke-repeat for the full local RC gate"
fi
```

Run:

```bash
chmod +x scripts/rc-check
```

- [ ] **Step 4: Run focused verification**

Run:

```bash
bash -n scripts/rc-check
python3 -m unittest tests.test_workerctl.CliTests.test_rc_check_script_has_valid_bash_syntax -v
scripts/rc-check --skip-live-smoke-repeat
```

Expected:

- Bash syntax passes.
- The focused unit test passes.
- `scripts/rc-check --skip-live-smoke-repeat` exits `0`.

- [ ] **Step 5: Document the wrapper**

In `README.md`, update the Tests section so the deterministic gate says:

```markdown
Release-candidate deterministic gate:

```bash
scripts/rc-check --skip-live-smoke-repeat
```

Full local release-candidate gate:

```bash
scripts/rc-check --with-live-smoke-repeat
```
```

- [ ] **Step 6: Commit**

Run:

```bash
git add scripts/rc-check README.md tests/test_workerctl.py
git commit -m "test: add rc check wrapper"
```

---

### Task 3: Add Tests For The ResourceWarning Output Detector

**Files:**
- Modify: `tests/test_workerctl.py`

- [ ] **Step 1: Add detector tests without printing the warning token from successful tests**

Add this class near the other script tests. Do not put the exact warning class name in test method names, because the detector intentionally fails on that token in successful output.

```python
class WarningGateScriptTests(unittest.TestCase):
    def test_warning_gate_passes_clean_command(self):
        proc = subprocess.run(
            [str(ROOT / "scripts" / "check-resource-warnings"), "--", sys.executable, "-c", "print('clean')"],
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("clean", proc.stdout)

    def test_warning_gate_fails_on_finalizer_warning_output(self):
        code = "open('/dev/null')"
        proc = subprocess.run(
            [str(ROOT / "scripts" / "check-resource-warnings"), "--", sys.executable, "-W", "always::ResourceWarning", "-c", code],
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        self.assertEqual(proc.returncode, 1)
        self.assertIn("ResourceWarning detected", proc.stderr)
```

- [ ] **Step 2: Run focused tests**

Run:

```bash
python3 -m unittest tests.test_workerctl.WarningGateScriptTests -v
```

Expected:

- Both tests pass.

- [ ] **Step 3: Run the detector on the full suite**

Run:

```bash
scripts/check-resource-warnings
```

Expected:

- Passes. If the newly added focused tests cause the detector to fail because the exact warning token appears in verbose test names, rename the methods before committing.

- [ ] **Step 4: Commit**

Run:

```bash
git add tests/test_workerctl.py
git commit -m "test: cover resource warning gate"
```

---

### Task 4: Add An Isolated Unittest Runner For Local Parallel Work

**Files:**
- Create: `scripts/run-unittests-isolated`
- Modify: `README.md`
- Modify: `tests/test_workerctl.py`

- [ ] **Step 1: Write a script syntax test**

Add this method to `CliTests`:

```python
    def test_run_unittests_isolated_script_has_valid_bash_syntax(self):
        proc = subprocess.run(["bash", "-n", str(ROOT / "scripts" / "run-unittests-isolated")], text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.assertEqual(proc.returncode, 0, proc.stderr)
```

- [ ] **Step 2: Create the isolated runner**

Create `scripts/run-unittests-isolated`:

```bash
#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/workerctl-test-state.XXXXXX")"
NAMESPACE="iso-$$-$(date +%s)"

cleanup() {
  rm -rf "$STATE_ROOT"
}
trap cleanup EXIT

export WORKERCTL_STATE_ROOT="$STATE_ROOT"
export WORKERCTL_TEST_NAMESPACE="$NAMESPACE"

cd "$ROOT_DIR"
python3 -m unittest discover -s tests -v "$@"
```

Run:

```bash
chmod +x scripts/run-unittests-isolated
```

- [ ] **Step 3: Run focused syntax verification**

Run:

```bash
bash -n scripts/run-unittests-isolated
python3 -m unittest tests.test_workerctl.CliTests.test_run_unittests_isolated_script_has_valid_bash_syntax -v
```

Expected:

- Both pass.

- [ ] **Step 4: Document the runner**

Add this note to `README.md` under Tests:

```markdown
For local parallel experiments, prefer:

```bash
scripts/run-unittests-isolated
```

This gives the process a temporary `WORKERCTL_STATE_ROOT` and a test namespace.
The standard CI job remains serial.
```

- [ ] **Step 5: Commit**

Run:

```bash
git add scripts/run-unittests-isolated README.md tests/test_workerctl.py
git commit -m "test: add isolated unittest runner"
```

---

### Task 5: Namespace Real Tmux Integration Tests

**Files:**
- Modify: `tests/test_workerctl.py`

- [ ] **Step 1: Add a namespace helper**

Near the top of `tests/test_workerctl.py`, below path constants, add:

```python
def namespaced_test_name(base: str) -> str:
    namespace = os.environ.get("WORKERCTL_TEST_NAMESPACE")
    if not namespace:
        return base
    safe = "".join(char if char.isalnum() or char in "-_" else "-" for char in namespace)
    return f"{base}-{safe}"[:64]
```

- [ ] **Step 2: Update the three real-tmux tests**

Change these assignments in `TmuxTests`:

```python
name = "submit-smoke"
```

to:

```python
name = namespaced_test_name("submit-smoke")
```

Change:

```python
name = "open-guard"
```

to:

```python
name = namespaced_test_name("open-guard")
```

Change:

```python
name = "open-attempt-guard"
```

to:

```python
name = namespaced_test_name("open-attempt-guard")
```

- [ ] **Step 3: Add helper coverage**

Add a small test class near `TmuxIntegrationCapabilityTests`:

```python
class TestNameNamespaceTests(unittest.TestCase):
    def test_namespaced_test_name_defaults_to_base(self):
        old = os.environ.pop("WORKERCTL_TEST_NAMESPACE", None)
        self.addCleanup(lambda: os.environ.__setitem__("WORKERCTL_TEST_NAMESPACE", old) if old is not None else os.environ.pop("WORKERCTL_TEST_NAMESPACE", None))
        self.assertEqual(namespaced_test_name("submit-smoke"), "submit-smoke")

    def test_namespaced_test_name_appends_sanitized_namespace(self):
        old = os.environ.get("WORKERCTL_TEST_NAMESPACE")
        os.environ["WORKERCTL_TEST_NAMESPACE"] = "run/one"
        self.addCleanup(lambda: os.environ.__setitem__("WORKERCTL_TEST_NAMESPACE", old) if old is not None else os.environ.pop("WORKERCTL_TEST_NAMESPACE", None))
        self.assertEqual(namespaced_test_name("submit-smoke"), "submit-smoke-run-one")
```

- [ ] **Step 4: Run focused tests**

Run:

```bash
python3 -m unittest tests.test_workerctl.TestNameNamespaceTests tests.test_workerctl.TmuxTests -v
```

Expected:

- Namespace helper tests pass.
- `TmuxTests` pass or the real-tmux methods are skipped for the existing tmux capability reason.

- [ ] **Step 5: Run isolated runner once**

Run:

```bash
scripts/run-unittests-isolated
```

Expected:

- Full suite passes.
- No files are left under the repo-level `.codex-workers` from the isolated run.

- [ ] **Step 6: Commit**

Run:

```bash
git add tests/test_workerctl.py
git commit -m "test: namespace tmux integration tests"
```

---

### Task 6: Decide Whether CI Should Use The RC Wrapper

**Files:**
- Modify: `.github/workflows/test.yml`
- Modify: `README.md`

- [ ] **Step 1: Update CI to use the wrapper**

Change `.github/workflows/test.yml` job steps from separate unit/resource/compile commands to:

```yaml
      - name: Run release-candidate deterministic checks
        run: scripts/rc-check --skip-live-smoke-repeat
```

Keep the checkout and Python version steps unchanged.

- [ ] **Step 2: Update README wording**

Ensure README says:

```markdown
GitHub Actions runs `scripts/rc-check --skip-live-smoke-repeat` on every push
and pull request. The live smoke repeat remains local/manual because hosted
runners may not have `codex`.
```

- [ ] **Step 3: Verify locally**

Run:

```bash
scripts/rc-check --skip-live-smoke-repeat
```

Expected:

- Passes.

- [ ] **Step 4: Commit**

Run:

```bash
git add .github/workflows/test.yml README.md
git commit -m "ci: use rc check wrapper"
```

---

### Task 7: Cut The Release Candidate Tag

**Files:**
- Modify: `docs/release-candidates/2026-05-19-rc1.md`

- [ ] **Step 1: Confirm clean main**

Run:

```bash
git status --short --branch
git rev-parse --abbrev-ref HEAD
```

Expected:

- Branch is `main`.
- Worktree is clean.

- [ ] **Step 2: Run the full RC wrapper**

Run:

```bash
scripts/rc-check --with-live-smoke-repeat
```

Expected:

- All deterministic checks pass.
- Repeat live smoke passes and records an artifact root.

- [ ] **Step 3: Create an annotated RC tag**

Run:

```bash
git tag -a rc-2026-05-19-1 -m "Release candidate 2026-05-19 RC1"
git push origin rc-2026-05-19-1
```

Expected:

- Tag is pushed to GitHub.

- [ ] **Step 4: Record the tag**

Update `docs/release-candidates/2026-05-19-rc1.md`:

```markdown
Tag:

- `rc-2026-05-19-1`
```

- [ ] **Step 5: Commit the receipt update**

Run:

```bash
git add docs/release-candidates/2026-05-19-rc1.md docs/live-qa-log.md docs/live-qa-artifacts/
git commit -m "docs: record rc1 tag"
git push origin main
```

Expected:

- Main contains the RC receipt update.

---

## Self-Review

- Spec coverage: The plan covers the requested “what’s next” path: post-merge RC verification, repeatable local gates, warning-gate confidence, local test isolation, tmux namespace hardening, optional CI consolidation, and an RC tag.
- Placeholder scan: No step uses placeholder markers or “add tests” without concrete commands or code.
- Type and command consistency: Script names are consistent: `scripts/rc-check`, `scripts/check-resource-warnings`, `scripts/run-unittests-isolated`, `scripts/live-smoke-repeat`.
- Scope note: This plan does not add packaging, binary distribution, or version-number management. Those should be a separate release-packaging plan after RC1 is accepted.
