import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

from workerctl import classify
from workerctl import commands
from workerctl import tmux as worker_tmux
from workerctl.core import WorkerError
from workerctl.state import append_event, config_path, status_path, worker_dir


ROOT = Path(__file__).resolve().parents[1]
WORKERCTL_PATH = ROOT / "scripts" / "workerctl"
WORKERCTL_SHIM_PATH = ROOT / "bin" / "workerctl"
INSTALL_LOCAL_PATH = ROOT / "scripts" / "install-local"


class ClassifierTests(unittest.TestCase):
    def test_startup_detects_trust_prompt(self):
        state, reason = classify.classify_startup_output(
            "Do you trust the contents of this directory?\nPress enter to continue"
        )

        self.assertEqual(state, "needs_trust")
        self.assertIn("trust", reason.lower())

    def test_startup_detects_ready_prompt(self):
        state, reason = classify.classify_startup_output("OpenAI Codex\n\n› Implement {feature}")

        self.assertEqual(state, "ready")
        self.assertIn("input prompt", reason)

    def test_busy_wait_detects_mcp_startup_when_status_is_stale(self):
        result = classify.classify_busy_wait(
            "Starting MCP servers (2/3): posthog (1m 25s esc to interrupt)",
            status_age=120,
            busy_wait_seconds=60,
        )

        self.assertIsNotNone(result)
        self.assertEqual(result["pattern"], "mcp_startup")
        self.assertEqual(result["recommended_action"], "inspect_or_interrupt")

    def test_busy_wait_ignores_mcp_startup_when_status_is_fresh(self):
        result = classify.classify_busy_wait(
            "Starting MCP servers (2/3): posthog",
            status_age=10,
            busy_wait_seconds=60,
        )

        self.assertIsNone(result)

    def test_busy_wait_detects_rate_limit_prompt(self):
        result = classify.classify_busy_wait(
            "Approaching rate limits\nSwitch to gpt-5.4-mini?\nPress enter to confirm",
            status_age=120,
            busy_wait_seconds=60,
        )

        self.assertIsNotNone(result)
        self.assertEqual(result["pattern"], "rate_limit_prompt")

    def test_busy_wait_detects_plan_prompt(self):
        result = classify.classify_busy_wait(
            "Create a plan? shift + tab use Plan mode esc dismiss",
            status_age=120,
            busy_wait_seconds=60,
        )

        self.assertIsNotNone(result)
        self.assertEqual(result["pattern"], "plan_prompt")


