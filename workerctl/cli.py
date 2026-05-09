#!/usr/bin/env python3
"""Control tmux-backed Codex worker sessions."""

from __future__ import annotations

import argparse
import sys
from textwrap import dedent

from workerctl.constants import (
    DEFAULT_BUSY_WAIT_SECONDS,
    DEFAULT_HISTORY_LINES,
    DEFAULT_INTERRUPT_FOLLOWUP,
    DEFAULT_MANAGER_STALE_SECONDS,
    DEFAULT_STATUS_NUDGE,
    DEFAULT_STATUS_STALE_SECONDS,
    DEFAULT_SUPERVISE_COOLDOWN_SECONDS,
    DEFAULT_TERMINAL_STALE_SECONDS,
    DEFAULT_WAIT_READY_SECONDS,
    INVOCATION_CWD,
)
from workerctl.commands import (
    command_audit,
    command_bind_task,
    command_capture,
    command_classify,
    command_commands,
    command_create,
    command_db_doctor,
    command_doctor,
    command_doctor_self,
    command_events,
    command_explain_managed_flow,
    command_interrupt,
    command_list,
    command_manager_decision,
    command_manager_observe,
    command_name_session,
    command_nudge,
    command_open,
    command_open_manager,
    command_open_worker,
    command_prune,
    command_qa_plan,
    command_start,
    command_start_test,
    command_status,
    command_stop,
    command_tail,
    command_task_capture,
    command_task_events,
    command_task_health,
    command_task_idle_check,
    command_task_interrupt,
    command_task_nudge,
    command_task_status,
    command_tasks,
    command_update_status,
)
from workerctl.core import WorkerError
from workerctl.export import command_export_task
from workerctl.importer import command_import_compat
from workerctl.lifecycle import (
    command_become_managed,
    command_close_stale,
    command_finish_task,
    command_manage,
    command_my_status,
    command_pause_manager,
    command_promote,
    command_reconcile,
    command_recover,
    command_remanage,
    command_resume_manager,
    command_self_promote,
    command_stop_task,
    command_unmanage,
)
from workerctl.supervise import command_idle_check, command_supervise, command_watch


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

    name_session = subparsers.add_parser(
        "name-session",
        help="Name the current tmux session as a worker and register it in SQLite.",
    )
    name_session.add_argument("name", help="Worker name to assign to the current tmux session.")
    name_session.add_argument("--cwd", default=str(INVOCATION_CWD), help="Working directory for the worker.")
    name_session.add_argument("--task", help="Optional task text for the generated worker contract/status.")
    name_session.add_argument("--session", help="Explicit tmux session to name; defaults to the current tmux session.")
    name_session.add_argument("--force", action="store_true", help="Replace an existing worker config for this name.")
    name_session.add_argument("--path", help="Override the workerctl database path.")
    name_session.set_defaults(func=command_name_session)

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

    explain_managed_flow = subparsers.add_parser(
        "explain-managed-flow",
        help="Explain the agent-facing flow for becoming, pausing, resuming, and finishing managed work.",
    )
    explain_managed_flow.add_argument("--session", help="Optional tmux session to include in command templates.")
    explain_managed_flow.add_argument("--json", action="store_true", help="Print stable JSON output.")
    explain_managed_flow.set_defaults(func=command_explain_managed_flow)

    qa_plan = subparsers.add_parser("qa-plan", help="Print a repeatable manual QA checklist.")
    qa_plan.add_argument("scenario", nargs="?", default="self-management", choices=("self-management",))
    qa_plan.add_argument("--json", action="store_true", help="Print stable JSON output.")
    qa_plan.set_defaults(func=command_qa_plan)

    db_doctor = subparsers.add_parser("db-doctor", help="Initialize and check the SQLite control-plane database.")
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

    bind_task = subparsers.add_parser("bind-task", help="Bind a SQLite task record to a worker.")
    bind_task.add_argument("task", help="Task name or ID.")
    bind_task.add_argument("--worker", required=True, help="Worker name or ID.")
    bind_task.add_argument("--path", help="Override the workerctl database path.")
    bind_task.set_defaults(func=command_bind_task)

    become_managed = subparsers.add_parser(
        "become-managed",
        help="Agent-facing command to register this session as a worker and open a manager.",
    )
    become_managed.add_argument("--worker", help="Worker name to assign to the current tmux session when needed.")
    become_managed.add_argument("--task", required=True, help="Task name to create or resume.")
    become_managed.add_argument("--goal", required=True, help="Task goal.")
    become_managed.add_argument("--summary", help="Optional current task summary.")
    become_managed.add_argument("--manager-instructions", help="Additional manager instructions.")
    become_managed.add_argument("--max-nudges", type=int, default=3, help="Nudge budget for the manager.")
    become_managed.add_argument("--budget-hours", type=int, default=24, help="Hours until the default nudge budget expires.")
    become_managed.add_argument("--budget-expires-at", help="Explicit ISO timestamp for nudge budget expiry.")
    become_managed.add_argument("--cwd", default=str(INVOCATION_CWD), help="Working directory for the worker record.")
    become_managed.add_argument("--worker-task", help="Task text for the worker status contract when registering this session.")
    become_managed.add_argument("--session", help="Explicit tmux session to manage; defaults to the current tmux session.")
    become_managed.add_argument("--force-name", action="store_true", help="Replace an existing worker config when registering this session.")
    become_managed.add_argument(
        "--no-open-manager",
        action="store_false",
        dest="open_manager",
        help="Do not open a visible terminal window for the spawned manager.",
    )
    become_managed.add_argument(
        "--terminal",
        choices=("auto", "ghostty", "terminal"),
        default="auto",
        help="Terminal app to use for the manager window.",
    )
    become_managed.add_argument("--path", help="Override the workerctl database path.")
    become_managed.set_defaults(func=command_become_managed, open_manager=True)

    manage = subparsers.add_parser("manage", help="From inside a worker session, register it if needed and spawn a manager.")
    manage.add_argument("--worker", help="Worker name to assign to the current tmux session when needed.")
    manage.add_argument("--task", required=True, help="Task name to create or resume.")
    manage.add_argument("--goal", required=True, help="Task goal.")
    manage.add_argument("--summary", help="Optional current task summary.")
    manage.add_argument("--manager-instructions", help="Additional manager instructions.")
    manage.add_argument("--max-nudges", type=int, default=3, help="Nudge budget for the manager.")
    manage.add_argument("--budget-hours", type=int, default=24, help="Hours until the default nudge budget expires.")
    manage.add_argument("--budget-expires-at", help="Explicit ISO timestamp for nudge budget expiry.")
    manage.add_argument("--cwd", default=str(INVOCATION_CWD), help="Working directory for the worker record.")
    manage.add_argument("--worker-task", help="Task text for the worker status contract when registering this session.")
    manage.add_argument("--session", help="Explicit tmux session to manage; defaults to the current tmux session.")
    manage.add_argument("--force-name", action="store_true", help="Replace an existing worker config when registering this session.")
    manage.add_argument("--open-manager", action="store_true", help="Open a terminal window attached to the spawned manager.")
    manage.add_argument(
        "--terminal",
        choices=("auto", "ghostty", "terminal"),
        default="auto",
        help="Terminal app to use with --open-manager.",
    )
    manage.add_argument("--path", help="Override the workerctl database path.")
    manage.set_defaults(func=command_manage)

    promote = subparsers.add_parser("promote", help="Promote an existing worker into a managed task.")
    promote.add_argument("worker", help="Existing worker name.")
    promote.add_argument("--task", required=True, help="Task name to create or resume.")
    promote.add_argument("--goal", required=True, help="Task goal.")
    promote.add_argument("--summary", help="Optional current task summary.")
    promote.add_argument("--manager-instructions", help="Additional manager instructions.")
    promote.add_argument("--max-nudges", type=int, default=3, help="Nudge budget for the manager.")
    promote.add_argument("--budget-hours", type=int, default=24, help="Hours until the default nudge budget expires.")
    promote.add_argument("--budget-expires-at", help="Explicit ISO timestamp for nudge budget expiry.")
    promote.add_argument("--open-manager", action="store_true", help="Open a terminal window attached to the spawned manager.")
    promote.add_argument(
        "--terminal",
        choices=("auto", "ghostty", "terminal"),
        default="auto",
        help="Terminal app to use with --open-manager.",
    )
    promote.add_argument("--path", help="Override the workerctl database path.")
    promote.set_defaults(func=command_promote)

    self_promote = subparsers.add_parser("self-promote", help="Promote the current named worker session into a managed task.")
    self_promote.add_argument("--task", required=True, help="Task name to create or resume.")
    self_promote.add_argument("--goal", required=True, help="Task goal.")
    self_promote.add_argument("--summary", help="Optional current task summary.")
    self_promote.add_argument("--manager-instructions", help="Additional manager instructions.")
    self_promote.add_argument("--max-nudges", type=int, default=3, help="Nudge budget for the manager.")
    self_promote.add_argument("--budget-hours", type=int, default=24, help="Hours until the default nudge budget expires.")
    self_promote.add_argument("--budget-expires-at", help="Explicit ISO timestamp for nudge budget expiry.")
    self_promote.add_argument("--worker", help="Override current-session worker inference.")
    self_promote.add_argument("--session", help="Explicit tmux session to infer worker name from.")
    self_promote.add_argument("--open-manager", action="store_true", help="Open a terminal window attached to the spawned manager.")
    self_promote.add_argument(
        "--terminal",
        choices=("auto", "ghostty", "terminal"),
        default="auto",
        help="Terminal app to use with --open-manager.",
    )
    self_promote.add_argument("--path", help="Override the workerctl database path.")
    self_promote.set_defaults(func=command_self_promote)

    pause_manager = subparsers.add_parser("pause-manager", help="Stop a task manager while leaving the worker running.")
    pause_manager.add_argument("task", help="Task name or ID.")
    pause_manager.add_argument("--path", help="Override the workerctl database path.")
    pause_manager.set_defaults(func=command_pause_manager)

    unmanage = subparsers.add_parser("unmanage", help="Stop this worker's manager while leaving the worker running.")
    unmanage.add_argument("--task", help="Explicit task name or ID; defaults to the task bound to the current session.")
    unmanage.add_argument("--session", help="Explicit tmux session; defaults to the current tmux session.")
    unmanage.add_argument("--dry-run", action="store_true", help="Resolve the task and manager without stopping anything.")
    unmanage.add_argument("--json", action="store_true", help="Print stable JSON output.")
    unmanage.add_argument("--path", help="Override the workerctl database path.")
    unmanage.set_defaults(func=command_unmanage)

    my_status = subparsers.add_parser("my-status", help="Show this worker's current managed task and manager state.")
    my_status.add_argument("--task", help="Explicit task name or ID; defaults to the task bound to the current session.")
    my_status.add_argument("--session", help="Explicit tmux session; defaults to the current tmux session.")
    my_status.add_argument("--json", action="store_true", help="Print stable JSON output.")
    my_status.add_argument("--path", help="Override the workerctl database path.")
    my_status.set_defaults(func=command_my_status)

    remanage = subparsers.add_parser("remanage", help="Restart this worker's paused manager.")
    remanage.add_argument("--task", help="Explicit task name or ID; defaults to the task bound to the current session.")
    remanage.add_argument("--session", help="Explicit tmux session; defaults to the current tmux session.")
    remanage.add_argument("--open-manager", action="store_true", help="Open a terminal window attached to the spawned manager.")
    remanage.add_argument(
        "--terminal",
        choices=("auto", "ghostty", "terminal"),
        default="auto",
        help="Terminal app to use with --open-manager.",
    )
    remanage.add_argument("--path", help="Override the workerctl database path.")
    remanage.set_defaults(func=command_remanage)

    resume_manager = subparsers.add_parser("resume-manager", help="Restart a paused task manager.")
    resume_manager.add_argument("task", help="Task name or ID.")
    resume_manager.add_argument("--open-manager", action="store_true", help="Open a terminal window attached to the spawned manager.")
    resume_manager.add_argument(
        "--terminal",
        choices=("auto", "ghostty", "terminal"),
        default="auto",
        help="Terminal app to use with --open-manager.",
    )
    resume_manager.add_argument("--path", help="Override the workerctl database path.")
    resume_manager.set_defaults(func=command_resume_manager)

    stop_task = subparsers.add_parser("stop-task", help="Stop a task manager, optionally stop the worker, and mark the task done.")
    stop_task.add_argument("task", help="Task name or ID.")
    stop_task.add_argument("--stop-worker", action="store_true", help="Also stop the bound worker tmux session.")
    stop_task.add_argument("--message", help="Optional final message to send before stopping the worker.")
    stop_task.add_argument("--path", help="Override the workerctl database path.")
    stop_task.set_defaults(func=command_stop_task)

    finish_task = subparsers.add_parser(
        "finish-task",
        help="Record a task as finished, stop its manager, optionally stop the worker, and preserve audit history.",
    )
    finish_task.add_argument("task", help="Task name or ID.")
    finish_task.add_argument("--stop-worker", action="store_true", help="Also stop the bound worker tmux session.")
    finish_task.add_argument("--message", help="Optional final message to send before stopping the worker.")
    finish_task.add_argument(
        "--reason",
        default="Task finished by operator.",
        help="Reason recorded as the final manager decision.",
    )
    finish_task.add_argument("--path", help="Override the workerctl database path.")
    finish_task.set_defaults(func=command_finish_task)

    reconcile = subparsers.add_parser("reconcile", help="Report drift between SQLite and live tmux sessions.")
    reconcile.add_argument("task", nargs="?", help="Optional task name or ID.")
    reconcile.add_argument("--path", help="Override the workerctl database path.")
    reconcile.set_defaults(func=command_reconcile)

    recover = subparsers.add_parser("recover", help="Mark missing sessions discovered by reconciliation.")
    recover.add_argument("task", nargs="?", help="Optional task name or ID.")
    recover.add_argument(
        "--sync-pane-ids",
        action="store_true",
        help="For live pane mismatches, update recorded pane IDs to the current tmux pane IDs.",
    )
    recover.add_argument("--path", help="Override the workerctl database path.")
    recover.set_defaults(func=command_recover)

    close_stale = subparsers.add_parser(
        "close-stale",
        help="Dry-run or close stale tasks whose recorded worker is missing and unsupervised.",
    )
    close_stale.add_argument("task", nargs="?", help="Optional task name or ID.")
    close_stale.add_argument("--apply", action="store_true", help="Apply the close plan. Default is dry-run.")
    close_stale.add_argument("--path", help="Override the workerctl database path.")
    close_stale.set_defaults(func=command_close_stale)

    task_status = subparsers.add_parser("task-status", help="Print task-scoped status from SQLite.")
    task_status.add_argument("task", help="Task name or ID.")
    task_status.add_argument("--json", action="store_true", help="Print stable JSON output.")
    task_status.add_argument("--path", help="Override the workerctl database path.")
    task_status.set_defaults(func=command_task_status)

    task_health = subparsers.add_parser("task-health", help="Check task integrity, live bindings, and manager health.")
    task_health.add_argument("task", help="Task name or ID.")
    task_health.add_argument("--json", action="store_true", help="Print stable JSON output.")
    task_health.add_argument("--record", action="store_true", help="Persist this health check as an audit observation.")
    task_health.add_argument(
        "--manager-stale-seconds",
        type=int,
        default=DEFAULT_MANAGER_STALE_SECONDS,
        help="Warn when a live manager heartbeat is older than this many seconds.",
    )
    task_health.add_argument("--path", help="Override the workerctl database path.")
    task_health.set_defaults(func=command_task_health)

    task_capture = subparsers.add_parser("task-capture", help="Capture terminal output for a task's bound worker.")
    task_capture.add_argument("task", help="Task name or ID.")
    task_capture.add_argument("--lines", type=int, default=DEFAULT_HISTORY_LINES)
    task_capture.add_argument("--role", choices=("worker", "manager"), default="worker", help="Task terminal role to capture.")
    task_capture.add_argument("--json", action="store_true", help="Print capture metadata and output as JSON.")
    task_capture.add_argument("--path", help="Override the workerctl database path.")
    task_capture.set_defaults(func=command_task_capture)

    manager_observe = subparsers.add_parser("manager-observe", help="Record one manager observation cycle for a task.")
    manager_observe.add_argument("task", help="Task name or ID.")
    manager_observe.add_argument("--json", action="store_true", help="Print stable JSON output.")
    manager_observe.add_argument("--compact", action="store_true", help="Return compact JSON while still recording full captures.")
    manager_observe.add_argument("--lines", type=int, default=DEFAULT_HISTORY_LINES)
    manager_observe.add_argument("--no-refresh", action="store_false", dest="refresh", help="Do not refresh worker terminal metadata during idle check.")
    manager_observe.add_argument("--status-stale-seconds", type=int, default=DEFAULT_STATUS_STALE_SECONDS)
    manager_observe.add_argument("--terminal-stale-seconds", type=int, default=DEFAULT_TERMINAL_STALE_SECONDS)
    manager_observe.add_argument("--busy-wait-seconds", type=int, default=DEFAULT_BUSY_WAIT_SECONDS)
    manager_observe.add_argument(
        "--manager-stale-seconds",
        type=int,
        default=DEFAULT_MANAGER_STALE_SECONDS,
        help="Warn when a live manager heartbeat is older than this many seconds.",
    )
    manager_observe.add_argument("--path", help="Override the workerctl database path.")
    manager_observe.set_defaults(func=command_manager_observe, refresh=True)

    manager_decision = subparsers.add_parser("manager-decision", help="Record a manager decision for a task.")
    manager_decision.add_argument("task", help="Task name or ID.")
    manager_decision.add_argument("--decision", required=True, choices=("wait", "nudge", "interrupt", "escalate", "stop", "inspect"))
    manager_decision.add_argument("--reason", required=True, help="Reason for the decision.")
    manager_decision.add_argument("--cycle-id", type=int, help="Manager observation cycle ID to link.")
    manager_decision.add_argument("--path", help="Override the workerctl database path.")
    manager_decision.set_defaults(func=command_manager_decision)

    task_idle_check = subparsers.add_parser("task-idle-check", help="Classify freshness for a task's bound worker.")
    task_idle_check.add_argument("task", help="Task name or ID.")
    task_idle_check.add_argument("--no-refresh", action="store_false", dest="refresh", help="Do not refresh terminal capture.")
    task_idle_check.add_argument("--lines", type=int, default=DEFAULT_HISTORY_LINES)
    task_idle_check.add_argument("--status-stale-seconds", type=int, default=DEFAULT_STATUS_STALE_SECONDS)
    task_idle_check.add_argument("--terminal-stale-seconds", type=int, default=DEFAULT_TERMINAL_STALE_SECONDS)
    task_idle_check.add_argument("--busy-wait-seconds", type=int, default=DEFAULT_BUSY_WAIT_SECONDS)
    task_idle_check.add_argument("--path", help="Override the workerctl database path.")
    task_idle_check.set_defaults(func=command_task_idle_check, refresh=True)

    task_nudge = subparsers.add_parser("task-nudge", help="Send a durable task-scoped nudge to the bound worker.")
    task_nudge.add_argument("task", help="Task name or ID.")
    task_nudge.add_argument("message", help="Message to send to the bound worker.")
    task_nudge.add_argument("--dry-run", action="store_true", help="Record the command without sending the message.")
    task_nudge.add_argument("--path", help="Override the workerctl database path.")
    task_nudge.set_defaults(func=command_task_nudge)

    task_interrupt = subparsers.add_parser(
        "task-interrupt",
        help="Send a durable task-scoped interrupt to the bound worker.",
    )
    task_interrupt.add_argument("task", help="Task name or ID.")
    task_interrupt.add_argument("--key", default="C-c", help="tmux key to send to the bound worker.")
    task_interrupt.add_argument("--followup", default=DEFAULT_INTERRUPT_FOLLOWUP, help="Message to send after interrupt.")
    task_interrupt.add_argument("--no-followup", action="store_true", help="Do not send a follow-up message.")
    task_interrupt.add_argument("--dry-run", action="store_true", help="Record the command without interrupting.")
    task_interrupt.add_argument("--path", help="Override the workerctl database path.")
    task_interrupt.set_defaults(func=command_task_interrupt)

    task_events = subparsers.add_parser("task-events", help="Print task-scoped SQLite events.")
    task_events.add_argument("task", help="Task name or ID.")
    task_events.add_argument("--type", help="Filter by event type.")
    task_events.add_argument("--limit", type=int, help="Print only the last N events.")
    task_events.add_argument("--json", action="store_true", help="Print task events as JSON.")
    task_events.add_argument("--path", help="Override the workerctl database path.")
    task_events.set_defaults(func=command_task_events)

    audit = subparsers.add_parser("audit", help="Print SQLite audit history for a task.")
    audit.add_argument("task", help="Task name or ID.")
    audit.add_argument("--json", action="store_true", help="Print audit records as JSON.")
    audit.add_argument("--path", help="Override the workerctl database path.")
    audit.set_defaults(func=command_audit)

    export_task = subparsers.add_parser("export-task", help="Export task status, audit, prompts, and transcript metadata.")
    export_task.add_argument("task", help="Task name or ID.")
    export_task.add_argument("--output", help="Directory to write the export bundle.")
    export_task.add_argument("--zip", action="store_true", help="Also write a zip archive next to the export directory.")
    export_task.add_argument("--path", help="Override the workerctl database path.")
    export_task.set_defaults(func=command_export_task)

    list_cmd = subparsers.add_parser("list", help="List known workers.")
    list_cmd.add_argument("--json", action="store_true", help="Print known workers as JSON.")
    list_cmd.set_defaults(func=command_list)

    capture = subparsers.add_parser("capture", help="Capture recent worker terminal output.")
    capture.add_argument("name")
    capture.add_argument("--lines", type=int, default=DEFAULT_HISTORY_LINES)
    capture.set_defaults(func=command_capture)

    tail = subparsers.add_parser("tail", help="Capture and print the last N lines.")
    tail.add_argument("name")
    tail.add_argument("--lines", type=int, default=40)
    tail.set_defaults(func=command_tail)

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

    supervise = subparsers.add_parser("supervise", help="Run one manager supervision cycle for a worker.")
    supervise.add_argument("name")
    supervise.add_argument("--no-refresh", action="store_false", dest="refresh", help="Do not refresh terminal capture.")
    supervise.add_argument("--lines", type=int, default=DEFAULT_HISTORY_LINES)
    supervise.add_argument("--status-stale-seconds", type=int, default=DEFAULT_STATUS_STALE_SECONDS)
    supervise.add_argument("--terminal-stale-seconds", type=int, default=DEFAULT_TERMINAL_STALE_SECONDS)
    supervise.add_argument("--busy-wait-seconds", type=int, default=DEFAULT_BUSY_WAIT_SECONDS)
    supervise.add_argument("--cooldown-seconds", type=int, default=DEFAULT_SUPERVISE_COOLDOWN_SECONDS)
    supervise.add_argument("--message", default=DEFAULT_STATUS_NUDGE, help="Status request sent when the worker is stale.")
    supervise.add_argument("--dry-run", action="store_true", help="Report the supervision action without sending nudges.")
    supervise.add_argument("--interrupt-busy-wait", action="store_true", help="Interrupt busy-wait states instead of only reporting them.")
    supervise.add_argument("--interrupt-key", default="C-c", help="tmux key to send when interrupting a busy-wait state.")
    supervise.add_argument(
        "--interrupt-followup",
        default=DEFAULT_INTERRUPT_FOLLOWUP,
        help="Message to send after an interrupt. Use an empty string to skip.",
    )
    supervise.set_defaults(func=command_supervise, refresh=True)

    watch = subparsers.add_parser("watch", help="Run supervise repeatedly until interrupted.")
    watch.add_argument("name")
    watch.add_argument("--interval", type=int, default=60, help="Seconds between supervision cycles.")
    watch.add_argument("--max-cycles", type=int, help="Stop after this many cycles.")
    watch.add_argument("--no-refresh", action="store_false", dest="refresh", help="Do not refresh terminal capture.")
    watch.add_argument("--lines", type=int, default=DEFAULT_HISTORY_LINES)
    watch.add_argument("--status-stale-seconds", type=int, default=DEFAULT_STATUS_STALE_SECONDS)
    watch.add_argument("--terminal-stale-seconds", type=int, default=DEFAULT_TERMINAL_STALE_SECONDS)
    watch.add_argument("--busy-wait-seconds", type=int, default=DEFAULT_BUSY_WAIT_SECONDS)
    watch.add_argument("--cooldown-seconds", type=int, default=DEFAULT_SUPERVISE_COOLDOWN_SECONDS)
    watch.add_argument("--message", default=DEFAULT_STATUS_NUDGE, help="Status request sent when the worker is stale.")
    watch.add_argument("--dry-run", action="store_true", help="Report supervision actions without sending nudges.")
    watch.add_argument("--interrupt-busy-wait", action="store_true", help="Interrupt busy-wait states instead of only reporting them.")
    watch.add_argument("--interrupt-key", default="C-c", help="tmux key to send when interrupting a busy-wait state.")
    watch.add_argument(
        "--interrupt-followup",
        default=DEFAULT_INTERRUPT_FOLLOWUP,
        help="Message to send after an interrupt. Use an empty string to skip.",
    )
    watch.set_defaults(func=command_watch, refresh=True)

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
    if unknown and args.command not in {"start", "promote", "resume-manager", "remanage", "self-promote", "manage", "become-managed"}:
        parser.error(f"unrecognized arguments: {' '.join(unknown)}")
    args.codex_args = unknown
    try:
        return args.func(args)
    except WorkerError as exc:
        print(f"workerctl: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
