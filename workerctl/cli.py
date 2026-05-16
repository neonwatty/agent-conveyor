#!/usr/bin/env python3
"""Control tmux-backed Codex worker sessions."""

from __future__ import annotations

import argparse
import sys
from textwrap import dedent

from workerctl.constants import (
    DEFAULT_HISTORY_LINES,
    DEFAULT_INTERRUPT_FOLLOWUP,
    DEFAULT_MANAGER_STALE_SECONDS,
    DEFAULT_STATUS_STALE_SECONDS,
    DEFAULT_TERMINAL_STALE_SECONDS,
    DEFAULT_WAIT_READY_SECONDS,
    INVOCATION_CWD,
)
from workerctl.shadow_state import DEFAULT_BUSY_WAIT_SECONDS
from workerctl.commands import (
    command_audit,
    command_capture,
    command_classify,
    command_compact_worker,
    command_commands,
    command_create,
    command_criteria,
    command_cycle,
    command_db_doctor,
    command_divergences,
    command_doctor,
    command_doctor_self,
    command_events,
    command_idle_check,
    command_interrupt,
    command_list,
    command_mutation_audit,
    command_nudge,
    command_open,
    command_open_manager,
    command_open_worker,
    command_pair,
    command_prune,
    command_qa_plan,
    command_reconcile,
    command_record_decision,
    command_register_worker,
    command_request_worker_compact,
    command_register_manager,
    command_start_worker,
    command_start_manager,
    command_deregister,
    command_sessions,
    command_bind,
    command_ingest,
    command_unbind,
    command_handoff,
    command_manager_config,
    command_manager_permission,
    command_session_nudge,
    command_session_interrupt,
    command_start,
    command_start_test,
    command_status,
    command_stop,
    command_tail,
    command_tasks,
    command_transcript_capture,
    command_transcript_prune,
    command_transcript_show,
    command_update_status,
)
from workerctl.core import WorkerError
from workerctl.codex_session import CodexSessionError
from workerctl.ingest import IngestError
from workerctl.export import command_export_task
from workerctl.importer import command_import_compat
from workerctl.lifecycle import (
    command_finish_task,
    command_stop_task,
)
from workerctl.replay import command_replay