class CliTests(unittest.TestCase):
    def run_workerctl(self, *args, via_shim=False):
        command = [str(WORKERCTL_SHIM_PATH), *args] if via_shim else [sys.executable, str(WORKERCTL_PATH), *args]
        return subprocess.run(
            command,
            cwd=ROOT,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )

    def test_classify_cli_outputs_json(self):
        proc = self.run_workerctl(
            "classify",
            "--text",
            "Starting MCP servers (2/3): posthog",
            "--status-age-seconds",
            "120",
        )

        self.assertEqual(proc.returncode, 0, proc.stderr)
        data = json.loads(proc.stdout)
        self.assertEqual(data["busy_wait"]["pattern"], "mcp_startup")

    def test_list_json_outputs_json_array(self):
        proc = self.run_workerctl("list", "--json")

        self.assertEqual(proc.returncode, 0, proc.stderr)
        data = json.loads(proc.stdout)
        self.assertIsInstance(data, list)

    def test_doctor_outputs_expected_structure(self):
        proc = self.run_workerctl("doctor")

        data = json.loads(proc.stdout)
        self.assertIn("checks", data)
        self.assertIn("workers", data)
        self.assertTrue(any(check["name"] == "tmux" for check in data["checks"]))
        self.assertTrue(any(check["name"] == "codex" for check in data["checks"]))

    def test_start_test_is_listed_in_help(self):
        proc = self.run_workerctl("--help")

        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("start-test", proc.stdout)

    def test_create_help_includes_verify_options(self):
        proc = self.run_workerctl("create", "--help")

        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("--verify", proc.stdout)
        self.assertIn("--open", proc.stdout)
        self.assertIn("--stop-after", proc.stdout)

    def test_open_is_listed_in_help(self):
        proc = self.run_workerctl("--help")

        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("open", proc.stdout)

    def test_open_help_mentions_force(self):
        proc = self.run_workerctl("open", "--help")

        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("--force", proc.stdout)

    def test_create_open_stop_after_fails_before_creating_worker(self):
        name = "invalid-combo-test"
        worker_path = worker_dir(name)
        if worker_path.exists():
            shutil.rmtree(worker_path)

        proc = self.run_workerctl(
            "create",
            name,
            "--cwd",
            str(ROOT),
            "--task",
            "x",
            "--open",
            "--stop-after",
        )

        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("--open cannot be combined with --stop-after", proc.stderr)
        self.assertFalse(worker_path.exists())

    def test_bin_shim_invokes_workerctl(self):
        proc = self.run_workerctl(
            "classify",
            "--text",
            "Starting MCP servers (2/3): posthog",
            "--status-age-seconds",
            "120",
            via_shim=True,
        )

        self.assertEqual(proc.returncode, 0, proc.stderr)
        data = json.loads(proc.stdout)
        self.assertEqual(data["busy_wait"]["pattern"], "mcp_startup")

    def test_install_local_prints_path_line(self):
        proc = subprocess.run(
            [str(INSTALL_LOCAL_PATH)],
            cwd=ROOT,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )

        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn(str(ROOT / "bin"), proc.stdout)

    def test_install_local_write_is_idempotent(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            profile = Path(tmpdir) / ".zshrc"
            env = os.environ.copy()
            env["WORKERCTL_INSTALL_PROFILE"] = str(profile)
            for _ in range(2):
                proc = subprocess.run(
                    [str(INSTALL_LOCAL_PATH), "--write"],
                    cwd=ROOT,
                    env=env,
                    text=True,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    check=False,
                )
                self.assertEqual(proc.returncode, 0, proc.stderr)

            profile_text = profile.read_text()
            path_line = f'export PATH="{ROOT / "bin"}:$PATH"'
            self.assertEqual(profile_text.count(path_line), 1)


@unittest.skipIf(shutil.which("tmux") is None, "tmux is not installed")
class TmuxTests(unittest.TestCase):
    def test_send_text_pastes_and_submits_line(self):
        name = "submit-smoke"
        session = f"codex-{name}"
        output_path = Path(tempfile.gettempdir()) / f"workerctl-{name}.txt"
        output_path.unlink(missing_ok=True)
        worker_path = worker_dir(name)
        if worker_path.exists():
            shutil.rmtree(worker_path)
        worker_path.mkdir(parents=True)
        config_path(name).write_text(json.dumps({"name": name, "tmux_session": session}) + "\n")
        status_path(name).write_text(json.dumps({"state": "waiting"}) + "\n")
        subprocess.run(["tmux", "kill-session", "-t", session], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        command = f"IFS= read -r line; printf '%s\\n' \"$line\" > {output_path}; sleep 2"
        subprocess.run(["tmux", "new-session", "-d", "-s", session, command], check=True)
        try:
            time.sleep(0.2)
            worker_tmux.send_text(name, "hello from workerctl")
            deadline = time.time() + 3
            while time.time() < deadline and not output_path.exists():
                time.sleep(0.1)

            self.assertTrue(output_path.exists(), "tmux read loop did not receive submitted text")
            self.assertEqual(output_path.read_text().strip(), "hello from workerctl")
        finally:
            subprocess.run(["tmux", "kill-session", "-t", session], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            if worker_path.exists():
                shutil.rmtree(worker_path)
            output_path.unlink(missing_ok=True)

    def test_open_refuses_second_window_without_force(self):
        name = "open-guard"
        session = f"codex-{name}"
        worker_path = worker_dir(name)
        if worker_path.exists():
            shutil.rmtree(worker_path)
        worker_path.mkdir(parents=True)
        config_path(name).write_text(json.dumps({"name": name, "tmux_session": session}) + "\n")
        status_path(name).write_text(json.dumps({"state": "waiting"}) + "\n")
        append_event(name, "open", {"terminal": "ghostty"})
        subprocess.run(["tmux", "kill-session", "-t", session], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        subprocess.run(["tmux", "new-session", "-d", "-s", session, "sleep 5"], check=True)
        try:
            with self.assertRaises(WorkerError):
                commands.open_worker_window(name, terminal="ghostty", dry_run=True, force=False)

            result = commands.open_worker_window(name, terminal="ghostty", dry_run=True, force=True)
            self.assertTrue(result["dry_run"])
            self.assertTrue(result["force"])
        finally:
            subprocess.run(["tmux", "kill-session", "-t", session], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            if worker_path.exists():
                shutil.rmtree(worker_path)

    def test_open_refuses_after_prior_attempt_without_force(self):
        name = "open-attempt-guard"
        session = f"codex-{name}"
        worker_path = worker_dir(name)
        if worker_path.exists():
            shutil.rmtree(worker_path)
        worker_path.mkdir(parents=True)
        config_path(name).write_text(json.dumps({"name": name, "tmux_session": session}) + "\n")
        status_path(name).write_text(json.dumps({"state": "waiting"}) + "\n")
        append_event(name, "open_attempt", {"terminal": "ghostty"})
        subprocess.run(["tmux", "kill-session", "-t", session], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        subprocess.run(["tmux", "new-session", "-d", "-s", session, "sleep 5"], check=True)
        try:
            with self.assertRaisesRegex(WorkerError, "terminal launch attempted"):
                commands.open_worker_window(name, terminal="ghostty", dry_run=True, force=False)
        finally:
            subprocess.run(["tmux", "kill-session", "-t", session], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            if worker_path.exists():
                shutil.rmtree(worker_path)


if __name__ == "__main__":
    unittest.main()
