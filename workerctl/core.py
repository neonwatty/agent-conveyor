from __future__ import annotations

import shutil
import subprocess
from datetime import datetime, timezone


class WorkerError(RuntimeError):
    pass


TMUX_PERMISSION_MARKERS = (
    "operation not permitted",
    "permission denied",
    "not authorized",
    "not authorised",
)


def now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def parse_iso(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def age_seconds(value: str | None) -> int | None:
    parsed = parse_iso(value)
    if parsed is None:
        return None
    return max(0, int((datetime.now(timezone.utc) - parsed).total_seconds()))


def ensure_tool(name: str) -> str:
    path = shutil.which(name)
    if not path:
        raise WorkerError(f"Required tool not found on PATH: {name}")
    return path


def is_tmux_permission_error(detail: str) -> bool:
    lowered = detail.lower()
    return any(marker in lowered for marker in TMUX_PERMISSION_MARKERS)


def tmux_permission_error_message(detail: str) -> str:
    detail = detail.strip() or "permission denied"
    return (
        "tmux access was denied by the operating system or sandbox: "
        f"{detail}. Retry from a terminal/session with tmux PTY permissions; "
        "on macOS, grant the terminal app appropriate Privacy & Security access "
        "and restart the terminal/tmux server."
    )


def raise_for_tmux_permission_failure(proc) -> None:
    if proc.returncode == 0:
        return
    detail = (proc.stderr or proc.stdout or "").strip()
    if is_tmux_permission_error(detail):
        raise WorkerError(tmux_permission_error_message(detail))


def command_failure_message(args: list[str], detail: str) -> str:
    command = " ".join(args)
    if args and args[0] == "tmux" and is_tmux_permission_error(detail):
        return f"{command} failed: {tmux_permission_error_message(detail)}"
    return f"{command} failed: {detail}"


def run(args: list[str], *, check: bool = True, input_text: str | None = None) -> subprocess.CompletedProcess[str]:
    try:
        proc = subprocess.run(
            args,
            input=input_text,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )
    except FileNotFoundError as exc:
        tool = args[0] if args else "<empty command>"
        if tool == "tmux":
            raise WorkerError("tmux is not installed or is not available on PATH") from exc
        raise WorkerError(f"Required tool not found on PATH: {tool}") from exc
    except PermissionError as exc:
        tool = args[0] if args else "<empty command>"
        detail = str(exc)
        if tool == "tmux":
            raise WorkerError(tmux_permission_error_message(detail)) from exc
        raise WorkerError(f"{tool} could not be executed: {detail}") from exc
    if check and proc.returncode != 0:
        detail = proc.stderr.strip() or proc.stdout.strip() or f"exit code {proc.returncode}"
        raise WorkerError(command_failure_message(args, detail))
    return proc


def sh_quote(value: str) -> str:
    return "'" + value.replace("'", "'\"'\"'") + "'"
