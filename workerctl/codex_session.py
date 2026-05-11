from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path
from typing import Any


class CodexSessionError(Exception):
    pass


def read_session_meta(path: Path) -> dict[str, Any]:
    """Return the parsed payload of the first `session_meta` record in a rollout file."""
    with open(path, "r") as fh:
        first_line = fh.readline()
    if not first_line:
        raise CodexSessionError(f"rollout file is empty: {path}")
    try:
        record = json.loads(first_line)
    except json.JSONDecodeError as exc:
        raise CodexSessionError(f"rollout file first line is not JSON: {path}") from exc
    if record.get("type") != "session_meta":
        raise CodexSessionError(f"rollout file first record is not session_meta: {path}")
    payload = record.get("payload") or {}
    if not isinstance(payload, dict):
        raise CodexSessionError(f"rollout session_meta payload is not an object: {path}")
    return payload


def _ps_children_default(pid: int) -> list[int]:
    """Return direct child pids of `pid` using pgrep -P."""
    pgrep = shutil.which("pgrep")
    if pgrep is None:
        return []
    proc = subprocess.run(
        [pgrep, "-P", str(pid)],
        capture_output=True,
        text=True,
        check=False,
    )
    if proc.returncode not in (0, 1):
        return []
    return [int(line) for line in proc.stdout.split() if line.strip().isdigit()]


def find_native_codex_pid(pid: int, *, _ps_children=_ps_children_default) -> int:
    """Walk pid's child tree once to find a native codex binary.

    The npm-installed codex CLI runs as `node /opt/homebrew/bin/codex ...` which spawns
    a native binary child that owns the rollout file handle. Return the first child if
    one exists, otherwise return `pid` unchanged.
    """
    children = _ps_children(pid)
    if not children:
        return pid
    return children[0]


def _run_lsof_default(pid: int) -> str:
    lsof = shutil.which("lsof")
    if lsof is None:
        raise CodexSessionError("lsof is not available on PATH")
    proc = subprocess.run(
        [lsof, "-p", str(pid)],
        capture_output=True,
        text=True,
        check=False,
    )
    return proc.stdout or ""


def find_rollout_path_for_pid(pid: int, *, _run_lsof=_run_lsof_default) -> Path:
    """Return the rollout JSONL file `pid` holds open for writes.

    Raises CodexSessionError when no rollout file is open (e.g. ephemeral session
    or non-codex pid).
    """
    output = _run_lsof(pid)
    for line in output.splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        if not stripped.endswith(".jsonl"):
            # Cheap path filter; full match is via the last whitespace-delimited token.
            continue
        parts = stripped.rsplit(None, 1)
        if len(parts) < 2:
            continue
        path = parts[-1]
        if "/rollout-" in path and path.endswith(".jsonl"):
            return Path(path)
    raise CodexSessionError(f"no rollout-*.jsonl file open for pid {pid}")


def discover_session(
    *,
    pid: int,
    _ps_children=_ps_children_default,
    _run_lsof=_run_lsof_default,
) -> dict[str, Any]:
    """End-to-end discovery: walk pid tree, find rollout, parse session_meta.

    Returns a dict with keys: `pid`, `native_pid`, `codex_session_path`,
    `codex_session_id`, `cwd`, `originator`, `cli_version`.
    Raises CodexSessionError on any failure.
    """
    native_pid = find_native_codex_pid(pid, _ps_children=_ps_children)
    rollout = find_rollout_path_for_pid(native_pid, _run_lsof=_run_lsof)
    meta = read_session_meta(rollout)
    return {
        "pid": pid,
        "native_pid": native_pid,
        "codex_session_path": str(rollout),
        "codex_session_id": meta["id"],
        "cwd": meta.get("cwd", ""),
        "originator": meta.get("originator", ""),
        "cli_version": meta.get("cli_version", ""),
    }
