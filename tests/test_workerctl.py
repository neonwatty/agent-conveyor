import importlib.util
import json
import subprocess
import sys
import unittest
from importlib.machinery import SourceFileLoader
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
WORKERCTL_PATH = ROOT / "scripts" / "workerctl"


def load_workerctl():
    loader = SourceFileLoader("workerctl", str(WORKERCTL_PATH))
    spec = importlib.util.spec_from_loader("workerctl", loader)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


class ClassifierTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.workerctl = load_workerctl()

    def test_startup_detects_trust_prompt(self):
        state, reason = self.workerctl.classify_startup_output(
            "Do you trust the contents of this directory?\nPress enter to continue"
        )

        self.assertEqual(state, "needs_trust")
        self.assertIn("trust", reason.lower())

    def test_startup_detects_ready_prompt(self):
        state, reason = self.workerctl.classify_startup_output("OpenAI Codex\n\n› Implement {feature}")

        self.assertEqual(state, "ready")
        self.assertIn("input prompt", reason)

    def test_busy_wait_detects_mcp_startup_when_status_is_stale(self):
        result = self.workerctl.classify_busy_wait(
            "Starting MCP servers (2/3): posthog (1m 25s esc to interrupt)",
            status_age=120,
            busy_wait_seconds=60,
        )

        self.assertIsNotNone(result)
        self.assertEqual(result["pattern"], "mcp_startup")
        self.assertEqual(result["recommended_action"], "inspect_or_interrupt")

    def test_busy_wait_ignores_mcp_startup_when_status_is_fresh(self):
        result = self.workerctl.classify_busy_wait(
            "Starting MCP servers (2/3): posthog",
            status_age=10,
            busy_wait_seconds=60,
        )

        self.assertIsNone(result)

    def test_busy_wait_detects_rate_limit_prompt(self):
        result = self.workerctl.classify_busy_wait(
            "Approaching rate limits\nSwitch to gpt-5.4-mini?\nPress enter to confirm",
            status_age=120,
            busy_wait_seconds=60,
        )

        self.assertIsNotNone(result)
        self.assertEqual(result["pattern"], "rate_limit_prompt")

    def test_busy_wait_detects_plan_prompt(self):
        result = self.workerctl.classify_busy_wait(
            "Create a plan? shift + tab use Plan mode esc dismiss",
            status_age=120,
            busy_wait_seconds=60,
        )

        self.assertIsNotNone(result)
        self.assertEqual(result["pattern"], "plan_prompt")


class CliTests(unittest.TestCase):
    def run_workerctl(self, *args):
        return subprocess.run(
            [sys.executable, str(WORKERCTL_PATH), *args],
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


if __name__ == "__main__":
    unittest.main()
