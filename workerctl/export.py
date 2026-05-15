from __future__ import annotations

import argparse
import json
import zipfile
from pathlib import Path

from workerctl.audit import mutation_audit_result
from workerctl.core import now_iso
from workerctl.db import connect as connect_db
from workerctl.db import initialize_database
from workerctl.db import task_audit
from workerctl.db import task_status_snapshot
from workerctl.replay import replay_entries
from workerctl.state import state_root, write_json


def task_artifact_dir(task_id: str) -> Path:
    return state_root() / "artifacts" / "tasks" / task_id


def command_export_task(args: argparse.Namespace) -> int:
    db_path = Path(args.path).expanduser().resolve() if args.path else None
    with connect_db(db_path) as conn:
        initialize_database(conn)
        snapshot = task_status_snapshot(conn, task=args.task)
        audit = task_audit(conn, task=args.task)
        mutation_audit = mutation_audit_result(audit)
        replay = {
            "entries": replay_entries(audit, role="all", mode="timeline"),
            "mode": "timeline",
            "role": "all",
            "task": audit["task"],
        }
        full_replay = {
            "entries": replay_entries(audit, role="all", mode="full-transcript"),
            "mode": "full-transcript",
            "role": "all",
            "task": audit["task"],
        } if getattr(args, "include_full_transcripts", False) else None
        prompt_rows = conn.execute(
            """
            select id, kind, content, content_sha256, generator_version,
                   source_snapshot_json, policy_json, artifact_path, created_at
            from prompts
            where task_id = ?
            order by id
            """,
            (snapshot["id"],),
        ).fetchall()
        capture_rows = conn.execute(
            """
            select transcript_captures.*
            from transcript_captures
            join bindings on bindings.worker_id = transcript_captures.worker_id
            where bindings.task_id = ?
            order by transcript_captures.id
            """,
            (snapshot["id"],),
        ).fetchall()
    export_root = Path(args.output).expanduser().resolve() if args.output else task_artifact_dir(snapshot["id"]) / "export"
    export_root.mkdir(parents=True, exist_ok=True)
    prompts = [
        {
            "artifact_path": row["artifact_path"],
            "content": row["content"],
            "content_sha256": row["content_sha256"],
            "created_at": row["created_at"],
            "generator_version": row["generator_version"],
            "id": row["id"],
            "kind": row["kind"],
            "policy": json.loads(row["policy_json"]),
            "source_snapshot": json.loads(row["source_snapshot_json"]),
        }
        for row in prompt_rows
    ]
    captures = [dict(row) for row in capture_rows]
    write_json(export_root / "task-status.json", snapshot)
    write_json(export_root / "audit.json", audit)
    write_json(export_root / "acceptance-criteria.json", audit.get("acceptance_criteria", []))
    write_json(export_root / "prompts.json", prompts)
    write_json(export_root / "transcript-captures.json", captures)
    write_json(export_root / "terminal-captures.json", audit.get("terminal_captures", []))
    if getattr(args, "include_transcripts", False) or getattr(args, "include_full_transcripts", False):
        write_json(export_root / "transcript-segments.json", audit.get("transcript_segments", []))
    if getattr(args, "include_full_transcripts", False):
        transcripts_dir = export_root / "transcripts"
        transcripts_dir.mkdir(exist_ok=True)
        for role in ("worker", "manager"):
            lines = []
            for segment in audit.get("transcript_segments", []):
                if segment["role"] != role:
                    continue
                lines.append(f"--- {role} segment {segment['id']} {segment['captured_at']} ({segment['segment_kind']}) ---")
                lines.append(segment.get("segment_text") or "[metadata only]")
            (transcripts_dir / f"{role}.txt").write_text("\n".join(lines) + ("\n" if lines else ""))
        write_json(export_root / "replay-full-transcript.json", full_replay)
    write_json(export_root / "agent-observations.json", audit.get("agent_observations", []))
    write_json(export_root / "manager-cycles.json", audit.get("manager_cycles", []))
    write_json(export_root / "manager-decisions.json", audit.get("manager_decisions", []))
    write_json(export_root / "mutation-audit.json", mutation_audit)
    write_json(export_root / "replay.json", replay)
    manifest = {
        "created_at": now_iso(),
        "files": [
            "task-status.json",
            "audit.json",
            "acceptance-criteria.json",
            "prompts.json",
            "transcript-captures.json",
            "terminal-captures.json",
            "agent-observations.json",
            "manager-cycles.json",
            "manager-decisions.json",
            "mutation-audit.json",
            "replay.json",
        ],
        "task": {"id": snapshot["id"], "name": snapshot["name"]},
    }
    if getattr(args, "include_transcripts", False) or getattr(args, "include_full_transcripts", False):
        manifest["files"].append("transcript-segments.json")
    if getattr(args, "include_full_transcripts", False):
        manifest["files"].extend(["replay-full-transcript.json", "transcripts/worker.txt", "transcripts/manager.txt"])
    write_json(export_root / "manifest.json", manifest)
    archive_path = None
    if args.zip:
        archive_path = export_root.with_suffix(".zip")
        with zipfile.ZipFile(archive_path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            for file_name in manifest["files"] + ["manifest.json"]:
                archive.write(export_root / file_name, arcname=file_name)
    result = {"archive": str(archive_path) if archive_path else None, "export_dir": str(export_root), "task": snapshot["name"]}
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0
