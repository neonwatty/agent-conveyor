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
    DEFAULT_STATUS_NUDGE,
    DEFAULT_STATUS_STALE_SECONDS,
    DEFAULT_SUPERVISE_COOLDOWN_SECONDS,
    DEFAULT_TERMINAL_STALE_SECONDS,
    DEFAULT_WAIT_READY_SECONDS,
    INVOCATION_CWD,
)
from workerctl.commands import (
    command_capture,
    command_classify,
    command_create,
    command_doctor,
    command_events,
    command_interrupt,
    command_list,
    command_nudge,
    command_status,
    command_stop,
    command_tail,
)
from workerctl.core import WorkerError
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
    create.set_defaults(func=command_create, initial_prompt=True)

    doctor = subparsers.add_parser("doctor", help="Check local dependencies and worker state.")
    doctor.add_argument("--cwd", default=str(INVOCATION_CWD), help="Target worker cwd to check.")
    doctor.set_defaults(func=command_doctor)

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

    stop = subparsers.add_parser("stop", help="Stop a worker tmux session.")
    stop.add_argument("name")
    stop.add_argument("--message", help="Optional final message to send before stopping.")
    stop.set_defaults(func=command_stop)

    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    try:
        return args.func(args)
    except WorkerError as exc:
        print(f"workerctl: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
