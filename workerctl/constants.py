from __future__ import annotations

from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]
INVOCATION_CWD = Path.cwd()
STATE_ROOT = ".codex-workers"
DEFAULT_HISTORY_LINES = 200
DEFAULT_STATUS_STALE_SECONDS = 120
DEFAULT_TERMINAL_STALE_SECONDS = 120
DEFAULT_MANAGER_STALE_SECONDS = 600
DEFAULT_WAIT_READY_SECONDS = 30
DEFAULT_SUPERVISE_COOLDOWN_SECONDS = 300
DEFAULT_BUSY_WAIT_SECONDS = 60
DEFAULT_INTERRUPT_FOLLOWUP = (
    "Please pause and update status.json with what was interrupted, whether you are blocked, "
    "and the next safe action."
)
DEFAULT_STATUS_NUDGE = (
    "Please pause and write a concise status update in your status.json: "
    "current task, what changed, whether you are blocked, and your next action."
)
VALID_STATES = {"planning", "editing", "running_tests", "blocked", "waiting", "done", "unknown"}
