from __future__ import annotations

import shutil
import subprocess
from datetime import datetime, timezone


class WorkerError(RuntimeError):
    pass


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


def run(args: list[str], *, check: bool = True, input_text: str | None = None) -> subprocess.CompletedProcess[str]:
    proc = subprocess.run(
        args,
        input=input_text,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if check and proc.returncode != 0:
        detail = proc.stderr.strip() or proc.stdout.strip() or f"exit code {proc.returncode}"
        raise WorkerError(f"{' '.join(args)} failed: {detail}")
    return proc


def sh_quote(value: str) -> str:
    return "'" + value.replace("'", "'\"'\"'") + "'"