def add_manager_codex_arg_options(command: argparse.ArgumentParser) -> None:
    command.add_argument(
        "--no-manager-codex-args",
        action="store_true",
        help="Start the manager without the default recommended Codex args. Use only when intentionally overriding manager sandbox/approval behavior.",
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="workerctl",
        description="Control tmux-backed Codex worker sessions.",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    create = subparsers.add_parser("create", help="Create and start a worker Codex tmux session.")
    create.add_argument("name", help="Worker name, e.g. worker-a.")
    create.add_argument("--cwd", default=str(INVOCATION_CWD), help="Working directory for the worker.")
    create.add_argument("--task", help="Initial task text for the worker contract.")
    create.add_argument("--reuse", action="store_true", help="Reuse an existing worker state directory.")
    create.add_argument(
        "--no-initial-prompt",
        action="store_false",
        dest="initial_prompt",
        help="Start Codex but do not provide the worker contract as the initial prompt.",
    )
    create.add_argument(
        "--no-send-contract",
        action="store_false",
        dest="initial_prompt",
        help="Deprecated alias for --no-initial-prompt.",
    )
    create.add_argument(
        "--accept-trust",
        action="store_true",
        help=dedent(
            """\
            Send Enter immediately after launch to accept Codex's workspace trust prompt.
            Use only for directories you intentionally trust.
            """
        ),
    )
    create.add_argument("--wait-ready", action="store_true", help="Poll the worker terminal until startup is classified.")
    create.add_argument(
        "--wait-ready-timeout",
        type=int,
        default=DEFAULT_WAIT_READY_SECONDS,
        help="Seconds to wait when --wait-ready is enabled.",
    )
    create.add_argument(
        "--verify",
        action="store_true",
        help="Wait for the worker to update status.json after startup and print attach/stop commands.",
    )
    create.add_argument("--verify-timeout", type=int, default=60, help="Seconds to wait when --verify is enabled.")
    create.add_argument("--open", action="store_true", help="Open a macOS terminal window attached to the worker.")
    create.add_argument(
        "--force-open",
        action="store_true",
        help="Allow opening another terminal window when this worker already has an open event.",
    )
    create.add_argument(
        "--terminal",
        choices=("auto", "ghostty", "terminal"),
        default="auto",
        help="Terminal app to use with --open.",
    )
    create.add_argument("--stop-after", action="store_true", help="Stop the worker after verification.")
    create.set_defaults(func=command_create, initial_prompt=True)

    start = subparsers.add_parser("start", help="Start a normal Codex session inside tmux for later self-management.")
    start.add_argument("session", help="Raw tmux session name to start, e.g. qa-raw.")
    start.add_argument("--cwd", default=str(INVOCATION_CWD), help="Working directory for Codex.")
    start.add_argument(
        "--no-start-prompt",
        action="store_false",
        dest="start_prompt",
        help="Start Codex without the worker self-management bootstrap prompt.",
    )
    start.set_defaults(func=command_start, start_prompt=True)

    start_test = subparsers.add_parser("start-test", help="Create a low-risk worker, verify it, and leave it running.")
    start_test.add_argument("name", nargs="?", default="live-test", help="Worker name.")
    start_test.add_argument("--cwd", default=str(INVOCATION_CWD), help="Working directory for the worker.")
    start_test.add_argument("--task", help="Override the default README/status-only verification task.")
    start_test.add_argument("--reuse", action="store_true", help="Reuse an existing worker state directory.")
    start_test.add_argument(
        "--accept-trust",
        action="store_true",
        help=dedent(
            """\
            Send Enter immediately after launch to accept Codex's workspace trust prompt.
            Use only for directories you intentionally trust.
            """
        ),
    )
    start_test.add_argument(
        "--wait-ready-timeout",
        type=int,
        default=DEFAULT_WAIT_READY_SECONDS,
        help="Seconds to wait for Codex startup classification.",
    )
    start_test.add_argument("--verify-timeout", type=int, default=60, help="Seconds to wait for status.json verification.")
    start_test.add_argument("--open", action="store_true", help="Open a macOS terminal window attached to the worker.")
    start_test.add_argument(
        "--force-open",
        action="store_true",
        help="Allow opening another terminal window when this worker already has an open event.",
    )
    start_test.add_argument(
        "--terminal",
        choices=("auto", "ghostty", "terminal"),
        default="auto",
        help="Terminal app to use with --open.",
    )
    start_test.add_argument("--stop-after", action="store_true", help="Stop the worker after verification.")
    start_test.set_defaults(func=command_start_test)

    doctor = subparsers.add_parser("doctor", help="Check local dependencies and worker state.")
    doctor.add_argument("--cwd", default=str(INVOCATION_CWD), help="Target worker cwd to check.")
    doctor.set_defaults(func=command_doctor)

    doctor_self = subparsers.add_parser("doctor-self", help="Check whether the current Codex session can self-manage in place.")
    doctor_self.add_argument("--session", help="Explicit tmux session; defaults to the current tmux session.")
    doctor_self.add_argument("--json", action="store_true", help="Print stable JSON output.")
    doctor_self.set_defaults(func=command_doctor_self)

    qa_plan = subparsers.add_parser("qa-plan", help="Print a repeatable manual QA checklist.")
    qa_plan.add_argument(
        "scenario",
        nargs="?",
        default="self-management",
        choices=("self-management", "emergent-criteria", "tmux-errors"),
    )
    qa_plan.add_argument("--json", action="store_true", help="Print stable JSON output.")
    qa_plan.set_defaults(func=command_qa_plan)

    db_doctor = subparsers.add_parser(
        "db-doctor",
        help="Schema health check; legacy-table reconciliation. For session-based "
             "runtime drift use `workerctl reconcile`.",
    )
    db_doctor.add_argument("--live", action="store_true", help="Also report read-only live tmux reconciliation drift.")
    db_doctor.add_argument(
        "--manager-stale-seconds",
        type=int,
        default=DEFAULT_MANAGER_STALE_SECONDS,
        help="Warn when a live manager heartbeat is older than this many seconds during --live.",
    )
    db_doctor.add_argument("--path", help="Override the workerctl database path.")
    db_doctor.set_defaults(func=command_db_doctor)

    import_compat = subparsers.add_parser(
        "import-compat",
        help="Dry-run or import existing JSON/JSONL worker artifacts into SQLite.",
    )
    import_compat.add_argument("--apply", action="store_true", help="Apply the import. Default is dry-run.")
    import_compat.add_argument("--worker", help="Import only one compatibility worker directory.")
    import_compat.add_argument("--root", help="Override the compatibility artifact root.")
    import_compat.add_argument("--path", help="Override the workerctl database path.")
    import_compat.set_defaults(func=command_import_compat)

    tasks = subparsers.add_parser("tasks", help="List or create SQLite task records.")
    tasks.add_argument("--json", action="store_true", help="Print tasks as JSON.")
    tasks.add_argument("--active", action="store_true", help="List only active tasks.")
    tasks.add_argument("--create", metavar="NAME", help="Create a task with this display name.")
    tasks.add_argument("--goal", help="Goal text when creating a task.")
    tasks.add_argument("--summary", help="Optional summary text when creating a task.")
    tasks.add_argument("--path", help="Override the workerctl database path.")
    tasks.set_defaults(func=command_tasks)

    criteria = subparsers.add_parser(
        "criteria",
        help="List and mutate emergent acceptance criteria for a task.",
    )
    criteria.add_argument("task", help="Task name or ID.")
    criteria_actions = criteria.add_mutually_exclusive_group(required=True)
    criteria_actions.add_argument("--list", action="store_true", help="List acceptance criteria for the task.")
    criteria_actions.add_argument("--add", action="store_true", help="Add an acceptance criterion.")
    criteria_actions.add_argument("--accept", type=int, metavar="ID", help="Mark an acceptance criterion accepted.")
    criteria_actions.add_argument("--satisfy", type=int, metavar="ID", help="Mark an acceptance criterion satisfied.")
    criteria_actions.add_argument("--defer", type=int, metavar="ID", help="Mark an acceptance criterion deferred.")
    criteria_actions.add_argument("--reject", type=int, metavar="ID", help="Mark an acceptance criterion rejected.")
    criteria.add_argument(
        "--status",
        action="append",
        default=[],
        help="Status for --add, or repeated status filter for --list.",
    )
    criteria.add_argument("--criterion", help="Criterion text for --add.")
    criteria.add_argument("--source", help="Criterion source for --add.")
    criteria.add_argument("--proof", help="Optional proof text for add/update actions.")
    criteria.add_argument("--rationale", help="Optional rationale text for add/update actions.")
    criteria.add_argument("--evidence-json", help="Optional structured JSON object for add/update actions.")
    criteria.add_argument("--path", help="Override the workerctl database path.")
    criteria.set_defaults(func=command_criteria)

    handoff = subparsers.add_parser(
        "handoff",
        help="Record a compact worker handoff summary and next steps for a task.",
    )
    handoff.add_argument("task", help="Task name or ID.")
    handoff.add_argument("--summary", required=True, help="Compact progress summary from the worker.")
    handoff.add_argument(
        "--next-step",
        action="append",
        default=[],
        help="Next step to preserve for manager/worker continuation. May be repeated.",
    )
    handoff.add_argument("--payload-json", help="Optional structured JSON object to store with the handoff.")
    handoff.add_argument("--path", help="Override the workerctl database path.")
    handoff.set_defaults(func=command_handoff)

    manager_config = subparsers.add_parser(
        "manager-config",
        help="Record or show the manager's supervision mode, criteria, references, and permissions.",
    )
    manager_config.add_argument("task", help="Task name or ID.")
    manager_config.add_argument(
        "--mode",
        choices=("light", "guided", "strict"),
        default=None,
        help="How structured manager supervision should be.",
    )
    manager_config.add_argument(
        "--questions",
        action="store_true",
        help="Print the manager setup question schema and current defaults without changing config.",
    )
    manager_config.add_argument(
        "--interactive",
        action="store_true",
        help="Ask manager setup questions on stdin, then persist the answers.",
    )
    manager_config.add_argument("--objective", help="What the manager should do or check against.")
    manager_config.add_argument(
        "--guideline",
        action="append",
        default=[],
        help="Manager guideline. May be repeated.",
    )
    manager_config.add_argument(
        "--acceptance",
        action="append",
        default=[],
        help="Acceptance criterion the manager should check regularly. May be repeated.",
    )
    manager_config.add_argument(
        "--reference",
        action="append",
        default=[],
        help="Planning, PRD, mockup, or other reference path/URL. May be repeated.",
    )
    manager_config.add_argument("--allow-pr", action="store_true", help="Allow the manager to instruct the worker to create a PR.")
    manager_config.add_argument("--allow-merge-green", action="store_true", help="Allow the manager to instruct merging a green PR.")
    manager_config.add_argument(
        "--allow-worker-compact-clear",
        action="store_true",
        help="Allow the manager to instruct the worker to run compact/clear style cleanup when supported.",
    )
    manager_config.add_argument("--permissions-json", help="Optional structured JSON object merged into permissions.")
    manager_config.add_argument("--path", help="Override the workerctl database path.")
    manager_config.set_defaults(func=command_manager_config)

    manager_permission = subparsers.add_parser(
        "manager-permission",
        help="Check and audit whether manager config allows a high-level action.",
    )
    manager_permission.add_argument("task", help="Task name or ID.")
    manager_permission.add_argument(
        "action",
        choices=("create_pr", "merge_green_pr", "worker_compact_clear"),
        help="High-level action to check against manager config.",
    )
    manager_permission.add_argument(
        "--require-handoff",
        action="store_true",
        help="Also require a saved worker handoff; recommended before worker compact/clear.",
    )
    manager_permission.add_argument(
        "--require",
        action="store_true",
        help="Exit non-zero when the action is not currently allowed.",
    )
    manager_permission.add_argument("--path", help="Override the workerctl database path.")
    manager_permission.set_defaults(func=command_manager_permission)

    record_decision = subparsers.add_parser(
        "record-decision",
        help="Record a manager decision for a task and print its decision id.",
    )
    record_decision.add_argument("task", help="Task name or ID.")
    record_decision.add_argument(
        "decision",
        choices=("wait", "nudge", "interrupt", "escalate", "stop", "inspect"),
        help="Decision type to persist.",
    )
    record_decision.add_argument("--reason", required=True, help="Human-readable reason for the decision.")
    record_decision.add_argument("--cycle-id", type=int, help="Optional manager cycle id this decision came from.")
    record_decision.add_argument("--payload-json", help="Optional structured JSON object to store with the decision.")
    record_decision.add_argument("--path", help="Override the workerctl database path.")
    record_decision.set_defaults(func=command_record_decision)

    register_worker = subparsers.add_parser(
        "register-worker",
        help="Register an existing Codex session as a worker.",
    )
    register_worker.add_argument("--name", required=True, help="Logical name for the session.")
    register_worker.add_argument("--pid", type=int, help="Pid of the running codex process.")
    register_worker.add_argument("--codex-session", help="Path to the rollout-*.jsonl file (skips lsof discovery).")
    register_worker.add_argument("--cwd", help="Working directory; defaults to value in session_meta.")
    register_worker.add_argument("--tmux-session", help="Optional tmux session name if the worker is in tmux.")
    register_worker.add_argument("--path", help="Override the workerctl database path.")
    register_worker.set_defaults(func=command_register_worker)

    start_worker = subparsers.add_parser(
        "start-worker",
        help="Spawn codex in a new tmux session and register it as a worker in one call.",
    )
    start_worker.add_argument("--name", required=True, help="Worker session name.")
    start_worker.add_argument(
        "--cwd",
        default=str(INVOCATION_CWD),
        help="Working directory for codex (default: cwd).",
    )
    start_worker.add_argument(
        "--task",
        default=None,
        help="Initial task prompt to pass to codex.",
    )
    start_worker.add_argument(
        "--sandbox",
        default="danger-full-access",
        help="Codex --sandbox mode.",
    )
    start_worker.add_argument(
        "--ask-for-approval",
        default="never",
        help="Codex --ask-for-approval mode.",
    )
    start_worker.add_argument(
        "--timeout-seconds",
        type=int,
        default=15,
        help="Max seconds to wait for codex to write session_meta.",
    )
    start_worker.set_defaults(func=command_start_worker)

    start_manager = subparsers.add_parser(
        "start-manager",
        help="Spawn codex in a new tmux session and register it as a manager in one call.",
    )
    start_manager.add_argument("--name", required=True, help="Manager session name.")
    start_manager.add_argument(
        "--cwd",
        default=str(INVOCATION_CWD),
        help="Working directory for codex (default: cwd).",
    )
    start_manager.add_argument(
        "--sandbox",
        default="danger-full-access",
        help="Codex --sandbox mode.",
    )
    start_manager.add_argument(
        "--ask-for-approval",
        default="never",
        help="Codex --ask-for-approval mode.",
    )
    start_manager.add_argument(
        "--timeout-seconds",
        type=int,
        default=60,
        help="Max seconds to wait for codex to write session_meta.",
    )
    start_manager.set_defaults(func=command_start_manager)

    pair = subparsers.add_parser(
        "pair",
        help="Spawn worker + manager and bind to a task in one shot.",
    )
    pair.add_argument("--task", required=True, help="Task name (slug).")
    pair.add_argument("--worker-name", required=True, help="Worker session name.")
    pair.add_argument("--manager-name", required=True, help="Manager session name.")
    pair.add_argument(
        "--cwd",
        default=str(INVOCATION_CWD),
        help="Shared working directory for both codex spawns.",
    )
    pair.add_argument(
        "--task-prompt",
        default=None,
        help="Initial task prompt for the worker codex.",
    )
    pair.add_argument(
        "--task-goal",
        default=None,
        help="Goal text. Required if task does not exist.",
    )
    pair.add_argument(
        "--task-summary",
        default=None,
        help="Optional task summary (when creating).",
    )
    pair.add_argument(
        "--sandbox",
        default="danger-full-access",
        help="Codex --sandbox mode.",
    )
    pair.add_argument(
        "--ask-for-approval",
        default="never",
        help="Codex --ask-for-approval mode.",
    )
    pair.add_argument(
        "--timeout-seconds",
        type=int,
        default=60,
        help="Max seconds to wait for codex to write session_meta.",
    )
    pair.add_argument(
        "--path",
        help="Override the workerctl database path.",
    )
    pair.set_defaults(func=command_pair)

    register_manager = subparsers.add_parser(
        "register-manager",
        help="Register an existing Codex session as a manager (tmux not required).",
    )
    register_manager.add_argument("--name", required=True)
    register_manager.add_argument("--pid", type=int)
    register_manager.add_argument("--codex-session")
    register_manager.add_argument("--cwd")
    register_manager.add_argument("--tmux-session")
    register_manager.add_argument("--path", help="Override the workerctl database path.")
    register_manager.set_defaults(func=command_register_manager)

    deregister = subparsers.add_parser(
        "deregister",
        help="Mark a registered session as gone. Does not stop any process.",
    )
    deregister.add_argument("name", help="Session name to deregister.")
    deregister.set_defaults(func=command_deregister)

    sessions = subparsers.add_parser(
        "sessions",
        help="List registered sessions (workers and managers).",
    )
    sessions.add_argument("--role", choices=("worker", "manager"), default=None)
    sessions.add_argument(
        "--state", choices=("active", "gone", "all"), default=None,
        help="Filter by session state: active is the default view; all includes legacy and gone rows.",
    )
    sessions.add_argument(
        "--include-legacy", action="store_true",
        help="Include Phase 1 backfill rows (pid IS NULL) — legacy workers/managers.",
    )
    sessions.set_defaults(func=command_sessions)

    bind = subparsers.add_parser(
        "bind",
        help="Bind a worker and manager session pair to a task.",
    )
    bind.add_argument("--task", required=True, help="Task name.")
    bind.add_argument("--worker", required=True, help="Worker session name.")
    bind.add_argument("--manager", required=True, help="Manager session name.")
    bind.set_defaults(func=command_bind)

    unbind = subparsers.add_parser(
        "unbind",
        help="End the active binding for a task.",
    )
    unbind.add_argument("--task", required=True, help="Task name.")
    unbind.set_defaults(func=command_unbind)

    ingest = subparsers.add_parser(
        "ingest",
        help="Read new events from a session's rollout JSONL and persist them.",
    )
    ingest.add_argument("name", help="Session name.")
    ingest.set_defaults(func=command_ingest)

    tail = subparsers.add_parser(
        "tail",
        help="Print the most recent codex_events for a session (newest first).",
    )
    tail.add_argument("name", help="Session name.")
    tail.add_argument("--limit", type=int, default=50, help="Max events to print.")
    tail.add_argument("--subtype", default=None, help="Filter by event_msg subtype.")
    tail.set_defaults(func=command_tail)

    session_nudge = subparsers.add_parser(
        "session-nudge",
        help="Send text (followed by Enter) to a registered session's tmux pane.",
    )
    session_nudge.add_argument("name", help="Session name.")
    session_nudge.add_argument("text", help="Text to send.")
    session_nudge.add_argument("--dry-run", action="store_true", help="Resolve target without sending.")
    session_nudge.set_defaults(func=command_session_nudge)

    session_interrupt = subparsers.add_parser(
        "session-interrupt",
        help="Send an interrupt key (default Ctrl-C) to a registered session's tmux pane.",
    )
    session_interrupt.add_argument("name", help="Session name.")
    session_interrupt.add_argument("--key", default="C-c", help="Key chord (tmux format).")
    session_interrupt.add_argument("--followup", default=None, help="Optional text to send after the interrupt.")
    session_interrupt.add_argument("--dry-run", action="store_true", help="Resolve target without sending.")
    session_interrupt.set_defaults(func=command_session_interrupt)

    request_worker_compact = subparsers.add_parser(
        "request-worker-compact",
        help="Send /compact or /clear to a worker through the audited path.",
    )
    request_worker_compact.add_argument("task", help="Task name or ID.")
    request_worker_compact.add_argument("--decision-id", type=int, help="Manager nudge decision ID justifying the request.")
    request_worker_compact.add_argument("--strict-decisions", action="store_true", help="Reject unless --decision-id is a valid nudge decision.")
    request_worker_compact.add_argument("--clear", action="store_true", help="Send /clear instead of the default /compact slash command.")
    request_worker_compact.add_argument("--prompt-only", action="store_true", help="Send an explanatory prompt instead of a Codex slash command.")
    request_worker_compact.add_argument("--message", help="Override the prompt used with --prompt-only; audit metadata only otherwise.")
    request_worker_compact.add_argument("--dry-run", action="store_true", help="Resolve and audit without sending text to the worker.")
    request_worker_compact.add_argument("--path", help="Override the workerctl database path.")
    request_worker_compact.set_defaults(func=command_request_worker_compact)

    compact_worker = subparsers.add_parser(
        "compact-worker",
        help="Record a nudge decision and send /compact or /clear to the worker.",
    )
    compact_worker.add_argument("task", help="Task name or ID.")
    compact_worker.add_argument("--reason", required=True, help="Human-readable reason for compacting or clearing worker context.")
    compact_worker.add_argument("--cycle-id", type=int, help="Optional manager cycle id this decision came from.")
    compact_worker.add_argument("--clear", action="store_true", help="Send /clear instead of the default /compact slash command.")
    compact_worker.add_argument("--prompt-only", action="store_true", help="Send an explanatory prompt instead of a Codex slash command.")
    compact_worker.add_argument("--message", help="Override the prompt used with --prompt-only; audit metadata only otherwise.")
    compact_worker.add_argument("--dry-run", action="store_true", help="Resolve and audit without sending text to the worker.")
    compact_worker.add_argument("--path", help="Override the workerctl database path.")
    compact_worker.set_defaults(func=command_compact_worker)

    cycle = subparsers.add_parser(
        "cycle",
        help="Run one observation cycle for a session-bound task. Returns JSON.",
    )
    cycle.add_argument("task", help="Task name.")
    cycle.add_argument(
        "--busy-wait-seconds", type=int, default=DEFAULT_BUSY_WAIT_SECONDS,
        help="Seconds the pane signal classifier waits before flagging a stuck-busy pane (default: %(default)s).",
    )
    cycle.set_defaults(func=command_cycle)

    divergences = subparsers.add_parser(
        "divergences",
        help="List cycle observations where the shadow pane signal flagged a notable pattern.",
    )
    divergences.add_argument("task", help="Task name.")
    divergences.add_argument("--limit", type=int, default=50, help="Max rows to return.")
    divergences.set_defaults(func=command_divergences)

    commands = subparsers.add_parser("commands", help="List durable side-effect commands from SQLite.")
    commands.add_argument("--task", help="Filter by task name or ID.")
    commands.add_argument("--state", choices=("pending", "attempted", "succeeded", "failed"), help="Filter by command state.")
    commands.add_argument("--type", help="Filter by command type.")
    commands.add_argument("--worker", help="Filter by worker ID.")
    commands.add_argument("--manager", help="Filter by manager ID.")
    commands.add_argument("--json", action="store_true", help="Print commands as JSON.")
    commands.add_argument("--path", help="Override the workerctl database path.")
    commands.set_defaults(func=command_commands)

    prune = subparsers.add_parser("prune", help="Drop old hot transcript capture content while preserving metadata.")
    prune.add_argument("--keep-latest", type=int, default=20, help="Number of content-bearing captures to retain per worker.")
    prune.add_argument("--dry-run", action="store_true", help="Report how many captures would be pruned.")
    prune.add_argument("--path", help="Override the workerctl database path.")
    prune.set_defaults(func=command_prune)

    stop_task = subparsers.add_parser("stop-task", help="Stop a task manager, optionally stop the worker, and mark the task done.")
    stop_task.add_argument("task", help="Task name or ID.")
    stop_task.add_argument("--stop-worker", action="store_true", help="Also stop the bound worker tmux session.")
    stop_task.add_argument("--message", help="Optional final message to send before stopping the worker.")
    stop_task.add_argument("--decision-id", type=int, help="Manager decision ID that justifies this stop.")
    stop_task.add_argument("--strict-decisions", action="store_true", help="Reject the stop unless --decision-id is valid.")
    stop_task.add_argument("--path", help="Override the workerctl database path.")
    stop_task.set_defaults(func=command_stop_task)

    finish_task = subparsers.add_parser(
        "finish-task",
        help="Record a task as finished, leave its manager open by default, optionally stop sessions, and preserve audit history.",
    )
    finish_task.add_argument("task", help="Task name or ID.")
    finish_task.add_argument("--stop-manager", action="store_true", help="Also stop the manager tmux session after recording completion.")
    finish_task.add_argument("--stop-worker", action="store_true", help="Also stop the bound worker tmux session.")
    finish_task.add_argument("--message", help="Optional final message to send before stopping the worker.")
    finish_task.add_argument("--decision-id", type=int, help="Manager decision ID that justifies this finish.")
    finish_task.add_argument("--strict-decisions", action="store_true", help="Reject the finish unless --decision-id is valid.")
    finish_task.add_argument(
        "--require-criteria-audit",
        action="store_true",
        help="Fail before finishing if any accepted acceptance criteria remain open.",
    )
    finish_task.add_argument(
        "--reason",
        default="Task finished by operator.",
        help="Reason recorded as the final manager decision.",
    )
    finish_task.add_argument("--path", help="Override the workerctl database path.")
    finish_task.set_defaults(func=command_finish_task)

    reconcile = subparsers.add_parser(
        "reconcile",
        help="Report (and optionally apply) reconciliation actions on session-based "
             "bindings: dead-pid sessions, dangling bindings, stuck tasks. "
             "For legacy worker_id-based drift use `workerctl db-doctor --live`.",
    )
    reconcile.add_argument("--apply", action="store_true",
                          help="Mark dead-pid sessions gone and dangling bindings invalid.")
    reconcile.add_argument(
        "--stale-cycles-seconds", type=float, default=3600.0,
        help="Seconds without a new manager_cycles row before a task is reported stuck (default 3600).",
    )
    reconcile.set_defaults(func=command_reconcile)

    transcript_capture = subparsers.add_parser("transcript-capture", help="Capture deduplicated full transcript segments for a task.")
    transcript_capture.add_argument("task", help="Task name or ID.")
    transcript_capture.add_argument("--role", choices=("all", "worker", "manager"), default="all")
    transcript_capture.add_argument("--mode", choices=("metadata", "excerpt", "snapshot", "segment", "full"), default="segment")
    transcript_capture.add_argument("--lines", type=int, default=DEFAULT_HISTORY_LINES)
    transcript_capture.add_argument("--json", action="store_true")
    transcript_capture.add_argument("--path", help="Override the workerctl database path.")
    transcript_capture.set_defaults(func=command_transcript_capture)

    transcript_show = subparsers.add_parser("transcript-show", help="Show stored transcript segments for a task.")
    transcript_show.add_argument("task", help="Task name or ID.")
    transcript_show.add_argument("--role", choices=("all", "worker", "manager"), default="all")
    transcript_show.add_argument("--limit", type=int)
    transcript_show.add_argument("--json", action="store_true")
    transcript_show.add_argument("--path", help="Override the workerctl database path.")
    transcript_show.set_defaults(func=command_transcript_show)

    transcript_prune = subparsers.add_parser("transcript-prune", help="Prune stored transcript segment text to metadata.")
    transcript_prune.add_argument("task", help="Task name or ID.")
    transcript_prune.add_argument("--keep-latest", type=int, default=20)
    transcript_prune.add_argument("--dry-run", action="store_true")
    transcript_prune.add_argument("--path", help="Override the workerctl database path.")
    transcript_prune.set_defaults(func=command_transcript_prune)

    audit = subparsers.add_parser("audit", help="Print SQLite audit history for a task.")
    audit.add_argument("task", help="Task name or ID.")
    audit.add_argument("--json", action="store_true", help="Print audit records as JSON.")
    audit.add_argument("--path", help="Override the workerctl database path.")
    audit.set_defaults(func=command_audit)

    mutation_audit = subparsers.add_parser("mutation-audit", help="Show manager decisions linked to task mutations.")
    mutation_audit.add_argument("task", help="Task name or ID.")
    mutation_audit.add_argument("--json", action="store_true", help="Print mutation audit records as JSON.")
    mutation_audit.add_argument("--path", help="Override the workerctl database path.")
    mutation_audit.set_defaults(func=command_mutation_audit)

    replay = subparsers.add_parser("replay", help="Replay a task's worker-manager timeline.")
    replay.add_argument("task", help="Task name or ID.")
    replay.add_argument("--json", action="store_true", help="Print stable JSON output.")
    replay.add_argument("--format", choices=("compact", "timeline", "transcript", "full-transcript"), default="timeline")
    replay.add_argument("--role", choices=("all", "worker", "manager"), default="all")
    replay.add_argument("--limit", type=int, help="Print only the last N replay entries.")
    replay.add_argument("--path", help="Override the workerctl database path.")
    replay.set_defaults(func=command_replay)

    export_task = subparsers.add_parser("export-task", help="Export task status, audit, prompts, and transcript metadata.")
    export_task.add_argument("task", help="Task name or ID.")
    export_task.add_argument("--output", help="Directory to write the export bundle.")
    export_task.add_argument("--zip", action="store_true", help="Also write a zip archive next to the export directory.")
    export_task.add_argument("--include-transcripts", action="store_true", help="Include deduplicated transcript segment metadata/content.")
    export_task.add_argument("--include-full-transcripts", action="store_true", help="Include role-tagged full transcript text files and full-transcript replay.")
    export_task.add_argument("--path", help="Override the workerctl database path.")
    export_task.set_defaults(func=command_export_task)

    list_cmd = subparsers.add_parser("list", help="List known workers.")
    list_cmd.add_argument("--json", action="store_true", help="Print known workers as JSON.")
    list_cmd.set_defaults(func=command_list)

    capture = subparsers.add_parser("capture", help="Capture recent worker terminal output.")
    capture.add_argument("name")
    capture.add_argument("--lines", type=int, default=DEFAULT_HISTORY_LINES)
    capture.set_defaults(func=command_capture)

    status = subparsers.add_parser("status", help="Print worker status as JSON.")
    status.add_argument("name")
    status.add_argument("--no-refresh", action="store_false", dest="refresh", help="Do not refresh terminal capture.")
    status.add_argument("--lines", type=int, default=DEFAULT_HISTORY_LINES)
    status.set_defaults(func=command_status, refresh=True)

    update_status = subparsers.add_parser("update-status", help="Update a worker status contract.")
    update_status.add_argument("name")
    update_status.add_argument(
        "--state",
        required=True,
        choices=("planning", "editing", "running_tests", "blocked", "waiting", "done", "unknown"),
        help="Worker status state.",
    )
    update_status.add_argument("--current-task", required=True, help="Short description of current work.")
    update_status.add_argument("--next-action", required=True, help="Short description of next action.")
    update_status.add_argument("--blocker", help="Blocker text, if any.")
    update_status.set_defaults(func=command_update_status)

    idle_check = subparsers.add_parser("idle-check", help="Classify worker freshness and recommend an action.")
    idle_check.add_argument("name")
    idle_check.add_argument("--no-refresh", action="store_false", dest="refresh", help="Do not refresh terminal capture.")
    idle_check.add_argument("--lines", type=int, default=DEFAULT_HISTORY_LINES)
    idle_check.add_argument("--status-stale-seconds", type=int, default=DEFAULT_STATUS_STALE_SECONDS)
    idle_check.add_argument("--terminal-stale-seconds", type=int, default=DEFAULT_TERMINAL_STALE_SECONDS)
    idle_check.add_argument("--busy-wait-seconds", type=int, default=DEFAULT_BUSY_WAIT_SECONDS)
    idle_check.set_defaults(func=command_idle_check, refresh=True)

    events = subparsers.add_parser("events", help="Print worker event log as JSON lines.")
    events.add_argument("name")
    events.add_argument("--limit", type=int, help="Print only the last N events.")
    events.add_argument("--type", help="Print only events of this type.")
    events.set_defaults(func=command_events)

    classify = subparsers.add_parser("classify", help="Classify captured terminal text for startup and busy-wait states.")
    classify.add_argument("--text", help="Terminal text to classify. Reads stdin when omitted.")
    classify.add_argument("--file", help="Path to terminal text to classify.")
    classify.add_argument("--status-age-seconds", type=int, default=DEFAULT_BUSY_WAIT_SECONDS)
    classify.add_argument("--busy-wait-seconds", type=int, default=DEFAULT_BUSY_WAIT_SECONDS)
    classify.set_defaults(func=command_classify)

    interrupt = subparsers.add_parser("interrupt", help="Send an explicit interrupt key to a worker.")
    interrupt.add_argument("name")
    interrupt.add_argument("--key", default="C-c", help="tmux key to send, e.g. C-c or Escape.")
    interrupt.add_argument("--followup", default=DEFAULT_INTERRUPT_FOLLOWUP, help="Message to send after interrupting.")
    interrupt.add_argument("--no-followup", action="store_true", help="Do not send a follow-up message.")
    interrupt.add_argument("--dry-run", action="store_true", help="Report without sending keys.")
    interrupt.set_defaults(func=command_interrupt)

    nudge = subparsers.add_parser("nudge", help="Send a message into the worker terminal.")
    nudge.add_argument("name")
    nudge.add_argument("message")
    nudge.set_defaults(func=command_nudge)

    open_cmd = subparsers.add_parser("open", help="Open a macOS terminal window attached to a running worker.")
    open_cmd.add_argument("name")
    open_cmd.add_argument(
        "--terminal",
        choices=("auto", "ghostty", "terminal"),
        default="auto",
        help="Terminal app to use.",
    )
    open_cmd.add_argument("--dry-run", action="store_true", help="Print the launch command without opening a window.")
    open_cmd.add_argument(
        "--force",
        action="store_true",
        help="Allow opening another terminal window when this worker already has an open event.",
    )
    open_cmd.set_defaults(func=command_open)

    open_worker = subparsers.add_parser("open-worker", help="Open a terminal window attached to a task's worker.")
    open_worker.add_argument("task", help="Task name or ID.")
    open_worker.add_argument(
        "--terminal",
        choices=("auto", "ghostty", "terminal"),
        default="auto",
        help="Terminal app to use.",
    )
    open_worker.add_argument("--dry-run", action="store_true", help="Print the launch command without opening a window.")
    open_worker.add_argument("--path", help="Override the workerctl database path.")
    open_worker.set_defaults(func=command_open_worker)

    open_manager = subparsers.add_parser("open-manager", help="Open a terminal window attached to a task's manager.")
    open_manager.add_argument("task", help="Task name or ID.")
    open_manager.add_argument(
        "--terminal",
        choices=("auto", "ghostty", "terminal"),
        default="auto",
        help="Terminal app to use.",
    )
    open_manager.add_argument("--dry-run", action="store_true", help="Print the launch command without opening a window.")
    open_manager.add_argument("--path", help="Override the workerctl database path.")
    open_manager.set_defaults(func=command_open_manager)

    stop = subparsers.add_parser("stop", help="Stop a worker tmux session.")
    stop.add_argument("name")
    stop.add_argument("--message", help="Optional final message to send before stopping.")
    stop.set_defaults(func=command_stop)

    return parser


def main() -> int:
    parser = build_parser()
    args, unknown = parser.parse_known_args()
    if unknown and args.command not in {"start"}:
        parser.error(f"unrecognized arguments: {' '.join(unknown)}")
    args.codex_args = unknown
    try:
        return args.func(args)
    except (WorkerError, CodexSessionError, IngestError) as exc:
        print(f"workerctl: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
