import argparse
import contextlib
import io
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import time
import unittest
import zipfile
from pathlib import Path
from unittest import mock

from workerctl import classify
from workerctl import commands
from workerctl import criteria_plan
from workerctl import core as worker_core
from workerctl import db as worker_db
from workerctl import importer
from workerctl import identity as worker_identity
from workerctl import lifecycle
from workerctl import tmux as worker_tmux
from workerctl.core import WorkerError
from workerctl.state import (
    append_event,
    capture_meta_path,
    config_path,
    latest_status,
    status_path,
    transcript_path,
    worker_contract,
    worker_dir,
    write_json,
)


ROOT = Path(__file__).resolve().parents[1]
WORKERCTL_PATH = ROOT / "scripts" / "workerctl"
WORKERCTL_SHIM_PATH = ROOT / "bin" / "workerctl"
INSTALL_LOCAL_PATH = ROOT / "scripts" / "install-local"


class CoreRunTests(unittest.TestCase):
    def test_tmux_permission_failure_gets_actionable_message(self):
        def fake_run(argv, **kwargs):
            return subprocess.CompletedProcess(argv, 1, "", "Operation not permitted\n")

        with mock.patch("workerctl.core.subprocess.run", side_effect=fake_run):
            with self.assertRaisesRegex(WorkerError, "tmux access was denied"):
                worker_core.run(["tmux", "new-session", "-d", "-s", "blocked"])

        with mock.patch("workerctl.core.subprocess.run", side_effect=fake_run):
            try:
                worker_core.run(["tmux", "new-session", "-d", "-s", "blocked"])
            except WorkerError as exc:
                self.assertIn("Privacy & Security", str(exc))
                self.assertIn("Operation not permitted", str(exc))


class DatabaseTests(unittest.TestCase):
    def open_db(self, tmpdir):
        path = Path(tmpdir) / "workerctl.db"
        conn = worker_db.connect(path)
        worker_db.initialize_database(conn)
        self.addCleanup(conn.close)
        return conn

    def insert_worker(self, conn, worker_id="worker-1", name="worker-a"):
        now = "2026-05-08T10:00:00Z"
        conn.execute(
            """
            insert into workers(
              id, name, tmux_session, identity_token, cwd, state, created_at, updated_at
            )
            values (?, ?, ?, ?, ?, 'candidate', ?, ?)
            """,
            (worker_id, name, f"codex-{name}", f"token-{worker_id}", str(ROOT), now, now),
        )

    def insert_task(self, conn, task_id="task-1", name="task-a"):
        now = "2026-05-08T10:00:00Z"
        conn.execute(
            """
            insert into tasks(id, name, goal, state, created_at, updated_at)
            values (?, ?, 'goal', 'candidate', ?, ?)
            """,
            (task_id, name, now, now),
        )

    def test_database_initializes_schema_and_pragmas(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)

            foreign_keys = conn.execute("PRAGMA foreign_keys").fetchone()[0]
            busy_timeout = conn.execute("PRAGMA busy_timeout").fetchone()[0]
            version = conn.execute("select max(version) from schema_migrations").fetchone()[0]
            user_version = conn.execute("PRAGMA user_version").fetchone()[0]

            self.assertEqual(foreign_keys, 1)
            self.assertEqual(busy_timeout, 5000)
            self.assertEqual(version, worker_db.SCHEMA_VERSION)
            self.assertEqual(user_version, worker_db.SCHEMA_VERSION)

    def test_database_refuses_newer_user_version(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "workerctl.db"
            conn = worker_db.connect(path)
            self.addCleanup(conn.close)
            conn.execute(f"PRAGMA user_version = {worker_db.SCHEMA_VERSION + 1}")

            with self.assertRaises(RuntimeError):
                worker_db.initialize_database(conn)

    def test_database_health_reports_ok(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)

            health = worker_db.database_health(conn)

            self.assertTrue(health["ok"])
            checks = {check["name"]: check for check in health["checks"]}
            self.assertTrue(checks["foreign_keys"]["ok"])
            self.assertTrue(checks["user_version"]["ok"])
            self.assertTrue(checks["required_tables"]["ok"])
            self.assertTrue(checks["required_indexes"]["ok"])
            self.assertTrue(checks["required_triggers"]["ok"])
            index_checks = {
                "events_task_id",
                "commands_task_state_created",
                "statuses_worker_id",
                "transcript_captures_worker_id",
            }
            indexes = {
                row["name"]
                for row in conn.execute("select name from sqlite_master where type = 'index' and name not like 'sqlite_%'")
            }
            self.assertTrue(index_checks <= indexes)

    def test_foreign_keys_are_enforced(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)

            with self.assertRaises(sqlite3.IntegrityError):
                conn.execute(
                    """
                    insert into statuses(worker_id, state, created_at)
                    values ('missing-worker', 'waiting', '2026-05-08T10:00:00Z')
                    """
                )

    def test_state_check_constraints_are_enforced(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)

            with self.assertRaises(sqlite3.IntegrityError):
                conn.execute(
                    """
                    insert into tasks(id, name, goal, state, created_at, updated_at)
                    values ('task-1', 'task-a', 'goal', 'manged', '2026-05-08T10:00:00Z', '2026-05-08T10:00:00Z')
                    """
                )

    def test_active_binding_uniqueness_is_enforced(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)
            self.insert_worker(conn)
            self.insert_task(conn, "task-1", "task-a")
            self.insert_task(conn, "task-2", "task-b")

            conn.execute(
                """
                insert into bindings(id, task_id, worker_id, state, created_at)
                values ('binding-1', 'task-1', 'worker-1', 'active', '2026-05-08T10:00:00Z')
                """
            )
            with self.assertRaises(sqlite3.IntegrityError):
                conn.execute(
                    """
                    insert into bindings(id, task_id, worker_id, state, created_at)
                    values ('binding-2', 'task-2', 'worker-1', 'active', '2026-05-08T10:00:00Z')
                    """
                )

            conn.execute("update bindings set state = 'ended', ended_at = '2026-05-08T10:01:00Z' where id = 'binding-1'")
            conn.execute(
                """
                insert into bindings(id, task_id, worker_id, state, created_at)
                values ('binding-2', 'task-2', 'worker-1', 'active', '2026-05-08T10:02:00Z')
                """
            )

    def test_budget_check_constraints_are_enforced(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)
            self.insert_task(conn)

            with self.assertRaises(sqlite3.IntegrityError):
                conn.execute(
                    """
                    insert into budgets(task_id, max_nudges, nudges_used, expires_at)
                    values ('task-1', 3, 4, '2026-05-08T10:30:00Z')
                    """
                )

    def test_events_are_append_only(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)
            event_id = worker_db.insert_event(conn, "schema_test", actor="test", payload={"ok": True})
            conn.commit()

            with self.assertRaises(sqlite3.DatabaseError):
                conn.execute("update events set type = 'changed' where id = ?", (event_id,))
            with self.assertRaises(sqlite3.DatabaseError):
                conn.execute("delete from events where id = ?", (event_id,))

    def test_latest_status_reads_sqlite_when_available(self):
        name = "db-latest-status"
        worker_path = worker_dir(name)
        if worker_path.exists():
            shutil.rmtree(worker_path)
        worker_path.mkdir(parents=True)
        status_path(name).write_text(
            json.dumps(
                {
                    "blocker": None,
                    "current_task": "json task",
                    "last_update": "2026-05-08T09:00:00Z",
                    "next_action": "json next",
                    "state": "waiting",
                }
            )
            + "\n"
        )
        original_default_db_path = worker_db.default_db_path
        try:
            with tempfile.TemporaryDirectory() as tmpdir:
                db_path = Path(tmpdir) / "workerctl.db"
                worker_db.default_db_path = lambda: db_path
                with worker_db.connect(db_path) as conn:
                    worker_db.initialize_database(conn)
                    worker_id = worker_db.upsert_worker(
                        conn,
                        name=name,
                        cwd=str(ROOT),
                        tmux_session=f"codex-{name}",
                        state="active",
                    )
                    worker_db.insert_status(
                        conn,
                        worker_id=worker_id,
                        status={
                            "blocker": "db blocker",
                            "current_task": "db task",
                            "next_action": "db next",
                            "state": "blocked",
                        },
                        timestamp="2026-05-08T10:00:00Z",
                    )
                    conn.commit()

                status = latest_status(name)

                self.assertEqual(status["state"], "blocked")
                self.assertEqual(status["current_task"], "db task")
                self.assertEqual(status["next_action"], "db next")
                self.assertEqual(status["blocker"], "db blocker")
                self.assertEqual(status["last_update"], "2026-05-08T10:00:00Z")
        finally:
            worker_db.default_db_path = original_default_db_path
            if worker_path.exists():
                shutil.rmtree(worker_path)

    def test_latest_status_falls_back_to_json(self):
        name = "json-latest-status"
        worker_path = worker_dir(name)
        if worker_path.exists():
            shutil.rmtree(worker_path)
        worker_path.mkdir(parents=True)
        status_path(name).write_text(
            json.dumps(
                {
                    "blocker": None,
                    "current_task": "json task",
                    "last_update": "2026-05-08T09:00:00Z",
                    "next_action": "json next",
                    "state": "waiting",
                }
            )
            + "\n"
        )
        original_default_db_path = worker_db.default_db_path
        try:
            with tempfile.TemporaryDirectory() as tmpdir:
                worker_db.default_db_path = lambda: Path(tmpdir) / "missing.db"

                status = latest_status(name)

                self.assertEqual(status["state"], "waiting")
                self.assertEqual(status["current_task"], "json task")
        finally:
            worker_db.default_db_path = original_default_db_path
            if worker_path.exists():
                shutil.rmtree(worker_path)

    def test_worker_handoff_round_trips(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)
            task_id = worker_db.create_task(conn, name="task-a", goal="Do task A.")

            handoff_id = worker_db.insert_worker_handoff(
                conn,
                task_id=task_id,
                summary="Implemented parser skeleton.",
                next_steps=["Run tests", "Fill error handling"],
                payload={"branch": "feature/parser"},
                timestamp="2026-05-08T10:00:00Z",
            )
            conn.commit()

            handoff = worker_db.latest_worker_handoff(conn, task_id=task_id)
            self.assertEqual(handoff["id"], handoff_id)
            self.assertEqual(handoff["summary"], "Implemented parser skeleton.")
            self.assertEqual(handoff["next_steps"], ["Run tests", "Fill error handling"])
            self.assertEqual(handoff["payload"], {"branch": "feature/parser"})

    def test_manager_config_round_trips(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)
            task_id = worker_db.create_task(conn, name="task-a", goal="Do task A.")

            worker_db.upsert_manager_config(
                conn,
                task_id=task_id,
                supervision_mode="strict",
                objective="Check against PRD.",
                guidelines=["Nudge only when stale"],
                acceptance_criteria=["Tests pass"],
                reference_paths=["docs/prd.md"],
                permissions={"create_pr": True, "merge_green_pr": False},
                timestamp="2026-05-08T10:00:00Z",
            )
            conn.commit()

            config = worker_db.manager_config(conn, task_id=task_id)
            self.assertEqual(config["supervision_mode"], "strict")
            self.assertEqual(config["objective"], "Check against PRD.")
            self.assertEqual(config["guidelines"], ["Nudge only when stale"])
            self.assertEqual(config["acceptance_criteria"], ["Tests pass"])
            self.assertEqual(config["reference_paths"], ["docs/prd.md"])
            self.assertEqual(config["permissions"]["create_pr"], True)

    def test_create_and_list_tasks(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)
            task_id = worker_db.create_task(
                conn,
                name="auth-refactor",
                goal="Finish auth refactor.",
                summary="Middleware replaced.",
                task_id="task-auth",
                timestamp="2026-05-08T10:00:00Z",
            )
            conn.commit()

            tasks = worker_db.list_tasks(conn)
            active_tasks = worker_db.list_tasks(conn, active_only=True)

            self.assertEqual(task_id, "task-auth")
            self.assertEqual(len(tasks), 1)
            self.assertEqual(tasks[0]["id"], "task-auth")
            self.assertEqual(tasks[0]["name"], "auth-refactor")
            self.assertEqual(tasks[0]["state"], "candidate")
            self.assertEqual(tasks[0]["budget"], None)
            self.assertEqual(active_tasks[0]["id"], "task-auth")
            event = conn.execute("select * from events where task_id = ?", ("task-auth",)).fetchone()
            self.assertEqual(event["type"], "task_created")

    def test_upsert_worker_uses_opaque_id_separate_from_name(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)
            worker_id = worker_db.upsert_worker(
                conn,
                name="worker-a",
                cwd=str(ROOT),
                tmux_session="codex-worker-a",
                state="active",
            )
            second_id = worker_db.upsert_worker(
                conn,
                name="worker-a",
                cwd=str(ROOT),
                tmux_session="codex-worker-a",
                state="active",
            )
            row = conn.execute("select id, name from workers where name = 'worker-a'").fetchone()

            self.assertEqual(worker_id, second_id)
            self.assertEqual(row["id"], worker_id)
            self.assertEqual(row["name"], "worker-a")
            self.assertNotEqual(worker_id, "worker-a")
            self.assertTrue(worker_id.startswith("worker-"))

    def test_worker_id_migration_rewrites_legacy_foreign_keys(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)
            now = "2026-05-08T10:00:00Z"
            conn.execute("drop trigger if exists events_no_update")
            conn.execute("drop trigger if exists events_no_delete")
            conn.execute("delete from events")
            conn.execute("delete from commands")
            conn.execute("delete from transcript_captures")
            conn.execute("delete from statuses")
            conn.execute("delete from bindings")
            conn.execute("delete from workers")
            conn.execute(
                """
                insert into workers(id, name, tmux_session, identity_token, cwd, state, created_at, updated_at)
                values ('worker-a', 'worker-a', 'codex-worker-a', 'token-worker-a', ?, 'active', ?, ?)
                """,
                (str(ROOT), now, now),
            )
            task_id = worker_db.create_task(conn, name="task-a", goal="Do task A.", timestamp=now)
            conn.execute("insert into bindings(id, task_id, worker_id, state, created_at) values ('binding-1', ?, 'worker-a', 'active', ?)", (task_id, now))
            conn.execute("insert into statuses(worker_id, state, created_at) values ('worker-a', 'planning', ?)", (now,))
            conn.execute(
                """
                insert into transcript_captures(worker_id, sha256, captured_at, changed_at, history_lines, byte_count, line_count, capture_kind, retention_class)
                values ('worker-a', 'digest', ?, ?, 10, 0, 0, 'latest', 'hot')
                """,
                (now, now),
            )
            conn.execute(
                """
                insert into commands(id, idempotency_key, created_at, updated_at, task_id, worker_id, type, state, payload_json)
                values ('command-1', 'key-1', ?, ?, ?, 'worker-a', 'task_nudge', 'pending', '{}')
                """,
                (now, now, task_id),
            )
            conn.execute(
                "insert into events(created_at, actor, task_id, worker_id, type, payload_json) values (?, 'workerctl', ?, 'worker-a', 'legacy_event', '{}')",
                (now, task_id),
            )
            conn.commit()

            worker_db.migrate_worker_name_ids(conn)

            worker = conn.execute("select id, name from workers where name = 'worker-a'").fetchone()
            worker_id = worker["id"]
            refs = {
                "bindings": conn.execute("select worker_id from bindings").fetchone()["worker_id"],
                "statuses": conn.execute("select worker_id from statuses").fetchone()["worker_id"],
                "transcript_captures": conn.execute("select worker_id from transcript_captures").fetchone()["worker_id"],
                "commands": conn.execute("select worker_id from commands").fetchone()["worker_id"],
            }
            event_ids = [row["worker_id"] for row in conn.execute("select worker_id from events where worker_id is not null order by id")]

            self.assertNotEqual(worker_id, "worker-a")
            self.assertTrue(worker_id.startswith("worker-"))
            self.assertEqual(set(refs.values()), {worker_id})
            self.assertTrue(all(event_id == worker_id for event_id in event_ids))

    def test_bind_task_worker_enforces_active_worker_uniqueness(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)
            worker_db.upsert_worker(
                conn,
                name="worker-a",
                cwd=str(ROOT),
                tmux_session="codex-worker-a",
                tmux_pane_id="%1",
                state="active",
                timestamp="2026-05-08T10:00:00Z",
            )
            self.insert_task(conn, "task-1", "task-a")
            self.insert_task(conn, "task-2", "task-b")

            binding_id = worker_db.bind_task_worker(
                conn,
                task="task-a",
                worker="worker-a",
                binding_id="binding-1",
                timestamp="2026-05-08T10:00:00Z",
            )
            with self.assertRaises(WorkerError):
                worker_db.bind_task_worker(conn, task="task-b", worker="worker-a", binding_id="binding-2")

            self.assertEqual(binding_id, "binding-1")
            binding = conn.execute("select * from bindings where id = 'binding-1'").fetchone()
            self.assertEqual(binding["state"], "active")
            event = conn.execute("select * from events where task_id = 'task-1' order by id desc limit 1").fetchone()
            self.assertEqual(event["type"], "worker_bound")

    def test_task_status_snapshot_includes_worker_and_latest_status(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)
            self.insert_worker(conn, "worker-1", "worker-a")
            conn.execute("update workers set tmux_pane_id = '%1' where id = 'worker-1'")
            self.insert_task(conn, "task-1", "task-a")
            worker_db.bind_task_worker(
                conn,
                task="task-a",
                worker="worker-a",
                binding_id="binding-1",
                timestamp="2026-05-08T10:00:00Z",
            )
            worker_db.insert_status(
                conn,
                worker_id="worker-1",
                status={
                    "blocker": None,
                    "current_task": "Implement task status.",
                    "next_action": "Run tests.",
                    "state": "editing",
                },
                timestamp="2026-05-08T10:01:00Z",
            )
            conn.commit()

            snapshot = worker_db.task_status_snapshot(conn, task="task-a")

            self.assertEqual(snapshot["id"], "task-1")
            self.assertEqual(snapshot["name"], "task-a")
            self.assertEqual(snapshot["worker"]["name"], "worker-a")
            self.assertEqual(snapshot["worker"]["binding_id"], "binding-1")
            self.assertEqual(snapshot["worker"]["tmux_pane_id"], "%1")
            self.assertEqual(snapshot["worker_status"]["state"], "editing")
            self.assertEqual(snapshot["worker_status"]["current_task"], "Implement task status.")

    def test_active_task_worker_resolves_active_binding(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)
            self.insert_worker(conn, "worker-1", "worker-a")
            self.insert_task(conn, "task-1", "task-a")
            worker_db.bind_task_worker(
                conn,
                task="task-a",
                worker="worker-a",
                binding_id="binding-1",
                timestamp="2026-05-08T10:00:00Z",
            )
            conn.commit()

            binding = worker_db.active_task_worker(conn, task="task-a")

            self.assertEqual(binding["binding_id"], "binding-1")
            self.assertEqual(binding["task_id"], "task-1")
            self.assertEqual(binding["worker_name"], "worker-a")

    def test_active_task_worker_requires_binding(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)
            self.insert_task(conn, "task-1", "task-a")

            with self.assertRaises(WorkerError):
                worker_db.active_task_worker(conn, task="task-a")

    def test_command_lifecycle_records_result(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)
            command_id = worker_db.create_command(
                conn,
                command_type="task_nudge",
                payload={"message": "status"},
                idempotency_key="key-1",
                timestamp="2026-05-08T10:00:00Z",
            )
            worker_db.mark_command_attempted(conn, command_id=command_id, timestamp="2026-05-08T10:01:00Z")
            worker_db.finish_command(
                conn,
                command_id=command_id,
                state="succeeded",
                result={"sent": True},
                timestamp="2026-05-08T10:02:00Z",
            )
            conn.commit()

            row = conn.execute("select * from commands where id = ?", (command_id,)).fetchone()

            self.assertEqual(row["state"], "succeeded")
            self.assertEqual(json.loads(row["payload_json"]), {"message": "status"})
            self.assertEqual(json.loads(row["result_json"]), {"sent": True})

    def test_reserve_nudge_budget_enforces_limit(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)
            self.insert_task(conn, "task-1", "task-a")
            worker_db.set_budget(
                conn,
                task_id="task-1",
                max_nudges=1,
                expires_at="2026-05-08T11:00:00Z",
            )

            budget = worker_db.reserve_nudge_budget(
                conn,
                task_id="task-1",
                timestamp="2026-05-08T10:00:00Z",
            )

            self.assertEqual(budget["nudges_used"], 1)
            self.assertEqual(budget["nudges_remaining"], 0)
            with self.assertRaises(WorkerError):
                worker_db.reserve_nudge_budget(conn, task_id="task-1", timestamp="2026-05-08T10:01:00Z")

    def test_manager_helpers_attach_to_status_snapshot(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)
            self.insert_worker(conn, "worker-1", "worker-a")
            self.insert_task(conn, "task-1", "task-a")
            worker_db.bind_task_worker(conn, task="task-a", worker="worker-a", binding_id="binding-1")
            manager_id = worker_db.create_manager(
                conn,
                task_id="task-1",
                name="manager-a",
                tmux_session="codex-manager-task-a",
                tmux_pane_id="%2",
                codex_args=["--model", "test"],
                state="ready",
            )
            worker_db.attach_manager_to_binding(conn, task_id="task-1", manager_id=manager_id)
            conn.commit()

            snapshot = worker_db.task_status_snapshot(conn, task="task-a")

            self.assertEqual(snapshot["manager"]["id"], manager_id)
            self.assertEqual(snapshot["manager"]["state"], "ready")
            self.assertEqual(snapshot["manager"]["tmux_pane_id"], "%2")
            self.assertEqual(snapshot["manager"]["codex_args"], ["--model", "test"])

    def test_task_audit_returns_events_and_commands(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)
            self.insert_task(conn, "task-1", "task-a")
            command_id = worker_db.create_command(
                conn,
                command_type="task_nudge",
                payload={"message": "status"},
                task_id="task-1",
            )
            worker_db.finish_command(conn, command_id=command_id, state="succeeded", result={"sent": True})
            worker_db.insert_event(
                conn,
                "task_nudge_succeeded",
                actor="test",
                command_id=command_id,
                task_id="task-1",
                payload={"sent": True},
            )
            conn.commit()

            audit = worker_db.task_audit(conn, task="task-a")

            self.assertEqual(audit["task"]["id"], "task-1")
            self.assertEqual(audit["commands"][0]["id"], command_id)
            self.assertEqual(audit["commands"][0]["result"], {"sent": True})
            self.assertEqual(audit["events"][0]["type"], "task_nudge_succeeded")


class ContractTests(unittest.TestCase):
    def test_worker_contract_uses_update_status_command(self):
        contract = worker_contract("worker-a", "Do the task.")

        self.assertIn("workerctl update-status worker-a", contract)
        self.assertIn("--state planning", contract)
        self.assertIn("--blocker", contract)
        self.assertIn("compatibility file", contract)
        self.assertIn(".codex-workers/worker-a/status.json", contract)


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

    def test_classifier_suppresses_long_running_interruptible_with_recent_events(self):
        # status_age high (would normally trigger long_running_interruptible),
        # but recent_event_count is also high — worker is healthy, suppress flag.
        result = classify.classify_busy_wait(
            "running tests... esc to interrupt",
            status_age=300,
            busy_wait_seconds=60,
            recent_event_count=133,
        )
        # With high recent_event_count, the pattern should be suppressed (None).
        self.assertIsNone(result)

    def test_classifier_still_flags_long_running_interruptible_when_event_count_low(self):
        result = classify.classify_busy_wait(
            "running tests... esc to interrupt",
            status_age=300,
            busy_wait_seconds=60,
            recent_event_count=2,
        )
        self.assertEqual(result.get("pattern"), "long_running_interruptible")


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

    def test_session_snapshot_reports_missing_when_tmux_unavailable(self):
        original_which = worker_identity.shutil.which
        try:
            worker_identity.shutil.which = lambda name: None if name == "tmux" else original_which(name)

            snapshot = worker_identity.session_snapshot("missing-tmux-session")

            self.assertEqual(snapshot, {"live": False, "pane_id": None, "session": "missing-tmux-session"})
        finally:
            worker_identity.shutil.which = original_which

    def test_session_snapshot_raises_on_tmux_permission_denied(self):
        original_which = worker_identity.shutil.which
        original_run = worker_identity.run
        try:
            worker_identity.shutil.which = lambda name: "/usr/bin/tmux" if name == "tmux" else original_which(name)
            worker_identity.run = lambda argv, **kwargs: subprocess.CompletedProcess(
                argv, 1, "", "Operation not permitted\n"
            )

            with self.assertRaisesRegex(WorkerError, "tmux access was denied"):
                worker_identity.session_snapshot("blocked-tmux-session")
        finally:
            worker_identity.shutil.which = original_which
            worker_identity.run = original_run

    def test_list_json_outputs_json_array(self):
        proc = self.run_workerctl("list", "--json")

        self.assertEqual(proc.returncode, 0, proc.stderr)
        data = json.loads(proc.stdout)
        self.assertIsInstance(data, list)

    def test_list_json_reports_tmux_permission_error_without_failing(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            state_dir = Path(tmpdir) / "state"
            worker_path = state_dir / "worker-a"
            worker_path.mkdir(parents=True)
            (worker_path / "config.json").write_text(json.dumps({"name": "worker-a"}) + "\n")
            (worker_path / "status.json").write_text(json.dumps({"state": "waiting"}) + "\n")
            original_root = os.environ.get("WORKERCTL_STATE_ROOT")
            original_session_exists = commands.session_exists
            try:
                os.environ["WORKERCTL_STATE_ROOT"] = str(state_dir)

                def permission_denied(_name):
                    raise WorkerError("tmux access was denied by the operating system or sandbox")

                commands.session_exists = permission_denied
                with contextlib.redirect_stdout(io.StringIO()) as stdout:
                    result = commands.command_list(argparse.Namespace(json=True))

                payload = json.loads(stdout.getvalue())
                self.assertEqual(result, 0)
                self.assertEqual(payload[0]["running"], False)
                self.assertIn("tmux access was denied", payload[0]["terminal_error"])
            finally:
                commands.session_exists = original_session_exists
                if original_root is None:
                    os.environ.pop("WORKERCTL_STATE_ROOT", None)
                else:
                    os.environ["WORKERCTL_STATE_ROOT"] = original_root

    def test_status_reports_tmux_permission_error_without_failing(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            state_dir = Path(tmpdir) / "state"
            worker_path = state_dir / "worker-a"
            worker_path.mkdir(parents=True)
            (worker_path / "config.json").write_text(
                json.dumps({"name": "worker-a", "tmux_session": "codex-worker-a"}) + "\n"
            )
            (worker_path / "status.json").write_text(json.dumps({"state": "waiting"}) + "\n")
            original_root = os.environ.get("WORKERCTL_STATE_ROOT")
            original_session_exists = commands.session_exists
            try:
                os.environ["WORKERCTL_STATE_ROOT"] = str(state_dir)

                def permission_denied(_name):
                    raise WorkerError("tmux access was denied by the operating system or sandbox")

                commands.session_exists = permission_denied
                args = argparse.Namespace(name="worker-a", refresh=False, lines=80)
                with contextlib.redirect_stdout(io.StringIO()) as stdout:
                    result = commands.command_status(args)

                payload = json.loads(stdout.getvalue())
                self.assertEqual(result, 0)
                self.assertEqual(payload["running"], False)
                self.assertIn("tmux access was denied", payload["terminal_capture_error"])
            finally:
                commands.session_exists = original_session_exists
                if original_root is None:
                    os.environ.pop("WORKERCTL_STATE_ROOT", None)
                else:
                    os.environ["WORKERCTL_STATE_ROOT"] = original_root

    def test_doctor_outputs_expected_structure(self):
        proc = self.run_workerctl("doctor")

        data = json.loads(proc.stdout)
        self.assertIn("checks", data)
        self.assertIn("workers", data)
        self.assertTrue(any(check["name"] == "tmux" for check in data["checks"]))
        self.assertTrue(any(check["name"] == "codex" for check in data["checks"]))

    def test_doctor_self_reports_new_path_template_inside_tmux(self):
        original_current_session_name = commands.current_session_name
        original_which = commands.shutil.which
        original_run = commands.run
        original_env = os.environ.copy()
        try:
            with tempfile.TemporaryDirectory() as tmpdir:
                skill_dir = Path(tmpdir) / "skills" / "manage-codex-workers"
                skill_dir.mkdir(parents=True)
                (skill_dir / "SKILL.md").write_text("skill")
                os.environ["CODEX_HOME"] = tmpdir
                commands.current_session_name = lambda: "plain-codex"
                commands.shutil.which = lambda name: f"/usr/bin/{name}"
                commands.run = lambda *args, **kwargs: subprocess.CompletedProcess(args[0], 0, '{"ok": true}\n', "")
                args = argparse.Namespace(json=True, session=None)

                with contextlib.redirect_stdout(io.StringIO()) as stdout:
                    result = commands.command_doctor_self(args)

                payload = json.loads(stdout.getvalue())
                self.assertEqual(result, 0)
                self.assertTrue(payload["supported"])
                self.assertTrue(payload["ok"])
                self.assertIn("workerctl register-worker", payload["command_template"])
                self.assertIn("--name <NAME>", payload["command_template"])
                self.assertIn("--pid <PID>", payload["command_template"])
                self.assertIn("--cwd <CWD>", payload["command_template"])
                self.assertIn("--tmux-session <SESSION>", payload["command_template"])
                self.assertTrue(any("register-manager" in step for step in payload["follow_up"]))
                self.assertTrue(any("workerctl bind" in step for step in payload["follow_up"]))
                self.assertTrue(any("workerctl cycle" in step for step in payload["follow_up"]))
                self.assertIn("live tmux session", payload["why_or_why_not"])
                serialized = json.dumps(payload)
                for retired in ("become-managed", "manager-observe", "manager-decision", "close-manager", "unmanage", "remanage", "task-status", "task-health"):
                    self.assertNotIn(retired, serialized)
                # The standalone command `workerctl manage --session ...` must not appear.
                self.assertNotIn("manage --session", serialized)
        finally:
            commands.current_session_name = original_current_session_name
            commands.shutil.which = original_which
            commands.run = original_run
            os.environ.clear()
            os.environ.update(original_env)

    def test_doctor_self_fails_closed_outside_tmux(self):
        original_current_session_name = commands.current_session_name
        try:
            commands.current_session_name = lambda: None
            with contextlib.redirect_stdout(io.StringIO()) as stdout:
                result = commands.command_doctor_self(argparse.Namespace(json=True, session=None))

            payload = json.loads(stdout.getvalue())
            self.assertEqual(result, 1)
            self.assertFalse(payload["supported"])
            self.assertFalse(payload["ok"])
            self.assertIn("cannot register itself", payload["why_or_why_not"])
            self.assertIn("register-manager", payload["why_or_why_not"])
            serialized = json.dumps(payload)
            for retired in ("become-managed", "manage --session", "manager-observe", "close-manager"):
                self.assertNotIn(retired, serialized)
        finally:
            commands.current_session_name = original_current_session_name

    def test_doctor_self_reports_tmux_permission_error_as_unsupported_json(self):
        original_current_session_name = commands.current_session_name
        original_which = commands.shutil.which
        original_run = commands.run
        try:
            commands.current_session_name = lambda: (_ for _ in ()).throw(
                WorkerError("tmux access was denied by the operating system or sandbox")
            )
            commands.shutil.which = lambda name: f"/usr/bin/{name}"
            commands.run = lambda argv, **kwargs: subprocess.CompletedProcess(argv, 0, '{"ok": true}\n', "")
            with contextlib.redirect_stdout(io.StringIO()) as stdout:
                result = commands.command_doctor_self(argparse.Namespace(json=True, session=None))

            payload = json.loads(stdout.getvalue())
            self.assertEqual(result, 1)
            self.assertFalse(payload["supported"])
            self.assertTrue(any(check["name"] == "tmux_access" for check in payload["checks"]))
            self.assertIn("tmux access was denied", json.dumps(payload))
        finally:
            commands.current_session_name = original_current_session_name
            commands.shutil.which = original_which
            commands.run = original_run

    def test_qa_plan_self_management_outputs_repeatable_steps(self):
        proc = self.run_workerctl("qa-plan", "self-management", "--json")

        self.assertEqual(proc.returncode, 0, proc.stderr)
        payload = json.loads(proc.stdout)
        self.assertEqual(payload["scenario"], "self-management")
        self.assertTrue(any("register-worker" in step for step in payload["steps"]))
        self.assertTrue(any("register-manager" in step for step in payload["steps"]))
        self.assertTrue(any("workerctl bind" in step for step in payload["steps"]))
        self.assertTrue(any("workerctl cycle" in step for step in payload["steps"]))
        self.assertTrue(any("session-nudge" in step for step in payload["steps"]))
        self.assertTrue(any("workerctl reconcile" in step for step in payload["steps"]))
        self.assertTrue(any("kind, state, pane_signal" in observation for observation in payload["expected_observations"]))
        joined = " ".join(payload["steps"] + payload["expected_observations"])
        for retired in ("become-managed", "manager-observe", "manager-decision", "task-status", "task-health", "extend-nudge-budget", "task-nudge", "task-interrupt", "mutation-audit", "close-manager"):
            self.assertNotIn(retired, joined)

    def test_qa_plan_emergent_criteria_outputs_criteria_flow(self):
        proc = self.run_workerctl("qa-plan", "emergent-criteria", "--json")

        self.assertEqual(proc.returncode, 0, proc.stderr)
        payload = json.loads(proc.stdout)
        self.assertEqual(payload["scenario"], "emergent-criteria")
        self.assertTrue(any("workerctl pair" in step for step in payload["steps"]))
        self.assertTrue(any("manager_context.acceptance_criteria" in step for step in payload["steps"]))
        self.assertTrue(any("manager_context.criteria_negotiation" in step for step in payload["steps"]))
        self.assertTrue(any("worker_proposed" in step for step in payload["steps"]))
        self.assertTrue(any("criteria-plan" in step for step in payload["steps"]))
        self.assertTrue(any("manager_inferred" in step for step in payload["steps"]))
        self.assertTrue(any("criteria qa-emergent-criteria --list" in step for step in payload["steps"]))
        self.assertTrue(any("--require-criteria-audit" in step for step in payload["steps"]))
        self.assertTrue(any("--stop-manager --stop-worker" in step for step in payload["steps"]))
        self.assertTrue(any("killed_worker and killed_manager" in step for step in payload["steps"]))
        self.assertTrue(any("tmux list-sessions" in step for step in payload["steps"]))
        self.assertTrue(any("sessions --state all" in step for step in payload["steps"]))
        self.assertTrue(any("acceptance-criteria.json" in step for step in payload["steps"]))
        self.assertTrue(any("workerctl reconcile" in step for step in payload["steps"]))
        self.assertTrue(any("git status --short --branch" in step for step in payload["steps"]))
        self.assertTrue(
            any("accepted criteria block finish-task --require-criteria-audit" in observation
                for observation in payload["expected_observations"])
        )
        self.assertTrue(
            any("finish-task --stop-manager --stop-worker reports killed_worker" in observation
                for observation in payload["expected_observations"])
        )
        self.assertTrue(
            any("session rows are marked gone" in observation
                for observation in payload["expected_observations"])
        )
        self.assertTrue(
            any("criteria --list is used as the canonical task state" in observation
                for observation in payload["expected_observations"])
        )
        self.assertTrue(
            any("criteria_negotiation.needed starts true" in observation
                for observation in payload["expected_observations"])
        )
        joined = " ".join(payload["steps"] + payload["expected_observations"])
        self.assertIn("must-have current-task criteria", joined)
        self.assertIn("deferred follow-up criteria", joined)
        self.assertIn("criteria-plan can draft reviewed", joined)
        self.assertIn("acceptance_criterion_updated", joined)
        self.assertIn("status-only", joined)

    def test_criteria_plan_parser_extracts_separated_criteria(self):
        text = """
Must-have current-task criteria:
- README and workerctl help are inspected.
1. First cycle shows criteria negotiation is needed.

Deferred follow-up criteria:
- Add a future qa-run harness.
"""

        suggestions, warnings = criteria_plan.parse_worker_criteria_response(text)

        self.assertEqual(warnings, [])
        self.assertEqual([suggestion.status for suggestion in suggestions], ["accepted", "accepted", "deferred"])
        self.assertEqual(suggestions[0].criterion, "README and workerctl help are inspected.")
        self.assertEqual(suggestions[0].source, "worker_proposed")
        self.assertIsNone(suggestions[0].rationale)
        self.assertEqual(suggestions[2].rationale, criteria_plan.DEFAULT_DEFERRED_RATIONALE)

    def test_criteria_plan_parser_keeps_items_with_heading_keywords(self):
        text = """
Must-have current-task criteria:
- Current-task docs are updated.
- README inspected.

Deferred follow-up criteria:
- Follow-up QA harness is documented.
"""

        suggestions, warnings = criteria_plan.parse_worker_criteria_response(text)

        self.assertEqual(warnings, [])
        self.assertEqual(
            [(suggestion.criterion, suggestion.status) for suggestion in suggestions],
            [
                ("Current-task docs are updated.", "accepted"),
                ("README inspected.", "accepted"),
                ("Follow-up QA harness is documented.", "deferred"),
            ],
        )

    def test_criteria_plan_parser_joins_multiline_bullets(self):
        text = """
Must-have current-task criteria:
- Parser preserves the first line
  and joins the verification detail under it.

Deferred follow-up criteria:
- Add fixture-based transcript coverage
  after more dogfood shapes are collected.
"""

        suggestions, warnings = criteria_plan.parse_worker_criteria_response(text)

        self.assertEqual(warnings, [])
        self.assertEqual(
            [(suggestion.criterion, suggestion.status) for suggestion in suggestions],
            [
                ("Parser preserves the first line and joins the verification detail under it.", "accepted"),
                ("Add fixture-based transcript coverage after more dogfood shapes are collected.", "deferred"),
            ],
        )
        self.assertIsNone(suggestions[0].rationale)
        self.assertEqual(suggestions[1].rationale, criteria_plan.DEFAULT_DEFERRED_RATIONALE)

    def test_criteria_plan_parser_handles_gate5_wrapped_followup_prose(self):
        text = """
Must-have current-task criteria:

- A durable worker handoff records current status, next steps, and known risks.
  Verification: `workerctl handoff` output and replay/export include the handoff.
- The current task has accepted criteria for resume safety and a deferred
  follow-up for optional compact/clear coverage. Verification: `workerctl
  criteria --list` shows accepted and deferred criteria.
- A resumed manager records a decision based on durable replay/export/handoff
  state, not live chat memory. Verification: `workerctl record-decision` payload
  names replay, export, handoff, and criteria as evidence.

Follow-up criteria:

- Run the same resume drill with actual compact/clear only after handoff and
  manager permission are configured.
"""

        suggestions, warnings = criteria_plan.parse_worker_criteria_response(text)

        self.assertEqual(warnings, [])
        self.assertEqual([suggestion.status for suggestion in suggestions], ["accepted", "accepted", "accepted", "deferred"])
        self.assertEqual(
            suggestions[1].criterion,
            "The current task has accepted criteria for resume safety and a deferred "
            "follow-up for optional compact/clear coverage. Verification: `workerctl "
            "criteria --list` shows accepted and deferred criteria.",
        )
        self.assertEqual(
            suggestions[2].criterion,
            "A resumed manager records a decision based on durable replay/export/handoff "
            "state, not live chat memory. Verification: `workerctl record-decision` payload "
            "names replay, export, handoff, and criteria as evidence.",
        )
        self.assertEqual(
            suggestions[3].criterion,
            "Run the same resume drill with actual compact/clear only after handoff and "
            "manager permission are configured.",
        )

    def test_criteria_plan_parser_warns_on_ambiguous_prose(self):
        suggestions, warnings = criteria_plan.parse_worker_criteria_response(
            "I think we should make sure this generally works and maybe improve docs later."
        )

        self.assertEqual(suggestions, [])
        self.assertTrue(warnings)
        self.assertIn("No clear", warnings[0])

    def test_criteria_plan_parser_ignores_empty_placeholder_items(self):
        text = """
Must-have current-task criteria:
- README inspected.

Deferred follow-up criteria:
- None
- N/A.
- No follow-ups
"""

        suggestions, warnings = criteria_plan.parse_worker_criteria_response(text)

        self.assertEqual(warnings, [])
        self.assertEqual(
            [(suggestion.criterion, suggestion.status) for suggestion in suggestions],
            [("README inspected.", "accepted")],
        )

    def test_criteria_plan_cli_json_drafts_commands_without_mutation(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "workerctl.db"
            create = self.run_workerctl("tasks", "--create", "criteria-task", "--goal", "goal", "--path", str(db_path))
            self.assertEqual(create.returncode, 0, create.stderr)
            with worker_db.connect(db_path) as conn:
                before_counts = {
                    "acceptance_criteria": conn.execute("select count(*) from acceptance_criteria").fetchone()[0],
                    "events": conn.execute("select count(*) from events").fetchone()[0],
                    "commands": conn.execute("select count(*) from commands").fetchone()[0],
                }

            text = "\n".join(
                [
                    "Must-have current-task criteria:",
                    "- README inspected",
                    "Deferred follow-up criteria:",
                    "- Build qa-run later",
                ]
            )
            proc = self.run_workerctl(
                "criteria-plan",
                "criteria-task",
                "--from-text",
                text,
                "--json",
                "--path",
                str(db_path),
            )

            self.assertEqual(proc.returncode, 0, proc.stderr)
            payload = json.loads(proc.stdout)
            self.assertEqual(payload["task"], "criteria-task")
            self.assertEqual(payload["warnings"], [])
            self.assertEqual(len(payload["suggestions"]), 2)
            self.assertEqual(payload["suggestions"][0]["source"], "worker_proposed")
            self.assertEqual(payload["suggestions"][0]["status"], "accepted")
            self.assertEqual(payload["suggestions"][0]["command"][:4], ["workerctl", "criteria", "criteria-task", "--add"])
            self.assertEqual(payload["suggestions"][0]["command"][-2:], ["--path", str(db_path.resolve())])
            self.assertEqual(payload["suggestions"][1]["status"], "deferred")
            self.assertIn("--rationale", payload["suggestions"][1]["command"])

            criteria_before_add = self.run_workerctl("criteria", "criteria-task", "--list", "--path", str(db_path))
            self.assertEqual(criteria_before_add.returncode, 0, criteria_before_add.stderr)
            criteria_before_add_payload = json.loads(criteria_before_add.stdout)
            self.assertEqual(criteria_before_add_payload["criteria"], [])
            self.assertEqual(criteria_before_add_payload["summary"]["accepted"], 0)
            self.assertEqual(criteria_before_add_payload["summary"]["deferred"], 0)

            generated_args = payload["suggestions"][0]["command"][1:]
            add = self.run_workerctl(*generated_args)
            self.assertEqual(add.returncode, 0, add.stderr)

            criteria = self.run_workerctl("criteria", "criteria-task", "--list", "--path", str(db_path))
            self.assertEqual(criteria.returncode, 0, criteria.stderr)
            criteria_payload = json.loads(criteria.stdout)
            self.assertEqual([item["criterion"] for item in criteria_payload["criteria"]], ["README inspected"])
            self.assertEqual(criteria_payload["summary"]["accepted"], 1)
            self.assertEqual(criteria_payload["summary"]["deferred"], 0)
            with worker_db.connect(db_path) as conn:
                self.assertEqual(conn.execute("select count(*) from acceptance_criteria").fetchone()[0], before_counts["acceptance_criteria"] + 1)
                self.assertEqual(conn.execute("select count(*) from events").fetchone()[0], before_counts["events"] + 1)
                self.assertEqual(conn.execute("select count(*) from commands").fetchone()[0], before_counts["commands"])

    def test_criteria_plan_cli_text_renders_reviewed_commands(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "workerctl.db"
            create = self.run_workerctl("tasks", "--create", "criteria-task", "--goal", "goal", "--path", str(db_path))
            self.assertEqual(create.returncode, 0, create.stderr)

            proc = self.run_workerctl(
                "criteria-plan",
                "criteria-task",
                "--from-text",
                "Must-have current-task criteria:\n- README inspected\n",
                "--path",
                str(db_path),
            )

            self.assertEqual(proc.returncode, 0, proc.stderr)
            self.assertIn("Suggested criteria commands for criteria-task", proc.stdout)
            self.assertIn("workerctl criteria criteria-task --add --criterion", proc.stdout)
            self.assertIn(f"--path {db_path.resolve()}", proc.stdout)
            self.assertIn("Review these commands before running them.", proc.stdout)

    def test_qa_plan_tmux_errors_outputs_failure_flow(self):
        proc = self.run_workerctl("qa-plan", "tmux-errors", "--json")

        self.assertEqual(proc.returncode, 0, proc.stderr)
        payload = json.loads(proc.stdout)
        self.assertEqual(payload["scenario"], "tmux-errors")
        self.assertTrue(any("doctor-self --json" in step for step in payload["steps"]))
        self.assertTrue(any("PATH=/usr/bin:/bin" in step for step in payload["steps"]))
        self.assertTrue(any("workerctl list --json" in step for step in payload["steps"]))
        self.assertTrue(any("workerctl status" in step for step in payload["steps"]))
        self.assertTrue(any("session-nudge" in step for step in payload["steps"]))
        self.assertTrue(any("workerctl audit" in step for step in payload["steps"]))
        self.assertTrue(any("workerctl replay" in step for step in payload["steps"]))
        self.assertTrue(any("workerctl cycle" in step for step in payload["steps"]))
        self.assertTrue(any("finish-task --stop-manager --stop-worker" in step for step in payload["steps"]))
        self.assertTrue(any("workerctl reconcile --stale-cycles-seconds 1" in step for step in payload["steps"]))
        self.assertTrue(any("reconcile --apply" in step for step in payload["steps"]))
        self.assertTrue(any("git status --short --branch" in step for step in payload["steps"]))
        self.assertTrue(
            any("read-only commands preserve stable JSON output" in observation
                for observation in payload["expected_observations"])
        )
        self.assertTrue(
            any("mutating commands that depend on tmux fail loudly" in observation
                for observation in payload["expected_observations"])
        )
        self.assertTrue(
            any("pane_signal.degraded true" in observation
                for observation in payload["expected_observations"])
        )
        self.assertTrue(
            any("reports stop failures clearly" in observation
                for observation in payload["expected_observations"])
        )
        self.assertTrue(
            any("disposable sessions" in observation
                for observation in payload["expected_observations"])
        )
        joined = " ".join(payload["steps"] + payload["expected_observations"])
        self.assertIn("actionable tmux error", joined)
        self.assertIn("nonzero exit", joined)
        self.assertIn("no misleading successful session_nudged event", joined)
        self.assertIn("worker_alive/manager_alive", joined)

    def test_db_doctor_outputs_expected_structure(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "workerctl.db"
            proc = self.run_workerctl("db-doctor", "--path", str(db_path))

            self.assertEqual(proc.returncode, 0, proc.stderr)
            data = json.loads(proc.stdout)
            self.assertTrue(data["ok"])
            self.assertEqual(data["path"], str(db_path.resolve()))
            self.assertEqual(data["schema_version"], worker_db.SCHEMA_VERSION)
            self.assertTrue(any(check["name"] == "required_tables" for check in data["checks"]))

    def test_db_doctor_live_reports_ok_without_drift(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "workerctl.db"
            args = argparse.Namespace(path=str(db_path), live=True)

            with contextlib.redirect_stdout(io.StringIO()) as stdout:
                result = commands.command_db_doctor(args)

            payload = json.loads(stdout.getvalue())
            self.assertEqual(result, 0)
            self.assertTrue(payload["ok"])
            live_check = next(check for check in payload["checks"] if check["name"] == "live_reconcile")
            self.assertTrue(live_check["ok"])
            self.assertEqual(payload["live_reconcile"]["results"], [])

    def test_db_doctor_live_reports_missing_sessions(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "workerctl.db"
            with worker_db.connect(db_path) as conn:
                worker_db.initialize_database(conn)
                worker_id = worker_db.upsert_worker(
                    conn,
                    name="worker-a",
                    cwd=str(ROOT),
                    tmux_session="codex-worker-a",
                    state="active",
                )
                task_id = worker_db.create_task(conn, name="task-a", goal="Do task A.")
                worker_db.bind_task_worker(conn, task="task-a", worker="worker-a", binding_id="binding-1")
                manager_id = worker_db.create_manager(
                    conn,
                    task_id=task_id,
                    name="manager-a",
                    tmux_session="codex-manager-task-a",
                    codex_args=[],
                    state="ready",
                )
                worker_db.attach_manager_to_binding(conn, task_id=task_id, manager_id=manager_id)
                conn.commit()

            original_session_snapshot = worker_identity.session_snapshot
            try:
                worker_identity.session_snapshot = lambda session: {"live": False, "pane_id": None, "session": session}
                args = argparse.Namespace(path=str(db_path), live=True)

                with contextlib.redirect_stdout(io.StringIO()) as stdout:
                    result = commands.command_db_doctor(args)

                payload = json.loads(stdout.getvalue())
                self.assertEqual(result, 1)
                self.assertFalse(payload["ok"])
                live_check = next(check for check in payload["checks"] if check["name"] == "live_reconcile")
                self.assertFalse(live_check["ok"])
                self.assertEqual(live_check["drift_count"], 1)
                self.assertEqual(payload["live_reconcile"]["results"][0]["drift"], ["worker_missing", "manager_missing"])
            finally:
                worker_identity.session_snapshot = original_session_snapshot

    def test_db_doctor_live_reports_unfinished_commands(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "workerctl.db"
            with worker_db.connect(db_path) as conn:
                worker_db.initialize_database(conn)
                task_id = worker_db.create_task(conn, name="task-a", goal="Do task A.")
                worker_db.create_command(
                    conn,
                    command_type="task_nudge",
                    payload={"message": "status"},
                    task_id=task_id,
                )
                conn.commit()

            args = argparse.Namespace(path=str(db_path), live=True)

            with contextlib.redirect_stdout(io.StringIO()) as stdout:
                result = commands.command_db_doctor(args)

            payload = json.loads(stdout.getvalue())
            self.assertEqual(result, 1)
            live_check = next(check for check in payload["checks"] if check["name"] == "live_reconcile")
            self.assertEqual(live_check["unfinished_command_count"], 1)
            self.assertIn("unfinished_commands", payload["live_reconcile"]["results"][0]["drift"])

    def test_db_doctor_live_reports_manager_liveness_warnings_without_failing(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "workerctl.db"
            with worker_db.connect(db_path) as conn:
                worker_db.initialize_database(conn)
                worker_id = worker_db.upsert_worker(
                    conn,
                    name="worker-a",
                    cwd=str(ROOT),
                    tmux_session="codex-worker-a",
                    state="active",
                )
                task_id = worker_db.create_task(conn, name="task-a", goal="Do task A.")
                worker_db.bind_task_worker(conn, task="task-a", worker="worker-a", binding_id="binding-1")
                manager_id = worker_db.create_manager(
                    conn,
                    task_id=task_id,
                    name="manager-a",
                    tmux_session="codex-manager-task-a",
                    codex_args=[],
                    state="ready",
                )
                worker_db.attach_manager_to_binding(conn, task_id=task_id, manager_id=manager_id)
                conn.execute("update managers set last_seen_at = '2000-01-01T00:00:00Z' where id = ?", (manager_id,))
                conn.commit()

            original_session_snapshot = worker_identity.session_snapshot
            try:
                worker_identity.session_snapshot = lambda session: {"live": True, "pane_id": None, "session": session}
                args = argparse.Namespace(path=str(db_path), live=True, manager_stale_seconds=60)

                with contextlib.redirect_stdout(io.StringIO()) as stdout:
                    result = commands.command_db_doctor(args)

                payload = json.loads(stdout.getvalue())
                self.assertEqual(result, 0)
                self.assertTrue(payload["ok"])
                live_check = next(check for check in payload["checks"] if check["name"] == "live_reconcile")
                self.assertTrue(live_check["ok"])
                self.assertEqual(live_check["manager_liveness_warning_count"], 1)
                warning = payload["live_reconcile"]["manager_liveness_warnings"][0]
                self.assertEqual(warning["reason"], "manager_seen_stale")
                self.assertEqual(warning["manager"], "manager-a")
            finally:
                worker_identity.session_snapshot = original_session_snapshot

    def test_db_doctor_help_includes_live(self):
        proc = self.run_workerctl("db-doctor", "--help")

        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("--live", proc.stdout)
        self.assertIn("--manager-stale-seconds", proc.stdout)

    def test_start_launches_normal_codex_tmux_session(self):
        launched = []
        original_run = commands.run
        original_ensure_tool = commands.ensure_tool
        original_state_root = commands.state_root
        try:
            commands.ensure_tool = lambda tool: tool
            def fake_run(argv, **kwargs):
                if argv[:3] == ["tmux", "has-session", "-t"]:
                    return subprocess.CompletedProcess(argv, 1, "", "")
                launched.append(argv)
                return subprocess.CompletedProcess(argv, 0, "", "")

            commands.run = fake_run
            with tempfile.TemporaryDirectory() as tmpdir:
                commands.state_root = lambda: Path(tmpdir)
                args = argparse.Namespace(
                    codex_args=["--", "--model", "gpt-5.4-mini"],
                    cwd=str(ROOT),
                    session="qa-raw",
                    start_prompt=True,
                )

                with contextlib.redirect_stdout(io.StringIO()) as stdout:
                    result = commands.command_start(args)

                payload = json.loads(stdout.getvalue())
                self.assertEqual(result, 0)
                self.assertEqual(payload["session"], "qa-raw")
                self.assertEqual(payload["attach_command"], "tmux attach -t qa-raw")
                self.assertEqual(payload["register_worker_command_template"], f"workerctl register-worker --name <worker-name> --pid <pid> --codex-session <rollout.jsonl> --cwd '{ROOT}' --tmux-session qa-raw")
                self.assertEqual(payload["start_manager_command_template"], f"workerctl start-manager --name <manager-name> --cwd '{ROOT}' -- '--model' 'gpt-5.4-mini'")
                self.assertEqual(payload["bind_command_template"], "workerctl bind --task <task-name> --worker <worker-name> --manager <manager-name>")
                self.assertEqual(payload["manager_config_questions_command_template"], "workerctl manager-config <task-name> --questions")
                self.assertTrue(payload["start_prompt_sent"])
                self.assertTrue(Path(payload["start_prompt_path"]).exists())
                prompt = Path(payload["start_prompt_path"]).read_text()
                self.assertIn("workerctl tmux session qa-raw", prompt)
                self.assertIn("workerctl register-worker --name <worker-name>", prompt)
                self.assertIn("workerctl start-manager --name <manager-name>", prompt)
                self.assertIn("workerctl bind --task <task-name>", prompt)
                self.assertIn("workerctl manager-config <task-name> --questions", prompt)
                self.assertIn("-- '--model' 'gpt-5.4-mini'", prompt)
                self.assertNotIn("become-managed", prompt)
                self.assertNotIn("workerctl unmanage", prompt)
                self.assertNotIn("workerctl my-status", prompt)
                self.assertNotIn("workerctl remanage", prompt)
                self.assertIn("workerctl open-manager <task-name>", prompt)
                self.assertIn("If any required field is missing, ask the user", prompt)
                self.assertIn("Do not invent worker", prompt)
                self.assertEqual(launched[0][:5], ["tmux", "new-session", "-d", "-s", "qa-raw"])
                self.assertIn("codex --cd", launched[0][5])
                self.assertIn("--no-alt-screen", launched[0][5])
                self.assertIn("'--model' 'gpt-5.4-mini'", launched[0][5])
                self.assertIn("/bin':$PATH", launched[0][5])
                self.assertIn("$(cat", launched[0][5])
        finally:
            commands.run = original_run
            commands.ensure_tool = original_ensure_tool
            commands.state_root = original_state_root

    def test_start_can_skip_bootstrap_prompt(self):
        launched = []
        original_run = commands.run
        original_ensure_tool = commands.ensure_tool
        try:
            commands.ensure_tool = lambda tool: tool
            def fake_run(argv, **kwargs):
                if argv[:3] == ["tmux", "has-session", "-t"]:
                    return subprocess.CompletedProcess(argv, 1, "", "")
                launched.append(argv)
                return subprocess.CompletedProcess(argv, 0, "", "")

            commands.run = fake_run
            args = argparse.Namespace(codex_args=[], cwd=str(ROOT), session="qa-raw", start_prompt=False)

            with contextlib.redirect_stdout(io.StringIO()) as stdout:
                result = commands.command_start(args)

            payload = json.loads(stdout.getvalue())
            self.assertEqual(result, 0)
            self.assertFalse(payload["start_prompt_sent"])
            self.assertIsNone(payload["start_prompt_path"])
            self.assertNotIn("$(cat", launched[0][5])
        finally:
            commands.run = original_run
            commands.ensure_tool = original_ensure_tool

    def test_start_refuses_existing_tmux_session(self):
        original_run = commands.run
        original_ensure_tool = commands.ensure_tool
        try:
            commands.ensure_tool = lambda tool: tool
            commands.run = lambda argv, **kwargs: subprocess.CompletedProcess(argv, 0, "", "")
            args = argparse.Namespace(codex_args=[], cwd=str(ROOT), session="qa-raw", start_prompt=True)

            with self.assertRaisesRegex(WorkerError, "tmux session already exists"):
                commands.command_start(args)
        finally:
            commands.run = original_run
            commands.ensure_tool = original_ensure_tool

    def test_manager_codex_args_default_and_opt_out(self):
        self.assertEqual(
            lifecycle.manager_codex_args_from_args(argparse.Namespace(codex_args=[], no_manager_codex_args=False)),
            ["--sandbox", "danger-full-access", "--ask-for-approval", "never"],
        )
        self.assertEqual(
            lifecycle.manager_codex_args_from_args(argparse.Namespace(codex_args=["--", "--model", "test"], no_manager_codex_args=False)),
            ["--model", "test"],
        )
        self.assertEqual(
            lifecycle.manager_codex_args_from_args(argparse.Namespace(codex_args=[], no_manager_codex_args=True)),
            [],
        )

    def test_import_compat_dry_run_does_not_mutate_database(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir) / "workers"
            worker_path = root / "worker-a"
            worker_path.mkdir(parents=True)
            write_json(
                worker_path / "config.json",
                {
                    "created_at": "2026-05-08T10:00:00Z",
                    "cwd": str(ROOT),
                    "identity_token": "token-worker-a",
                    "name": "worker-a",
                    "tmux_session": "codex-worker-a",
                },
            )
            write_json(
                worker_path / "status.json",
                {
                    "blocker": None,
                    "current_task": "legacy task",
                    "last_update": "2026-05-08T10:01:00Z",
                    "next_action": "continue",
                    "state": "waiting",
                },
            )
            db_path = Path(tmpdir) / "workerctl.db"

            with contextlib.redirect_stdout(io.StringIO()) as stdout:
                result = importer.command_import_compat(
                    argparse.Namespace(apply=False, path=str(db_path), root=str(root), worker=None)
                )

            payload = json.loads(stdout.getvalue())
            self.assertEqual(result, 0)
            self.assertFalse(payload["apply"])
            self.assertEqual(payload["workers"][0]["action_count"], 2)
            with worker_db.connect(db_path) as conn:
                worker_db.initialize_database(conn)
                worker_count = conn.execute("select count(*) from workers").fetchone()[0]
                migration_count = conn.execute("select count(*) from data_migrations").fetchone()[0]
            self.assertEqual(worker_count, 0)
            self.assertEqual(migration_count, 0)

    def test_import_compat_apply_imports_worker_artifacts_once(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir) / "workers"
            worker_path = root / "worker-a"
            worker_path.mkdir(parents=True)
            write_json(
                worker_path / "config.json",
                {
                    "created_at": "2026-05-08T10:00:00Z",
                    "cwd": str(ROOT),
                    "identity_token": "token-worker-a",
                    "name": "worker-a",
                    "tmux_pane_id": "%1",
                    "tmux_session": "codex-worker-a",
                },
            )
            write_json(
                worker_path / "status.json",
                {
                    "blocker": None,
                    "current_task": "legacy task",
                    "last_update": "2026-05-08T10:01:00Z",
                    "next_action": "continue",
                    "state": "waiting",
                },
            )
            write_json(
                worker_path / "capture-meta.json",
                {
                    "captured_at": "2026-05-08T10:02:00Z",
                    "changed_at": "2026-05-08T10:02:00Z",
                    "history_lines": 50,
                },
            )
            (worker_path / "transcript.txt").write_text("line one\nline two")
            (worker_path / "events.jsonl").write_text(
                json.dumps({"message": "hello", "time": "2026-05-08T10:03:00Z", "type": "nudge"}, sort_keys=True)
                + "\n"
            )
            db_path = Path(tmpdir) / "workerctl.db"
            args = argparse.Namespace(apply=True, path=str(db_path), root=str(root), worker=None)

            with contextlib.redirect_stdout(io.StringIO()) as stdout:
                result = importer.command_import_compat(args)
            with contextlib.redirect_stdout(io.StringIO()) as second_stdout:
                second_result = importer.command_import_compat(args)

            payload = json.loads(stdout.getvalue())
            second_payload = json.loads(second_stdout.getvalue())
            self.assertEqual(result, 0)
            self.assertEqual(second_result, 0)
            self.assertTrue(payload["apply"])
            self.assertEqual(payload["workers"][0]["action_count"], 4)
            self.assertEqual(second_payload["workers"][0]["action_count"], 0)
            with worker_db.connect(db_path) as conn:
                worker_db.initialize_database(conn)
                worker = conn.execute("select * from workers where name = 'worker-a'").fetchone()
                statuses = conn.execute("select * from statuses where worker_id = ?", (worker["id"],)).fetchall()
                captures = conn.execute("select * from transcript_captures where worker_id = ?", (worker["id"],)).fetchall()
                events = conn.execute("select * from events where worker_id = ? and type = 'compat_nudge'", (worker["id"],)).fetchall()
                migrations = conn.execute("select count(*) from data_migrations").fetchone()[0]
            self.assertEqual(worker["state"], "candidate")
            self.assertNotEqual(worker["id"], "worker-a")
            self.assertEqual(worker["tmux_pane_id"], "%1")
            self.assertEqual(len(statuses), 1)
            self.assertEqual(statuses[0]["current_task"], "legacy task")
            self.assertEqual(len(captures), 1)
            self.assertEqual(captures[0]["content"], "line one\nline two")
            self.assertEqual(captures[0]["history_lines"], 50)
            self.assertEqual(len(events), 1)
            self.assertEqual(json.loads(events[0]["payload_json"])["message"], "hello")
            self.assertEqual(migrations, 4)

    def test_tasks_create_and_list_json(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "workerctl.db"
            create_proc = self.run_workerctl(
                "tasks",
                "--path",
                str(db_path),
                "--create",
                "auth-refactor",
                "--goal",
                "Finish auth refactor.",
                "--summary",
                "Middleware replaced.",
            )
            self.assertEqual(create_proc.returncode, 0, create_proc.stderr)
            created = json.loads(create_proc.stdout)
            self.assertTrue(created["created"])
            self.assertEqual(created["name"], "auth-refactor")

            list_proc = self.run_workerctl("tasks", "--path", str(db_path), "--json")
            self.assertEqual(list_proc.returncode, 0, list_proc.stderr)
            tasks = json.loads(list_proc.stdout)
            self.assertEqual(len(tasks), 1)
            self.assertEqual(tasks[0]["name"], "auth-refactor")
            self.assertEqual(tasks[0]["goal"], "Finish auth refactor.")
            self.assertEqual(tasks[0]["state"], "candidate")

    def test_tasks_create_requires_goal(self):
        proc = self.run_workerctl("tasks", "--create", "missing-goal")

        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("--goal is required", proc.stderr)

    def test_commands_cli_lists_durable_commands(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "workerctl.db"
            with worker_db.connect(db_path) as conn:
                worker_db.initialize_database(conn)
                task_id = worker_db.create_task(conn, name="task-a", goal="Do task A.")
                command_id = worker_db.create_command(
                    conn,
                    command_type="task_nudge",
                    payload={"message": "status"},
                    task_id=task_id,
                )
                conn.commit()

            proc = self.run_workerctl("commands", "--task", "task-a", "--json", "--path", str(db_path))

            self.assertEqual(proc.returncode, 0, proc.stderr)
            records = json.loads(proc.stdout)
            self.assertEqual(records[0]["id"], command_id)
            self.assertEqual(records[0]["type"], "task_nudge")
            self.assertEqual(records[0]["task_name"], "task-a")

    def test_commands_cli_filters_by_type_and_state(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "workerctl.db"
            with worker_db.connect(db_path) as conn:
                worker_db.initialize_database(conn)
                task_id = worker_db.create_task(conn, name="task-a", goal="Do task A.")
                keep_id = worker_db.create_command(
                    conn,
                    command_type="task_nudge",
                    payload={"message": "status"},
                    task_id=task_id,
                )
                drop_id = worker_db.create_command(
                    conn,
                    command_type="task_interrupt",
                    payload={"key": "C-c"},
                    task_id=task_id,
                )
                worker_db.finish_command(conn, command_id=drop_id, state="failed", error="nope")
                conn.commit()

            proc = self.run_workerctl(
                "commands",
                "--task",
                "task-a",
                "--type",
                "task_nudge",
                "--state",
                "pending",
                "--json",
                "--path",
                str(db_path),
            )

            self.assertEqual(proc.returncode, 0, proc.stderr)
            records = json.loads(proc.stdout)
            self.assertEqual([record["id"] for record in records], [keep_id])

    def test_commands_cli_filters_by_worker_and_manager(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "workerctl.db"
            with worker_db.connect(db_path) as conn:
                worker_db.initialize_database(conn)
                task_id = worker_db.create_task(conn, name="task-a", goal="Do task A.")
                worker_id = worker_db.upsert_worker(
                    conn,
                    name="worker-a",
                    cwd=str(ROOT),
                    tmux_session="codex-worker-a",
                    state="active",
                )
                manager_id = worker_db.create_manager(
                    conn,
                    task_id=task_id,
                    name="manager-a",
                    tmux_session="codex-manager-task-a",
                    codex_args=[],
                    state="ready",
                )
                keep_id = worker_db.create_command(
                    conn,
                    command_type="task_nudge",
                    payload={"message": "status"},
                    task_id=task_id,
                    worker_id=worker_id,
                    manager_id=manager_id,
                )
                worker_db.create_command(
                    conn,
                    command_type="task_nudge",
                    payload={"message": "status"},
                    task_id=task_id,
                    worker_id=worker_id,
                )
                conn.commit()

            proc = self.run_workerctl(
                "commands",
                "--worker",
                worker_id,
                "--manager",
                manager_id,
                "--json",
                "--path",
                str(db_path),
            )

            self.assertEqual(proc.returncode, 0, proc.stderr)
            records = json.loads(proc.stdout)
            self.assertEqual([record["id"] for record in records], [keep_id])

    def test_prune_drops_old_transcript_content(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "workerctl.db"
            with worker_db.connect(db_path) as conn:
                worker_db.initialize_database(conn)
                worker_id = worker_db.upsert_worker(
                    conn,
                    name="worker-a",
                    cwd=str(ROOT),
                    tmux_session="codex-worker-a",
                    state="active",
                )
                for index in range(3):
                    worker_db.insert_transcript_capture(
                        conn,
                        worker_id=worker_id,
                        sha256=f"hash-{index}",
                        content=f"content {index}",
                        captured_at=f"2026-05-08T10:0{index}:00Z",
                        changed_at=f"2026-05-08T10:0{index}:00Z",
                        history_lines=80,
                        changed=True,
                    )
                conn.commit()

            proc = self.run_workerctl("prune", "--keep-latest", "1", "--path", str(db_path))

            self.assertEqual(proc.returncode, 0, proc.stderr)
            result = json.loads(proc.stdout)
            self.assertEqual(result["pruned_count"], 2)
            with worker_db.connect(db_path) as conn:
                content_rows = conn.execute(
                    "select id, content, capture_kind, retention_class from transcript_captures order by id"
                ).fetchall()
            self.assertIsNone(content_rows[0]["content"])
            self.assertIsNone(content_rows[1]["content"])
            self.assertEqual(content_rows[0]["capture_kind"], "metadata_only")
            self.assertEqual(content_rows[0]["retention_class"], "warm")
            self.assertEqual(content_rows[2]["content"], "content 2")

    def test_live_smoke_script_has_valid_bash_syntax(self):
        proc = subprocess.run(
            ["bash", "-n", str(ROOT / "scripts" / "live-smoke")],
            cwd=ROOT,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )

        self.assertEqual(proc.returncode, 0, proc.stderr)

    def test_transcript_capture_records_deduped_segments_and_show_prune(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "workerctl.db"
            with worker_db.connect(db_path) as conn:
                worker_db.initialize_database(conn)
                worker_db.upsert_worker(
                    conn,
                    name="worker-a",
                    cwd=str(ROOT),
                    tmux_session="codex-worker-a",
                    identity_token="token-worker-a",
                    tmux_pane_id="%1",
                    state="active",
                )
                worker_db.create_task(conn, name="task-a", goal="Do task A.")
                worker_db.bind_task_worker(conn, task="task-a", worker="worker-a", binding_id="binding-1")
                conn.commit()

            outputs = iter(["line one\nline two", "line one\nline two", "line one\nline two\nline three"])
            original_capture_output = commands.capture_output
            original_verify_worker = worker_identity.verify_worker_binding_identity
            try:
                commands.capture_output = lambda name, lines: next(outputs)
                worker_identity.verify_worker_binding_identity = lambda binding: {"live": True, "live_pane_id": "%1", "mismatches": []}
                args = argparse.Namespace(json=True, lines=80, mode="segment", path=str(db_path), role="worker", task="task-a")

                with contextlib.redirect_stdout(io.StringIO()):
                    self.assertEqual(commands.command_transcript_capture(args), 0)
                with contextlib.redirect_stdout(io.StringIO()):
                    self.assertEqual(commands.command_transcript_capture(args), 0)
                with contextlib.redirect_stdout(io.StringIO()):
                    self.assertEqual(commands.command_transcript_capture(args), 0)

                with worker_db.connect(db_path) as conn:
                    segments = conn.execute("select segment_kind, segment_text from transcript_segments order by id").fetchall()
                self.assertEqual(len(segments), 2)
                self.assertEqual(segments[0]["segment_kind"], "reset")
                self.assertEqual(segments[0]["segment_text"], "line one\nline two")
                self.assertEqual(segments[1]["segment_kind"], "segment")
                self.assertEqual(segments[1]["segment_text"], "line three")

                show_args = argparse.Namespace(json=False, limit=None, path=str(db_path), role="worker", task="task-a")
                with contextlib.redirect_stdout(io.StringIO()) as stdout:
                    self.assertEqual(commands.command_transcript_show(show_args), 0)
                self.assertIn("line three", stdout.getvalue())

                prune_args = argparse.Namespace(dry_run=False, keep_latest=1, path=str(db_path), task="task-a")
                with contextlib.redirect_stdout(io.StringIO()) as stdout:
                    self.assertEqual(commands.command_transcript_prune(prune_args), 0)
                self.assertEqual(json.loads(stdout.getvalue())["pruned_count"], 1)
                with worker_db.connect(db_path) as conn:
                    pruned = conn.execute("select segment_text, retention_class from transcript_segments order by id").fetchone()
                self.assertIsNone(pruned["segment_text"])
                self.assertEqual(pruned["retention_class"], "cold")
            finally:
                commands.capture_output = original_capture_output
                worker_identity.verify_worker_binding_identity = original_verify_worker

    def test_replay_full_transcript_includes_segments(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "workerctl.db"
            with worker_db.connect(db_path) as conn:
                worker_db.initialize_database(conn)
                task_id = worker_db.create_task(conn, name="task-a", goal="Do task A.")
                capture_id = worker_db.insert_terminal_capture(
                    conn,
                    task_id=task_id,
                    role="worker",
                    tmux_session="codex-worker-a",
                    content_sha256="sha-1",
                    content="worker transcript line",
                    history_lines=20,
                    source="test",
                    classifier={},
                    timestamp="2026-05-11T10:00:00Z",
                )
                worker_db.insert_transcript_segment(
                    conn,
                    task_id=task_id,
                    role="worker",
                    source_capture_id=capture_id,
                    previous_capture_id=None,
                    content_sha256="sha-1",
                    segment_text="worker transcript line",
                    segment_start_line=1,
                    segment_end_line=1,
                    segment_kind="reset",
                    timestamp="2026-05-11T10:00:00Z",
                )
                conn.commit()

            proc = self.run_workerctl("replay", "task-a", "--format", "full-transcript", "--path", str(db_path))

            self.assertEqual(proc.returncode, 0, proc.stderr)
            self.assertIn("worker transcript segment", proc.stdout)
            self.assertIn("worker transcript line", proc.stdout)

    def test_mutation_audit_accepts_finish_task_final_decision(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "workerctl.db"
            with worker_db.connect(db_path) as conn:
                worker_db.initialize_database(conn)
                task_id = worker_db.create_task(conn, name="task-a", goal="Do task A.")
                command_id = worker_db.create_command(
                    conn,
                    command_type="finish_task",
                    task_id=task_id,
                    payload={"manager_decision": {"decision": None, "warnings": ["missing_decision_id"]}},
                    timestamp="2026-05-11T10:00:00Z",
                )
                decision_id = worker_db.insert_manager_decision(
                    conn,
                    task_id=task_id,
                    manager_id=None,
                    decision="stop",
                    reason="work complete",
                    payload={"source": "finish_task", "command_id": command_id},
                    timestamp="2026-05-11T10:00:00Z",
                )
                worker_db.finish_command(
                    conn,
                    command_id=command_id,
                    state="succeeded",
                    result={"final_decision_id": decision_id, "manager_decision": {"decision": None, "warnings": ["missing_decision_id"]}},
                    timestamp="2026-05-11T10:00:01Z",
                )
                conn.commit()

            proc = self.run_workerctl("mutation-audit", "task-a", "--json", "--path", str(db_path))

            self.assertEqual(proc.returncode, 0, proc.stdout)
            payload = json.loads(proc.stdout)
            self.assertTrue(payload["ok"])
            self.assertEqual(payload["summary"]["mutations"], 1)
            self.assertEqual(payload["records"][0]["linked_decision"]["id"], decision_id)

    def test_mutation_audit_accepts_expected_failed_guardrail_commands(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "workerctl.db"
            with worker_db.connect(db_path) as conn:
                worker_db.initialize_database(conn)
                task_id = worker_db.create_task(conn, name="task-a", goal="Do task A.")
                finish_command = worker_db.create_command(
                    conn,
                    command_type="finish_task",
                    task_id=task_id,
                    payload={"expected_failure": True, "failure_stage": "final_criteria_audit"},
                    timestamp="2026-05-11T10:00:00Z",
                )
                worker_db.finish_command(
                    conn,
                    command_id=finish_command,
                    state="failed",
                    result={"expected_failure": True, "failure_stage": "final_criteria_audit"},
                    error="accepted acceptance criteria still open",
                    timestamp="2026-05-11T10:00:01Z",
                )
                compact_command = worker_db.create_command(
                    conn,
                    command_type="request_worker_compact",
                    task_id=task_id,
                    payload={
                        "manager_decision": {
                            "decision": None,
                            "ok": False,
                            "warnings": ["missing_decision_id"],
                        }
                    },
                    timestamp="2026-05-11T10:00:02Z",
                )
                worker_db.finish_command(
                    conn,
                    command_id=compact_command,
                    state="failed",
                    result={
                        "expected_failure": True,
                        "manager_decision": {
                            "decision": None,
                            "ok": False,
                            "warnings": ["missing_decision_id"],
                        },
                    },
                    error="strict manager decision validation failed",
                    timestamp="2026-05-11T10:00:03Z",
                )
                conn.commit()

            proc = self.run_workerctl("mutation-audit", "task-a", "--json", "--path", str(db_path))

            self.assertEqual(proc.returncode, 0, proc.stderr)
            payload = json.loads(proc.stdout)
            self.assertTrue(payload["ok"])
            self.assertEqual(payload["summary"]["mutations"], 2)
            self.assertEqual(payload["summary"]["with_warnings"], 0)
            self.assertTrue(all(record["expected_failure"] for record in payload["records"]))

    def test_replay_outputs_chronological_text(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "workerctl.db"
            with worker_db.connect(db_path) as conn:
                worker_db.initialize_database(conn)
                task_id = worker_db.create_task(conn, name="task-a", goal="Do task A.", timestamp="2026-05-11T10:00:00Z")
                worker_id = worker_db.upsert_worker(
                    conn,
                    name="worker-a",
                    cwd=str(ROOT),
                    tmux_session="codex-worker-a",
                    identity_token="token-worker-a",
                    state="active",
                )
                manager_id = worker_db.create_manager(
                    conn,
                    task_id=task_id,
                    name="manager-a",
                    tmux_session="codex-manager-task-a",
                    codex_args=[],
                    state="ready",
                    timestamp="2026-05-11T10:00:01Z",
                )
                promote_id = worker_db.create_command(
                    conn,
                    command_type="promote",
                    task_id=task_id,
                    worker_id=worker_id,
                    manager_id=manager_id,
                    payload={"worker": "worker-a", "manager_session": "codex-manager-task-a"},
                    timestamp="2026-05-11T10:00:02Z",
                )
                worker_db.finish_command(
                    conn,
                    command_id=promote_id,
                    state="succeeded",
                    result={"worker": "worker-a", "manager_session": "codex-manager-task-a"},
                    timestamp="2026-05-11T10:00:03Z",
                )
                worker_db.insert_manager_decision(
                    conn,
                    task_id=task_id,
                    manager_id=manager_id,
                    decision="nudge",
                    reason="worker is idle",
                    timestamp="2026-05-11T10:00:04Z",
                )
                nudge_id = worker_db.create_command(
                    conn,
                    command_type="task_nudge",
                    task_id=task_id,
                    worker_id=worker_id,
                    manager_id=manager_id,
                    payload={"message": "please continue"},
                    timestamp="2026-05-11T10:00:05Z",
                )
                worker_db.finish_command(
                    conn,
                    command_id=nudge_id,
                    state="succeeded",
                    result={"message": "please continue"},
                    timestamp="2026-05-11T10:00:06Z",
                )
                conn.commit()

            proc = self.run_workerctl("replay", "task-a", "--path", str(db_path))

            self.assertEqual(proc.returncode, 0, proc.stderr)
            self.assertIn("Task: task-a", proc.stdout)
            self.assertLess(proc.stdout.index("promoted worker worker-a"), proc.stdout.index("decision nudge"))
            self.assertLess(proc.stdout.index("decision nudge"), proc.stdout.index("sent nudge"))

    def test_replay_json_outputs_stable_entries(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "workerctl.db"
            with worker_db.connect(db_path) as conn:
                worker_db.initialize_database(conn)
                task_id = worker_db.create_task(conn, name="task-a", goal="Do task A.")
                worker_db.insert_manager_decision(conn, task_id=task_id, manager_id=None, decision="wait", reason="fresh status")
                conn.commit()

            proc = self.run_workerctl("replay", "task-a", "--json", "--path", str(db_path))

            self.assertEqual(proc.returncode, 0, proc.stderr)
            payload = json.loads(proc.stdout)
            self.assertEqual(payload["task"]["name"], "task-a")
            self.assertEqual(payload["entries"][0]["actor"], "manager")
            self.assertEqual(payload["entries"][0]["kind"], "decision")
            self.assertIn("timestamp", payload["entries"][0])

    def test_replay_compact_omits_capture_noise_and_transcript_includes_excerpts(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "workerctl.db"
            with worker_db.connect(db_path) as conn:
                worker_db.initialize_database(conn)
                task_id = worker_db.create_task(conn, name="task-a", goal="Do task A.")
                worker_db.insert_terminal_capture(
                    conn,
                    task_id=task_id,
                    role="worker",
                    tmux_session="codex-worker-a",
                    content_sha256="sha-1",
                    content="line one\n• Worker edited app\n",
                    history_lines=20,
                    source="test",
                    classifier={"busy_wait": {"pattern": "approval_prompt"}, "startup": ["ready"]},
                    timestamp="2026-05-11T10:00:00Z",
                )
                worker_db.insert_terminal_capture(
                    conn,
                    task_id=task_id,
                    role="worker",
                    tmux_session="codex-worker-a",
                    content_sha256="sha-1",
                    content="line one\n• Worker edited app\n",
                    history_lines=20,
                    source="test",
                    classifier={"startup": ["ready"]},
                    timestamp="2026-05-11T10:00:01Z",
                )
                conn.commit()

            compact = self.run_workerctl("replay", "task-a", "--format", "compact", "--path", str(db_path))
            transcript = self.run_workerctl("replay", "task-a", "--format", "transcript", "--path", str(db_path))

            self.assertEqual(compact.returncode, 0, compact.stderr)
            self.assertNotIn("Worker edited app", compact.stdout)
            self.assertEqual(transcript.returncode, 0, transcript.stderr)
            self.assertEqual(transcript.stdout.count("Worker edited app"), 1)
            self.assertNotIn("approval_prompt", transcript.stdout)

    def test_audit_cli_json_outputs_task_history(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "workerctl.db"
            with worker_db.connect(db_path) as conn:
                worker_db.initialize_database(conn)
                worker_db.create_task(conn, name="task-a", goal="Do task A.", task_id="task-a-id")
                command_id = worker_db.create_command(
                    conn,
                    command_type="task_nudge",
                    payload={"message": "status"},
                    task_id="task-a-id",
                )
                worker_db.insert_event(
                    conn,
                    "task_nudge_intent",
                    actor="test",
                    command_id=command_id,
                    task_id="task-a-id",
                    payload={"message": "status"},
                )
                conn.commit()

            proc = self.run_workerctl("audit", "task-a", "--json", "--path", str(db_path))

            self.assertEqual(proc.returncode, 0, proc.stderr)
            audit = json.loads(proc.stdout)
            self.assertEqual(audit["task"]["id"], "task-a-id")
            self.assertEqual(audit["commands"][0]["id"], command_id)
            self.assertIn("task_created", [event["type"] for event in audit["events"]])
            self.assertIn("task_nudge_intent", [event["type"] for event in audit["events"]])

    def test_task_status_flags_managed_without_active_worker_binding(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "workerctl.db"
            with worker_db.connect(db_path) as conn:
                worker_db.initialize_database(conn)
                task_id = worker_db.create_task(conn, name="task-a", goal="Do task A.")
                worker_db.set_task_state(conn, task_id=task_id, state="managed")
                worker_db.create_manager(
                    conn,
                    task_id=task_id,
                    name="manager-a",
                    tmux_session="codex-manager-task-a",
                    codex_args=[],
                    state="ready",
                )
                conn.commit()

            with worker_db.connect(db_path) as conn:
                snapshot = worker_db.task_status_snapshot(conn, task="task-a")
            self.assertFalse(snapshot["integrity"]["ok"])
            self.assertIn("managed_without_active_worker_binding", snapshot["integrity"]["issues"])

    def test_stop_task_marks_done_and_ends_binding(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "workerctl.db"
            worker_path = worker_dir("worker-a")
            if worker_path.exists():
                shutil.rmtree(worker_path)
            worker_path.mkdir(parents=True)
            config_path("worker-a").write_text(
                json.dumps(
                    {
                        "identity_token": "token-worker-a",
                        "name": "worker-a",
                        "tmux_pane_id": "%1",
                        "tmux_session": "codex-worker-a",
                    }
                )
                + "\n"
            )
            with worker_db.connect(db_path) as conn:
                worker_db.initialize_database(conn)
                worker_db.upsert_worker(
                    conn,
                    name="worker-a",
                    cwd=str(ROOT),
                    tmux_session="codex-worker-a",
                    identity_token="token-worker-a",
                    tmux_pane_id="%1",
                    state="active",
                )
                task_id = worker_db.create_task(conn, name="task-a", goal="Do task A.")
                worker_db.bind_task_worker(conn, task="task-a", worker="worker-a", binding_id="binding-1")
                manager_id = worker_db.create_manager(
                    conn,
                    task_id=task_id,
                    name="manager-a",
                    tmux_session="codex-manager-task-a",
                    tmux_pane_id="%2",
                    codex_args=[],
                    state="ready",
                )
                worker_db.attach_manager_to_binding(conn, task_id=task_id, manager_id=manager_id)
                conn.commit()

            original_manager_session_exists = lifecycle.manager_session_exists
            original_session_exists = lifecycle.session_exists
            original_run = lifecycle.run
            original_session_snapshot = worker_identity.session_snapshot
            try:
                lifecycle.manager_session_exists = lambda session: session == "codex-manager-task-a"
                lifecycle.session_exists = lambda worker: worker == "worker-a"
                worker_identity.session_snapshot = lambda session: {
                    "live": True,
                    "pane_id": "%2" if session == "codex-manager-task-a" else "%1",
                    "session": session,
                }
                lifecycle.run = lambda *args, **kwargs: subprocess.CompletedProcess(args[0], 0, "", "")
                args = argparse.Namespace(
                    message=None,
                    path=str(db_path),
                    reason="QA cleanup after tmux failure simulation",
                    stop_worker=True,
                    task="task-a",
                )

                with contextlib.redirect_stdout(io.StringIO()) as stdout:
                    result = lifecycle.command_stop_task(args)

                payload = json.loads(stdout.getvalue())
                self.assertEqual(result, 0)
                self.assertEqual(payload["reason"], "QA cleanup after tmux failure simulation")
                self.assertTrue(payload["killed_manager"])
                self.assertTrue(payload["killed_worker"])
                with worker_db.connect(db_path) as conn:
                    task = conn.execute("select state from tasks where id = ?", (task_id,)).fetchone()
                    binding = conn.execute("select state, ended_at from bindings where id = 'binding-1'").fetchone()
                    manager = conn.execute("select state from managers where id = ?", (manager_id,)).fetchone()
                    worker = conn.execute("select state from workers where name = 'worker-a'").fetchone()
                    command = conn.execute("select state, payload_json, result_json from commands where type = 'stop_task'").fetchone()
                    event = conn.execute("select payload_json from events where type = 'stop_task_succeeded'").fetchone()
                self.assertEqual(task["state"], "done")
                self.assertEqual(binding["state"], "ended")
                self.assertIsNotNone(binding["ended_at"])
                self.assertEqual(manager["state"], "stopped")
                self.assertEqual(worker["state"], "stopped")
                self.assertEqual(command["state"], "succeeded")
                self.assertEqual(
                    json.loads(command["payload_json"])["reason"],
                    "QA cleanup after tmux failure simulation",
                )
                self.assertEqual(
                    json.loads(command["result_json"])["reason"],
                    "QA cleanup after tmux failure simulation",
                )
                self.assertEqual(
                    json.loads(event["payload_json"])["reason"],
                    "QA cleanup after tmux failure simulation",
                )
            finally:
                lifecycle.manager_session_exists = original_manager_session_exists
                lifecycle.session_exists = original_session_exists
                lifecycle.run = original_run
                worker_identity.session_snapshot = original_session_snapshot
                if worker_path.exists():
                    shutil.rmtree(worker_path)

    def test_finish_task_records_final_decision_and_marks_done(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "workerctl.db"
            worker_path = worker_dir("worker-a")
            if worker_path.exists():
                shutil.rmtree(worker_path)
            worker_path.mkdir(parents=True)
            config_path("worker-a").write_text(
                json.dumps(
                    {
                        "identity_token": "token-worker-a",
                        "name": "worker-a",
                        "tmux_pane_id": "%1",
                        "tmux_session": "codex-worker-a",
                    }
                )
                + "\n"
            )
            with worker_db.connect(db_path) as conn:
                worker_db.initialize_database(conn)
                worker_db.upsert_worker(
                    conn,
                    name="worker-a",
                    cwd=str(ROOT),
                    tmux_session="codex-worker-a",
                    identity_token="token-worker-a",
                    tmux_pane_id="%1",
                    state="active",
                )
                task_id = worker_db.create_task(conn, name="task-a", goal="Do task A.")
                worker_db.bind_task_worker(conn, task="task-a", worker="worker-a", binding_id="binding-1")
                manager_id = worker_db.create_manager(
                    conn,
                    task_id=task_id,
                    name="manager-a",
                    tmux_session="codex-manager-task-a",
                    tmux_pane_id="%2",
                    codex_args=[],
                    state="ready",
                )
                worker_db.attach_manager_to_binding(conn, task_id=task_id, manager_id=manager_id)
                conn.commit()

            original_manager_session_exists = lifecycle.manager_session_exists
            original_session_exists = lifecycle.session_exists
            original_run = lifecycle.run
            original_session_snapshot = worker_identity.session_snapshot
            try:
                lifecycle.manager_session_exists = lambda session: session == "codex-manager-task-a"
                lifecycle.session_exists = lambda worker: worker == "worker-a"
                worker_identity.session_snapshot = lambda session: {
                    "live": True,
                    "pane_id": "%2" if session == "codex-manager-task-a" else "%1",
                    "session": session,
                }
                run_calls = []
                lifecycle.run = lambda *args, **kwargs: (
                    run_calls.append(args[0]) or subprocess.CompletedProcess(args[0], 0, "", "")
                )
                args = argparse.Namespace(
                    message=None,
                    path=str(db_path),
                    reason="work is complete",
                    stop_manager=False,
                    stop_worker=False,
                    task="task-a",
                )

                with contextlib.redirect_stdout(io.StringIO()) as stdout:
                    result = lifecycle.command_finish_task(args)

                payload = json.loads(stdout.getvalue())
                self.assertEqual(result, 0)
                self.assertTrue(payload["finish"])
                self.assertFalse(payload["killed_manager"])
                self.assertFalse(payload["killed_worker"])
                self.assertFalse(payload["stop_manager"])
                self.assertIsNotNone(payload["final_decision_id"])
                with worker_db.connect(db_path) as conn:
                    task = conn.execute("select state from tasks where id = ?", (task_id,)).fetchone()
                    binding = conn.execute("select state, ended_at from bindings where id = 'binding-1'").fetchone()
                    manager = conn.execute("select state from managers where id = ?", (manager_id,)).fetchone()
                    worker = conn.execute("select state from workers where name = 'worker-a'").fetchone()
                    command = conn.execute("select state from commands where type = 'finish_task'").fetchone()
                    decision = conn.execute("select decision, reason from manager_decisions").fetchone()
                    event = conn.execute("select type from events where type = 'finish_task_succeeded'").fetchone()
                self.assertEqual(task["state"], "done")
                self.assertEqual(binding["state"], "ended")
                self.assertIsNotNone(binding["ended_at"])
                self.assertEqual(manager["state"], "ready")
                self.assertEqual(worker["state"], "active")
                self.assertEqual(command["state"], "succeeded")
                self.assertEqual(decision["decision"], "stop")
                self.assertEqual(decision["reason"], "work is complete")
                self.assertEqual(event["type"], "finish_task_succeeded")
                self.assertEqual(run_calls, [])
            finally:
                lifecycle.manager_session_exists = original_manager_session_exists
                lifecycle.session_exists = original_session_exists
                lifecycle.run = original_run
                worker_identity.session_snapshot = original_session_snapshot
                if worker_path.exists():
                    shutil.rmtree(worker_path)

    def test_finish_task_stop_manager_flag_closes_manager(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "workerctl.db"
            worker_path = worker_dir("worker-a")
            if worker_path.exists():
                shutil.rmtree(worker_path)
            worker_path.mkdir(parents=True)
            config_path("worker-a").write_text(
                json.dumps(
                    {
                        "identity_token": "token-worker-a",
                        "name": "worker-a",
                        "tmux_pane_id": "%1",
                        "tmux_session": "codex-worker-a",
                    }
                )
                + "\n"
            )
            with worker_db.connect(db_path) as conn:
                worker_db.initialize_database(conn)
                worker_db.upsert_worker(
                    conn,
                    name="worker-a",
                    cwd=str(ROOT),
                    tmux_session="codex-worker-a",
                    identity_token="token-worker-a",
                    tmux_pane_id="%1",
                    state="active",
                )
                task_id = worker_db.create_task(conn, name="task-a", goal="Do task A.")
                worker_db.bind_task_worker(conn, task="task-a", worker="worker-a", binding_id="binding-1")
                manager_id = worker_db.create_manager(
                    conn,
                    task_id=task_id,
                    name="manager-a",
                    tmux_session="codex-manager-task-a",
                    tmux_pane_id="%2",
                    codex_args=[],
                    state="ready",
                )
                worker_db.attach_manager_to_binding(conn, task_id=task_id, manager_id=manager_id)
                conn.commit()

            original_manager_session_exists = lifecycle.manager_session_exists
            original_session_exists = lifecycle.session_exists
            original_run = lifecycle.run
            original_session_snapshot = worker_identity.session_snapshot
            try:
                lifecycle.manager_session_exists = lambda session: session == "codex-manager-task-a"
                lifecycle.session_exists = lambda worker: worker == "worker-a"
                worker_identity.session_snapshot = lambda session: {
                    "live": True,
                    "pane_id": "%2" if session == "codex-manager-task-a" else "%1",
                    "session": session,
                }
                run_calls = []
                lifecycle.run = lambda *args, **kwargs: (
                    run_calls.append(args[0]) or subprocess.CompletedProcess(args[0], 0, "", "")
                )
                args = argparse.Namespace(
                    message=None,
                    path=str(db_path),
                    reason="work is complete",
                    stop_manager=True,
                    stop_worker=False,
                    task="task-a",
                )

                with contextlib.redirect_stdout(io.StringIO()) as stdout:
                    result = lifecycle.command_finish_task(args)

                payload = json.loads(stdout.getvalue())
                self.assertEqual(result, 0)
                self.assertTrue(payload["finish"])
                self.assertTrue(payload["killed_manager"])
                self.assertTrue(payload["stop_manager"])
                with worker_db.connect(db_path) as conn:
                    task = conn.execute("select state from tasks where id = ?", (task_id,)).fetchone()
                    binding = conn.execute("select state, ended_at from bindings where id = 'binding-1'").fetchone()
                    manager = conn.execute("select state from managers where id = ?", (manager_id,)).fetchone()
                self.assertEqual(task["state"], "done")
                self.assertEqual(binding["state"], "ended")
                self.assertIsNotNone(binding["ended_at"])
                self.assertEqual(manager["state"], "stopped")
                self.assertEqual(run_calls, [["tmux", "kill-session", "-t", "codex-manager-task-a"]])
            finally:
                lifecycle.manager_session_exists = original_manager_session_exists
                lifecycle.session_exists = original_session_exists
                lifecycle.run = original_run
                worker_identity.session_snapshot = original_session_snapshot
                if worker_path.exists():
                    shutil.rmtree(worker_path)

    def test_finish_task_stops_session_bound_worker_and_manager(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "workerctl.db"
            with worker_db.connect(db_path) as conn:
                worker_db.initialize_database(conn)
                task_id = worker_db.create_task(conn, name="session-task", goal="Do task.")
                worker_db.register_session(
                    conn,
                    name="session-worker",
                    role="worker",
                    codex_session_path="/tmp/worker.jsonl",
                    codex_session_id="codex-worker",
                    pid=111,
                    cwd=str(ROOT),
                    tmux_session="codex-session-worker",
                    tmux_pane_id="%1",
                )
                worker_db.register_session(
                    conn,
                    name="session-manager",
                    role="manager",
                    codex_session_path="/tmp/manager.jsonl",
                    codex_session_id="codex-manager",
                    pid=222,
                    cwd=str(ROOT),
                    tmux_session="codex-session-manager",
                    tmux_pane_id="%2",
                )
                binding_id = worker_db.bind_sessions(
                    conn,
                    task_name="session-task",
                    worker_session_name="session-worker",
                    manager_session_name="session-manager",
                )
                conn.commit()

            original_run = lifecycle.run
            original_session_snapshot = worker_identity.session_snapshot
            try:
                run_calls = []

                def fake_run(argv, **kwargs):
                    run_calls.append(argv)
                    return subprocess.CompletedProcess(argv, 0, "", "")

                lifecycle.run = fake_run
                worker_identity.session_snapshot = lambda session: {
                    "live": True,
                    "pane_id": "%2" if session == "codex-session-manager" else "%1",
                    "session": session,
                }
                args = argparse.Namespace(
                    message=None,
                    path=str(db_path),
                    reason="session work complete",
                    stop_manager=True,
                    stop_worker=True,
                    task="session-task",
                    require_criteria_audit=True,
                    decision_id=None,
                    strict_decisions=False,
                )

                with contextlib.redirect_stdout(io.StringIO()) as stdout:
                    result = lifecycle.command_finish_task(args)

                payload = json.loads(stdout.getvalue())
                self.assertEqual(result, 0)
                self.assertTrue(payload["killed_manager"])
                self.assertTrue(payload["killed_worker"])
                self.assertEqual(payload["manager_session"], "session-manager")
                self.assertEqual(payload["worker"], "session-worker")
                self.assertEqual(
                    [call for call in run_calls if call[:2] == ["tmux", "kill-session"]],
                    [
                        ["tmux", "kill-session", "-t", "codex-session-manager"],
                        ["tmux", "kill-session", "-t", "codex-session-worker"],
                    ],
                )
                with worker_db.connect(db_path) as conn:
                    task = conn.execute("select state from tasks where id = ?", (task_id,)).fetchone()
                    binding = conn.execute("select state, ended_at from bindings where id = ?", (binding_id,)).fetchone()
                    sessions = {
                        row["name"]: row["state"]
                        for row in conn.execute("select name, state from sessions")
                    }
                    command = conn.execute("select state, result_json from commands where type = 'finish_task'").fetchone()
                self.assertEqual(task["state"], "done")
                self.assertEqual(binding["state"], "ended")
                self.assertIsNotNone(binding["ended_at"])
                self.assertEqual(sessions["session-worker"], "gone")
                self.assertEqual(sessions["session-manager"], "gone")
                self.assertEqual(command["state"], "succeeded")
                self.assertEqual(json.loads(command["result_json"])["worker"], "session-worker")
            finally:
                lifecycle.run = original_run
                worker_identity.session_snapshot = original_session_snapshot

    def test_stop_task_refuses_worker_pane_mismatch_before_kill(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "workerctl.db"
            worker_path = worker_dir("worker-a")
            if worker_path.exists():
                shutil.rmtree(worker_path)
            worker_path.mkdir(parents=True)
            config_path("worker-a").write_text(
                json.dumps(
                    {
                        "identity_token": "token-worker-a",
                        "name": "worker-a",
                        "tmux_pane_id": "%1",
                        "tmux_session": "codex-worker-a",
                    }
                )
                + "\n"
            )
            with worker_db.connect(db_path) as conn:
                worker_db.initialize_database(conn)
                worker_db.upsert_worker(
                    conn,
                    name="worker-a",
                    cwd=str(ROOT),
                    tmux_session="codex-worker-a",
                    identity_token="token-worker-a",
                    tmux_pane_id="%1",
                    state="active",
                )
                task_id = worker_db.create_task(conn, name="task-a", goal="Do task A.")
                worker_db.bind_task_worker(conn, task="task-a", worker="worker-a", binding_id="binding-1")
                conn.commit()

            killed = []
            original_run = lifecycle.run
            original_session_snapshot = worker_identity.session_snapshot
            try:
                def fake_run(argv, **kwargs):
                    if argv[:2] == ["tmux", "kill-session"]:
                        killed.append(argv)
                    return subprocess.CompletedProcess(argv, 0, "", "")

                lifecycle.run = fake_run
                worker_identity.session_snapshot = lambda session: {"live": True, "pane_id": "%9", "session": session}
                args = argparse.Namespace(message=None, path=str(db_path), stop_worker=True, task="task-a")

                with self.assertRaisesRegex(WorkerError, "tmux_pane_mismatch"):
                    lifecycle.command_stop_task(args)

                self.assertEqual(killed, [])
                with worker_db.connect(db_path) as conn:
                    task = conn.execute("select state from tasks where id = ?", (task_id,)).fetchone()
                    worker = conn.execute("select state from workers where name = 'worker-a'").fetchone()
                    command = conn.execute("select state from commands where type = 'stop_task'").fetchone()
                self.assertEqual(task["state"], "managed")
                self.assertEqual(worker["state"], "active")
                self.assertEqual(command["state"], "failed")
            finally:
                lifecycle.run = original_run
                worker_identity.session_snapshot = original_session_snapshot
                if worker_path.exists():
                    shutil.rmtree(worker_path)

    def test_export_task_writes_bundle_and_zip(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "workerctl.db"
            output = Path(tmpdir) / "export"
            with worker_db.connect(db_path) as conn:
                worker_db.initialize_database(conn)
                worker_db.upsert_worker(
                    conn,
                    name="worker-a",
                    cwd=str(ROOT),
                    tmux_session="codex-worker-a",
                    state="active",
                )
                task_id = worker_db.create_task(conn, name="task-a", goal="Do task A.")
                worker_db.bind_task_worker(conn, task="task-a", worker="worker-a", binding_id="binding-1")
                capture_id = worker_db.insert_terminal_capture(
                    conn,
                    task_id=task_id,
                    role="worker",
                    tmux_session="codex-worker-a",
                    content_sha256="sha-1",
                    content="worker transcript",
                    history_lines=20,
                    source="test",
                    classifier={},
                )
                worker_db.insert_transcript_segment(
                    conn,
                    task_id=task_id,
                    role="worker",
                    source_capture_id=capture_id,
                    previous_capture_id=None,
                    content_sha256="sha-1",
                    segment_text="worker transcript",
                    segment_start_line=1,
                    segment_end_line=1,
                    segment_kind="reset",
                )
                worker_db.insert_prompt(
                    conn,
                    task_id=task_id,
                    kind="manager",
                    content="prompt",
                    content_sha256="hash",
                    generator_version="test",
                    source_snapshot={"worker": "worker-a"},
                    policy={"max_nudges": 1},
                )
                conn.commit()

            proc = self.run_workerctl(
                "export-task",
                "task-a",
                "--output",
                str(output),
                "--zip",
                "--include-full-transcripts",
                "--path",
                str(db_path),
            )

            self.assertEqual(proc.returncode, 0, proc.stderr)
            payload = json.loads(proc.stdout)
            self.assertEqual(payload["export_dir"], str(output.resolve()))
            self.assertTrue((output / "manifest.json").exists())
            self.assertTrue((output / "task-status.json").exists())
            self.assertTrue((output / "terminal-captures.json").exists())
            self.assertTrue((output / "agent-observations.json").exists())
            self.assertTrue((output / "manager-cycles.json").exists())
            self.assertTrue((output / "manager-decisions.json").exists())
            self.assertTrue((output / "mutation-audit.json").exists())
            self.assertTrue((output / "replay.json").exists())
            self.assertTrue((output / "transcript-segments.json").exists())
            self.assertTrue((output / "replay-full-transcript.json").exists())
            self.assertTrue((output / "transcripts" / "worker.txt").exists())
            self.assertTrue(output.with_suffix(".zip").exists())
            mutation_audit = json.loads((output / "mutation-audit.json").read_text())
            self.assertTrue(mutation_audit["ok"])
            self.assertEqual(mutation_audit["summary"]["mutations"], 0)
            replay = json.loads((output / "replay.json").read_text())
            self.assertEqual(replay["task"]["name"], "task-a")
            self.assertIn("worker transcript", (output / "transcripts" / "worker.txt").read_text())

    def test_task_scoped_read_commands_are_listed_in_help(self):
        proc = self.run_workerctl("--help")

        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("audit", proc.stdout)
        self.assertIn("commands", proc.stdout)
        self.assertIn("doctor-self", proc.stdout)
        self.assertIn("import-compat", proc.stdout)
        self.assertIn("mutation-audit", proc.stdout)
        self.assertIn("open-manager", proc.stdout)
        self.assertIn("open-worker", proc.stdout)
        self.assertIn("prune", proc.stdout)
        self.assertIn("qa-plan", proc.stdout)
        self.assertIn("reconcile", proc.stdout)
        self.assertIn("replay", proc.stdout)
        self.assertIn("start", proc.stdout)
        self.assertIn("stop-task", proc.stdout)
        self.assertIn("export-task", proc.stdout)
        self.assertIn("finish-task", proc.stdout)
        self.assertIn("transcript-capture", proc.stdout)
        self.assertIn("transcript-prune", proc.stdout)
        self.assertIn("transcript-show", proc.stdout)

    def test_stop_task_help_includes_reason(self):
        proc = self.run_workerctl("stop-task", "--help")

        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("--reason", proc.stdout)

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

    def test_update_status_help_includes_contract_fields(self):
        proc = self.run_workerctl("update-status", "--help")

        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("--state", proc.stdout)
        self.assertIn("--current-task", proc.stdout)
        self.assertIn("--next-action", proc.stdout)

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
        self.assertIn("manage-codex-workers", proc.stdout)

    def test_install_local_write_is_idempotent(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            profile = Path(tmpdir) / ".zshrc"
            env = os.environ.copy()
            env["WORKERCTL_INSTALL_PROFILE"] = str(profile)
            env["CODEX_HOME"] = str(Path(tmpdir) / "codex-home")
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
            skill_path = Path(env["CODEX_HOME"]) / "skills" / "manage-codex-workers" / "SKILL.md"
            self.assertTrue(skill_path.exists())

    def test_create_dual_writes_worker_and_initial_status_to_sqlite(self):
        name = "db-create-dual-write"
        worker_path = worker_dir(name)
        if worker_path.exists():
            shutil.rmtree(worker_path)
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "workerctl.db"
            original_connect_db = commands.connect_db
            original_ensure_tool = commands.ensure_tool
            original_current_pane_id = commands.current_pane_id
            original_run = commands.run
            original_session_exists = commands.session_exists
            commands.connect_db = lambda path=None: worker_db.connect(db_path if path is None else path)
            commands.ensure_tool = lambda tool: tool
            commands.current_pane_id = lambda target: "%1"
            commands.run = lambda *args, **kwargs: subprocess.CompletedProcess(args[0], 0, "", "")
            commands.session_exists = lambda worker_name: False
            args = argparse.Namespace(
                accept_trust=False,
                cwd=str(ROOT),
                force_open=False,
                initial_prompt=True,
                name=name,
                open=False,
                reuse=False,
                stop_after=False,
                task="Write initial status.",
                terminal="auto",
                verify=False,
                verify_timeout=1,
                wait_ready=False,
                wait_ready_timeout=1,
            )
            try:
                with contextlib.redirect_stdout(io.StringIO()):
                    commands.command_create(args)
                config = json.loads(config_path(name).read_text())
                contract = (worker_dir(name) / "contract.txt").read_text()
                with worker_db.connect(db_path) as conn:
                    worker = conn.execute("select * from workers where name = ?", (name,)).fetchone()
                    self.assertIsNotNone(worker)
                    self.assertEqual(worker["state"], "active")
                    self.assertEqual(worker["tmux_pane_id"], "%1")
                    self.assertEqual(worker["identity_token"], config["identity_token"])
                    self.assertIn(config["identity_token"], contract)
                    status = conn.execute(
                        "select * from statuses where worker_id = ? order by id desc limit 1",
                        (worker["id"],),
                    ).fetchone()
                    self.assertIsNotNone(status)
                    self.assertEqual(status["state"], "waiting")
                    event_types = [
                        row["type"]
                        for row in conn.execute("select type from events where worker_id = ? order by id", (worker["id"],))
                    ]
                    self.assertEqual(event_types, ["worker_create_recorded", "worker_tmux_started"])
            finally:
                commands.connect_db = original_connect_db
                commands.ensure_tool = original_ensure_tool
                commands.current_pane_id = original_current_pane_id
                commands.run = original_run
                commands.session_exists = original_session_exists
                if worker_path.exists():
                    shutil.rmtree(worker_path)

    def test_update_status_writes_sqlite_and_compatibility_json(self):
        name = "db-update-status"
        worker_path = worker_dir(name)
        if worker_path.exists():
            shutil.rmtree(worker_path)
        worker_path.mkdir(parents=True)
        config_path(name).write_text(
            json.dumps(
                {
                    "cwd": str(ROOT),
                    "name": name,
                    "tmux_pane_id": "%1",
                    "tmux_session": f"codex-{name}",
                }
            )
            + "\n"
        )
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "workerctl.db"
            original_connect_db = commands.connect_db
            commands.connect_db = lambda path=None: worker_db.connect(db_path if path is None else path)
            args = argparse.Namespace(
                blocker=None,
                current_task="Editing SQLite status bridge.",
                name=name,
                next_action="Run tests.",
                state="editing",
            )
            try:
                with contextlib.redirect_stdout(io.StringIO()):
                    commands.command_update_status(args)
                status = json.loads(status_path(name).read_text())
                self.assertEqual(status["state"], "editing")
                self.assertEqual(status["current_task"], "Editing SQLite status bridge.")
                self.assertEqual(status["next_action"], "Run tests.")
                self.assertIsNone(status["blocker"])
                self.assertIn("last_update", status)

                with worker_db.connect(db_path) as conn:
                    worker = conn.execute("select * from workers where name = ?", (name,)).fetchone()
                    self.assertIsNotNone(worker)
                    self.assertEqual(worker["state"], "active")
                    db_status = conn.execute(
                        "select * from statuses where worker_id = ? order by id desc limit 1",
                        (worker["id"],),
                    ).fetchone()
                    self.assertEqual(db_status["state"], "editing")
                    self.assertEqual(db_status["current_task"], "Editing SQLite status bridge.")
                    event = conn.execute(
                        "select * from events where worker_id = ? order by id desc limit 1",
                        (worker["id"],),
                    ).fetchone()
                    self.assertEqual(event["type"], "status_updated")
            finally:
                commands.connect_db = original_connect_db
                if worker_path.exists():
                    shutil.rmtree(worker_path)

    def test_capture_output_dual_writes_sqlite_and_compatibility_files(self):
        name = "db-capture-output"
        worker_path = worker_dir(name)
        if worker_path.exists():
            shutil.rmtree(worker_path)
        worker_path.mkdir(parents=True)
        config_path(name).write_text(
            json.dumps(
                {
                    "cwd": str(ROOT),
                    "name": name,
                    "tmux_pane_id": "%1",
                    "tmux_session": f"codex-{name}",
                }
            )
            + "\n"
        )
        status_path(name).write_text(json.dumps({"state": "waiting"}) + "\n")
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "workerctl.db"
            original_connect_db = worker_tmux.connect_db
            original_session_exists = worker_tmux.session_exists
            original_capture_tmux_target = worker_tmux.capture_tmux_target
            worker_tmux.connect_db = lambda path=None: worker_db.connect(db_path if path is None else path)
            worker_tmux.session_exists = lambda worker_name: True
            worker_tmux.capture_tmux_target = lambda target, lines: "line one\nline two"
            try:
                output = worker_tmux.capture_output(name, 50)
                second_output = worker_tmux.capture_output(name, 50)

                self.assertEqual(output, "line one\nline two")
                self.assertEqual(second_output, "line one\nline two")
                self.assertEqual(transcript_path(name).read_text(), "line one\nline two\n")
                meta = json.loads(capture_meta_path(name).read_text())
                self.assertEqual(meta["history_lines"], 50)
                self.assertIn("sha256", meta)

                with worker_db.connect(db_path) as conn:
                    worker = conn.execute("select * from workers where name = ?", (name,)).fetchone()
                    captures = [
                        dict(row)
                        for row in conn.execute(
                            "select * from transcript_captures where worker_id = ? order by id",
                            (worker["id"],),
                        )
                    ]
                    self.assertEqual(len(captures), 2)
                    self.assertEqual(captures[0]["capture_kind"], "changed")
                    self.assertEqual(captures[0]["content"], "line one\nline two")
                    self.assertEqual(captures[0]["line_count"], 2)
                    self.assertEqual(captures[1]["capture_kind"], "metadata_only")
                    self.assertIsNone(captures[1]["content"])
            finally:
                worker_tmux.connect_db = original_connect_db
                worker_tmux.session_exists = original_session_exists
                worker_tmux.capture_tmux_target = original_capture_tmux_target
                if worker_path.exists():
                    shutil.rmtree(worker_path)


class CriteriaFinalAuditTests(unittest.TestCase):
    def _create_task(self, db_path, *, name="criteria-final-task"):
        with worker_db.connect(db_path) as conn:
            worker_db.initialize_database(conn)
            task_id = worker_db.create_task(conn, name=name, goal="Finish only after criteria are audited.")
            worker_db.set_task_state(conn, task_id=task_id, state="managed")
            conn.commit()
        return task_id

    def _finish_args(self, db_path, *, task="criteria-final-task", require_criteria_audit=True):
        return argparse.Namespace(
            decision_id=None,
            message=None,
            path=str(db_path),
            reason="final criteria audit passed",
            require_criteria_audit=require_criteria_audit,
            stop_manager=False,
            stop_worker=False,
            strict_decisions=False,
            task=task,
        )

    def test_finish_task_with_criteria_audit_fails_when_accepted_criteria_are_open(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "workerctl.db"
            task_id = self._create_task(db_path)
            with worker_db.connect(db_path) as conn:
                worker_db.insert_acceptance_criterion(
                    conn,
                    task_id=task_id,
                    criterion="Run final regression tests",
                    status="accepted",
                    source="user_requested",
                )
                conn.commit()

            with self.assertRaises(WorkerError):
                lifecycle.command_finish_task(self._finish_args(db_path))

            with worker_db.connect(db_path) as conn:
                task = conn.execute("select state from tasks where id = ?", (task_id,)).fetchone()
                command = conn.execute(
                    "select state, result_json, error from commands where type = 'finish_task'"
                ).fetchone()
                event = conn.execute(
                    "select type, payload_json from events where type = 'finish_task_failed'"
                ).fetchone()
            self.assertEqual(task["state"], "managed")
            self.assertIsNotNone(command)
            self.assertEqual(command["state"], "failed")
            self.assertIn("accepted acceptance criteria still open", command["error"])
            self.assertIsNotNone(event)
            self.assertTrue(json.loads(command["result_json"])["expected_failure"])
            self.assertTrue(json.loads(event["payload_json"])["expected_failure"])

    def test_finish_task_with_criteria_audit_succeeds_after_accepted_criteria_are_closed(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "workerctl.db"
            task_id = self._create_task(db_path)
            statuses = ["satisfied", "deferred", "rejected", "proposed"]
            with worker_db.connect(db_path) as conn:
                for status in statuses:
                    worker_db.insert_acceptance_criterion(
                        conn,
                        task_id=task_id,
                        criterion=f"Criterion is {status}",
                        status=status,
                        source="worker_proposed",
                    )
                conn.commit()

            with contextlib.redirect_stdout(io.StringIO()) as stdout:
                result = lifecycle.command_finish_task(self._finish_args(db_path))

            payload = json.loads(stdout.getvalue())
            self.assertEqual(result, 0)
            self.assertTrue(payload["final_audit"]["require_criteria_audit"])
            self.assertEqual(payload["final_audit"]["open_criteria"], [])
            self.assertEqual(payload["final_audit"]["summary"]["accepted"], 0)
            self.assertEqual(payload["final_audit"]["summary"]["proposed"], 1)
            with worker_db.connect(db_path) as conn:
                task = conn.execute("select state from tasks where id = ?", (task_id,)).fetchone()
            self.assertEqual(task["state"], "done")

    def test_finish_task_criteria_audit_failure_lists_open_ids_and_text(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "workerctl.db"
            task_id = self._create_task(db_path)
            with worker_db.connect(db_path) as conn:
                first_id = worker_db.insert_acceptance_criterion(
                    conn,
                    task_id=task_id,
                    criterion="Confirm deployment receipts",
                    status="accepted",
                    source="manager_inferred",
                )
                second_id = worker_db.insert_acceptance_criterion(
                    conn,
                    task_id=task_id,
                    criterion="Verify rollback notes",
                    status="accepted",
                    source="worker_proposed",
                )
                conn.commit()

            with self.assertRaises(WorkerError) as raised:
                lifecycle.command_finish_task(self._finish_args(db_path))

            message = str(raised.exception)
            self.assertIn(f"#{first_id}", message)
            self.assertIn("Confirm deployment receipts", message)
            self.assertIn(f"#{second_id}", message)
            self.assertIn("Verify rollback notes", message)

            with worker_db.connect(db_path) as conn:
                audit = worker_db.task_audit(conn, task="criteria-final-task")
            command = [row for row in audit["commands"] if row["type"] == "finish_task"][0]
            self.assertEqual(command["state"], "failed")
            self.assertEqual(command["result"]["failure_stage"], "final_criteria_audit")
            self.assertEqual(command["result"]["final_audit"]["summary"]["accepted"], 2)

    def test_finish_task_criteria_audit_success_records_result_and_event_metadata(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "workerctl.db"
            task_id = self._create_task(db_path)
            with worker_db.connect(db_path) as conn:
                worker_db.insert_acceptance_criterion(
                    conn,
                    task_id=task_id,
                    criterion="Ship docs update",
                    status="satisfied",
                    source="user_requested",
                )
                worker_db.insert_acceptance_criterion(
                    conn,
                    task_id=task_id,
                    criterion="Consider follow-up dashboard",
                    status="proposed",
                    source="worker_proposed",
                )
                conn.commit()

            with contextlib.redirect_stdout(io.StringIO()) as stdout:
                lifecycle.command_finish_task(self._finish_args(db_path))

            payload = json.loads(stdout.getvalue())
            with worker_db.connect(db_path) as conn:
                command = conn.execute(
                    "select payload_json, result_json from commands where type = 'finish_task'"
                ).fetchone()
                audit_event = conn.execute(
                    "select payload_json from events where type = 'finish_task_criteria_audit' and task_id = ?",
                    (task_id,),
                ).fetchone()
                succeeded_event = conn.execute(
                    "select payload_json from events where type = 'finish_task_succeeded' and task_id = ?",
                    (task_id,),
                ).fetchone()

            command_payload = json.loads(command["payload_json"])
            command_result = json.loads(command["result_json"])
            audit_payload = json.loads(audit_event["payload_json"])
            succeeded_payload = json.loads(succeeded_event["payload_json"])
            self.assertEqual(command_result["final_audit"], payload["final_audit"])
            self.assertEqual(succeeded_payload["final_audit"], payload["final_audit"])
            self.assertEqual(audit_payload, payload["final_audit"])
            self.assertTrue(command_payload["final_audit"]["require_criteria_audit"])
            self.assertTrue(command_result["final_audit"]["require_criteria_audit"])
            self.assertEqual(command_result["final_audit"]["open_criteria"], [])
            self.assertEqual(command_result["final_audit"]["summary"]["satisfied"], 1)
            self.assertEqual(command_result["final_audit"]["summary"]["proposed"], 1)


def _tmux_integration_skip_reason() -> str | None:
    if shutil.which("tmux") is None:
        return "tmux is not installed"

    session = f"workerctl-test-probe-{os.getpid()}"
    try:
        subprocess.run(
            ["tmux", "kill-session", "-t", session],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=2,
        )
        proc = subprocess.run(
            ["tmux", "new-session", "-d", "-s", session, "sleep 1"],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=2,
        )
    except subprocess.TimeoutExpired:
        return "tmux integration unavailable: probe timed out"

    if proc.returncode != 0:
        detail = (proc.stderr or proc.stdout or "tmux new-session failed").strip()
        return f"tmux integration unavailable: {detail}"

    try:
        subprocess.run(
            ["tmux", "kill-session", "-t", session],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=2,
        )
    except subprocess.TimeoutExpired:
        return "tmux integration unavailable: probe timed out"

    return None


class TmuxIntegrationCapabilityTests(unittest.TestCase):
    def test_missing_tmux_returns_installed_reason(self):
        with mock.patch("tests.test_workerctl.shutil.which", return_value=None), mock.patch(
            "tests.test_workerctl.subprocess.run"
        ) as run:
            reason = _tmux_integration_skip_reason()

        self.assertEqual(reason, "tmux is not installed")
        run.assert_not_called()

    def test_new_session_failure_returns_detail_and_attempts_probe(self):
        calls = []

        def fake_run(argv, **kwargs):
            calls.append((argv, kwargs))
            if argv[:2] == ["tmux", "new-session"]:
                return subprocess.CompletedProcess(argv, 1, "", "Operation not permitted\n")
            return subprocess.CompletedProcess(argv, 0, "", "")

        session = f"workerctl-test-probe-{os.getpid()}"
        with mock.patch("tests.test_workerctl.shutil.which", return_value="/usr/bin/tmux"), mock.patch(
            "tests.test_workerctl.subprocess.run", side_effect=fake_run
        ):
            reason = _tmux_integration_skip_reason()

        self.assertEqual(reason, "tmux integration unavailable: Operation not permitted")
        self.assertEqual(
            calls,
            [
                (
                    ["tmux", "kill-session", "-t", session],
                    {"stdout": subprocess.PIPE, "stderr": subprocess.PIPE, "timeout": 2},
                ),
                (
                    ["tmux", "new-session", "-d", "-s", session, "sleep 1"],
                    {"stdout": subprocess.PIPE, "stderr": subprocess.PIPE, "text": True, "timeout": 2},
                ),
            ],
        )

    def test_successful_probe_returns_none_and_cleans_up(self):
        calls = []

        def fake_run(argv, **kwargs):
            calls.append((argv, kwargs))
            return subprocess.CompletedProcess(argv, 0, "", "")

        session = f"workerctl-test-probe-{os.getpid()}"
        with mock.patch("tests.test_workerctl.shutil.which", return_value="/usr/bin/tmux"), mock.patch(
            "tests.test_workerctl.subprocess.run", side_effect=fake_run
        ):
            reason = _tmux_integration_skip_reason()

        self.assertIsNone(reason)
        self.assertEqual(
            calls,
            [
                (
                    ["tmux", "kill-session", "-t", session],
                    {"stdout": subprocess.PIPE, "stderr": subprocess.PIPE, "timeout": 2},
                ),
                (
                    ["tmux", "new-session", "-d", "-s", session, "sleep 1"],
                    {"stdout": subprocess.PIPE, "stderr": subprocess.PIPE, "text": True, "timeout": 2},
                ),
                (
                    ["tmux", "kill-session", "-t", session],
                    {"stdout": subprocess.PIPE, "stderr": subprocess.PIPE, "timeout": 2},
                ),
            ],
        )

    def test_probe_timeout_returns_timeout_reason(self):
        def fake_run(argv, **kwargs):
            raise subprocess.TimeoutExpired(argv, kwargs["timeout"])

        with mock.patch("tests.test_workerctl.shutil.which", return_value="/usr/bin/tmux"), mock.patch(
            "tests.test_workerctl.subprocess.run", side_effect=fake_run
        ):
            reason = _tmux_integration_skip_reason()

        self.assertEqual(reason, "tmux integration unavailable: probe timed out")

    def test_real_tmux_skip_is_method_scoped(self):
        self.assertFalse(getattr(TmuxTests, "__unittest_skip__", False))
        tmux_methods = [
            TmuxTests.test_send_text_pastes_and_submits_line,
            TmuxTests.test_open_refuses_second_window_without_force,
            TmuxTests.test_open_refuses_after_prior_attempt_without_force,
        ]
        for method in tmux_methods:
            self.assertEqual(
                getattr(method, "__unittest_skip__", False),
                bool(TMUX_INTEGRATION_SKIP_REASON),
            )
        self.assertFalse(getattr(TmuxTests.test_open_manager_dry_run_resolves_task_manager, "__unittest_skip__", False))


TMUX_INTEGRATION_SKIP_REASON = _tmux_integration_skip_reason()
requires_tmux_integration = unittest.skipIf(TMUX_INTEGRATION_SKIP_REASON, TMUX_INTEGRATION_SKIP_REASON)


class TmuxTests(unittest.TestCase):
    @requires_tmux_integration
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

    @requires_tmux_integration
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

    @requires_tmux_integration
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

    def test_open_manager_dry_run_resolves_task_manager(self):
        original_run = commands.run
        try:
            commands.run = lambda *args, **kwargs: subprocess.CompletedProcess(args[0], 0, "", "")
            with tempfile.TemporaryDirectory() as tmpdir:
                db_path = Path(tmpdir) / "workerctl.db"
                with worker_db.connect(db_path) as conn:
                    worker_db.initialize_database(conn)
                    worker_db.upsert_worker(
                        conn,
                        name="worker-a",
                        cwd=str(ROOT),
                        tmux_session="codex-worker-a",
                        state="active",
                    )
                    task_id = worker_db.create_task(conn, name="task-a", goal="Do task A.")
                    worker_db.bind_task_worker(conn, task="task-a", worker="worker-a", binding_id="binding-1")
                    manager_id = worker_db.create_manager(
                        conn,
                        task_id=task_id,
                        name="manager-a",
                        tmux_session="codex-manager-task-a",
                        codex_args=[],
                        state="ready",
                    )
                    worker_db.attach_manager_to_binding(conn, task_id=task_id, manager_id=manager_id)
                    conn.commit()

                args = argparse.Namespace(dry_run=True, path=str(db_path), task="task-a", terminal="terminal")
                with contextlib.redirect_stdout(io.StringIO()) as stdout:
                    result = commands.command_open_manager(args)

                payload = json.loads(stdout.getvalue())
                self.assertEqual(result, 0)
                self.assertTrue(payload["dry_run"])
                self.assertEqual(payload["task"], "task-a")
                self.assertEqual(payload["manager"], "manager-a")
                self.assertEqual(payload["attach_command"], "tmux attach -t codex-manager-task-a")
        finally:
            commands.run = original_run


class CodexSessionDiscoveryTests(unittest.TestCase):
    def test_read_session_meta_parses_first_line(self):
        from workerctl import codex_session

        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "rollout-2026-05-11T07-32-08-abc.jsonl"
            meta_line = json.dumps({
                "timestamp": "2026-05-11T14:32:11.791Z",
                "type": "session_meta",
                "payload": {
                    "id": "019e1773-d973-7122-a8d6-f25331ebc8b7",
                    "cwd": "/repo",
                    "originator": "codex-tui",
                    "cli_version": "0.130.0",
                },
            })
            path.write_text(meta_line + "\n" + '{"type":"event_msg"}\n')
            meta = codex_session.read_session_meta(path)

            self.assertEqual(meta["id"], "019e1773-d973-7122-a8d6-f25331ebc8b7")
            self.assertEqual(meta["cwd"], "/repo")
            self.assertEqual(meta["originator"], "codex-tui")

    def test_read_session_meta_raises_on_wrong_type(self):
        from workerctl import codex_session

        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "bad.jsonl"
            path.write_text('{"type":"event_msg","payload":{}}\n')
            with self.assertRaises(codex_session.CodexSessionError):
                codex_session.read_session_meta(path)

    def test_find_native_codex_pid_returns_self_when_already_native(self):
        from workerctl import codex_session
        # When the input pid is already a native codex binary, return it unchanged.
        # We stub the helper to make this deterministic.
        result = codex_session.find_native_codex_pid(99999, _ps_children=lambda _: [])
        self.assertEqual(result, 99999)

    def test_find_native_codex_pid_walks_to_child_when_node_wrapper(self):
        from workerctl import codex_session
        # node parent with one native codex child
        children_by_pid = {1000: [2000]}

        def fake_ps_children(pid):
            return children_by_pid.get(pid, [])

        result = codex_session.find_native_codex_pid(1000, _ps_children=fake_ps_children)
        self.assertEqual(result, 2000)

    def test_find_rollout_path_for_pid_returns_rollout_handle(self):
        from workerctl import codex_session

        fake_lsof_output = (
            "codex   31507 user   25w  REG  1,17  277502  41320170 "
            "/Users/u/.codex/sessions/2026/05/11/rollout-2026-05-11T10-54-17-abc.jsonl\n"
            "codex   31507 user   26r  REG  1,17     128  12345678 "
            "/Users/u/.codex/config.toml\n"
        )

        def fake_run_lsof(pid):
            return fake_lsof_output

        path = codex_session.find_rollout_path_for_pid(31507, _run_lsof=fake_run_lsof)
        self.assertEqual(
            str(path),
            "/Users/u/.codex/sessions/2026/05/11/rollout-2026-05-11T10-54-17-abc.jsonl",
        )

    def test_find_rollout_path_for_pid_raises_when_no_rollout_open(self):
        from workerctl import codex_session

        def fake_run_lsof(pid):
            return "codex 31507 user 25w REG 1,17 128 9999 /Users/u/.codex/config.toml\n"

        with self.assertRaises(codex_session.CodexSessionError):
            codex_session.find_rollout_path_for_pid(31507, _run_lsof=fake_run_lsof)

    def test_discover_session_combines_lsof_and_meta(self):
        from workerctl import codex_session

        with tempfile.TemporaryDirectory() as tmpdir:
            # Create rollout file in a path with /sessions/ directory
            sessions_dir = Path(tmpdir) / "sessions" / "2026" / "05" / "11"
            sessions_dir.mkdir(parents=True)
            rollout = sessions_dir / "rollout-2026-05-11T07-32-08-xyz.jsonl"
            rollout.write_text(json.dumps({
                "type": "session_meta",
                "payload": {
                    "id": "session-uuid-xyz",
                    "cwd": "/repo",
                    "originator": "codex-tui",
                    "cli_version": "0.130.0",
                },
            }) + "\n")

            fake_lsof = (
                f"codex 9999 user 25w REG 1,17 100 1 {rollout}\n"
            )

            result = codex_session.discover_session(
                pid=9999,
                _ps_children=lambda _: [],
                _run_lsof=lambda _: fake_lsof,
            )
            self.assertEqual(result["pid"], 9999)
            self.assertEqual(result["codex_session_id"], "session-uuid-xyz")
            self.assertEqual(result["codex_session_path"], str(rollout))
            self.assertEqual(result["cwd"], "/repo")
            self.assertEqual(result["originator"], "codex-tui")

    def test_find_rollout_path_for_pid_ignores_rollout_outside_sessions_dir(self):
        from workerctl import codex_session

        def fake_run_lsof(pid):
            return (
                "codex 31507 user 25w REG 1,17 128 9999 "
                "/tmp/rollout-stray.jsonl\n"
            )

        with self.assertRaises(codex_session.CodexSessionError):
            codex_session.find_rollout_path_for_pid(31507, _run_lsof=fake_run_lsof)


class SessionsSchemaTests(unittest.TestCase):
    def open_db(self, tmpdir):
        path = Path(tmpdir) / "workerctl.db"
        conn = worker_db.connect(path)
        worker_db.initialize_database(conn)
        self.addCleanup(conn.close)
        return conn

    def test_sessions_table_exists_after_init(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)
            tables = {
                row["name"]
                for row in conn.execute(
                    "select name from sqlite_master where type='table'"
                )
            }
            self.assertIn("sessions", tables)

    def test_sessions_table_has_expected_columns(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)
            cols = {row["name"] for row in conn.execute("pragma table_info(sessions)")}
            expected = {
                "id", "name", "role", "identity_token",
                "tmux_session", "tmux_pane_id",
                "codex_session_path", "codex_session_id",
                "pid", "cwd",
                "registered_at", "last_heartbeat_at",
                "state",
            }
            self.assertTrue(expected <= cols, f"missing: {expected - cols}")

    def test_sessions_role_check_constraint(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)
            with self.assertRaises(sqlite3.IntegrityError):
                conn.execute(
                    """
                    insert into sessions(
                      id, name, role, identity_token, cwd, registered_at, state
                    )
                    values ('s-1', 'x', 'bogus', 't', '/tmp', '2026-05-11T00:00:00Z', 'active')
                    """
                )

    def test_sessions_name_unique(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)
            now = "2026-05-11T00:00:00Z"
            conn.execute(
                """
                insert into sessions(
                  id, name, role, identity_token, cwd, registered_at, state
                )
                values ('s-1', 'dup', 'worker', 't1', '/tmp', ?, 'active')
                """,
                (now,),
            )
            with self.assertRaises(sqlite3.IntegrityError):
                conn.execute(
                    """
                    insert into sessions(
                      id, name, role, identity_token, cwd, registered_at, state
                    )
                    values ('s-2', 'dup', 'manager', 't2', '/tmp', ?, 'active')
                    """,
                    (now,),
                )

    def test_backfill_copies_existing_workers_to_sessions(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "workerctl.db"
            # Manually open a v4-style DB, insert a worker row, then run init to migrate.
            conn = worker_db.connect(db_path)
            worker_db.initialize_database(conn)
            now = "2026-05-11T00:00:00Z"
            conn.execute(
                """
                insert into workers(
                  id, name, tmux_session, identity_token, cwd, state, created_at, updated_at
                )
                values ('worker-99', 'legacy-w', 'codex-legacy-w', 'tok-99', '/repo', 'active', ?, ?)
                """,
                (now, now),
            )
            conn.commit()
            conn.close()

            # Drop sessions table to simulate pre-v5, force re-init to backfill.
            conn = worker_db.connect(db_path)
            conn.execute("drop table sessions")
            conn.execute("PRAGMA user_version = 4")
            conn.commit()
            conn.close()

            conn = worker_db.connect(db_path)
            worker_db.initialize_database(conn)
            self.addCleanup(conn.close)

            row = conn.execute(
                "select id, name, role, cwd from sessions where id = 'worker-99'"
            ).fetchone()
            self.assertIsNotNone(row)
            self.assertEqual(row["name"], "legacy-w")
            self.assertEqual(row["role"], "worker")
            self.assertEqual(row["cwd"], "/repo")

    def test_backfill_copies_existing_managers_to_sessions(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "workerctl.db"
            conn = worker_db.connect(db_path)
            worker_db.initialize_database(conn)
            now = "2026-05-11T00:00:00Z"
            # Need a task first for the FK
            conn.execute(
                "insert into tasks(id, name, goal, state, created_at, updated_at) "
                "values ('task-1', 't', 'g', 'managed', ?, ?)",
                (now, now),
            )
            conn.execute(
                """
                insert into managers(
                  id, name, task_id, tmux_session, state, codex_args_json, started_at
                )
                values ('manager-77', 'legacy-m', 'task-1', 'codex-legacy-m', 'ready', '[]', ?)
                """,
                (now,),
            )
            conn.commit()
            conn.close()

            conn = worker_db.connect(db_path)
            conn.execute("drop table sessions")
            conn.execute("PRAGMA user_version = 4")
            conn.commit()
            conn.close()

            conn = worker_db.connect(db_path)
            worker_db.initialize_database(conn)
            self.addCleanup(conn.close)

            row = conn.execute(
                "select id, name, role from sessions where id = 'manager-77'"
            ).fetchone()
            self.assertIsNotNone(row)
            self.assertEqual(row["name"], "legacy-m")
            self.assertEqual(row["role"], "manager")

    def test_bindings_has_session_id_columns(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)
            cols = {row["name"] for row in conn.execute("pragma table_info(bindings)")}
            self.assertIn("worker_session_id", cols)
            self.assertIn("manager_session_id", cols)

    def test_bindings_worker_id_now_nullable(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)
            now = "2026-05-11T00:00:00Z"
            conn.execute(
                "insert into tasks(id, name, goal, state, created_at, updated_at) "
                "values ('task-1', 't', 'g', 'managed', ?, ?)",
                (now, now),
            )
            conn.execute(
                "insert into sessions(id, name, role, identity_token, cwd, registered_at, state) "
                "values ('s-w', 'w', 'worker', 'tok-w', '/tmp', ?, 'active')",
                (now,),
            )
            conn.execute(
                "insert into sessions(id, name, role, identity_token, cwd, registered_at, state) "
                "values ('s-m', 'm', 'manager', 'tok-m', '/tmp', ?, 'active')",
                (now,),
            )
            # Insert binding without legacy worker_id / manager_id — should succeed.
            conn.execute(
                """
                insert into bindings(
                  id, task_id, worker_session_id, manager_session_id, state, created_at
                )
                values ('b-1', 'task-1', 's-w', 's-m', 'active', ?)
                """,
                (now,),
            )
            row = conn.execute(
                "select worker_id, worker_session_id from bindings where id='b-1'"
            ).fetchone()
            self.assertIsNone(row["worker_id"])
            self.assertEqual(row["worker_session_id"], "s-w")

    def test_v4_to_v5_rebuild_preserves_binding_row(self):
        """Simulate a true v4 database (old bindings shape, no sessions table, no
        session-id indexes) and verify the v5 migration succeeds end-to-end."""
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "workerctl.db"
            # Build a v5 db, then reshape it back to v4 in-place.
            conn = worker_db.connect(db_path)
            worker_db.initialize_database(conn)
            now = "2026-05-11T00:00:00Z"
            # Seed: a task, a worker, and a binding referencing them via legacy worker_id.
            conn.execute(
                "insert into tasks(id, name, goal, state, created_at, updated_at) "
                "values ('task-x', 'tx', 'g', 'managed', ?, ?)",
                (now, now),
            )
            conn.execute(
                """
                insert into workers(
                  id, name, tmux_session, identity_token, cwd, state, created_at, updated_at
                )
                values ('worker-x', 'wx', 'codex-wx', 'tok-x', '/repo', 'active', ?, ?)
                """,
                (now, now),
            )
            conn.execute(
                """
                insert into bindings(id, task_id, worker_id, state, created_at)
                values ('binding-x', 'task-x', 'worker-x', 'active', ?)
                """,
                (now,),
            )
            conn.commit()

            # Reshape to v4: drop the session-id columns from bindings via rebuild,
            # drop the new indexes, drop sessions, set user_version=4.
            conn.executescript(
                """
                drop index if exists one_active_binding_per_worker_session;
                drop index if exists one_active_binding_per_manager_session;
                alter table bindings rename to bindings_pre_v4_shape;
                create table bindings(
                  id text primary key,
                  task_id text not null references tasks(id),
                  worker_id text not null references workers(id),
                  manager_id text references managers(id),
                  state text not null check (state in ('active','ending','ended','invalid')),
                  created_at text not null,
                  ended_at text
                );
                insert into bindings(id, task_id, worker_id, manager_id, state, created_at, ended_at)
                select id, task_id, worker_id, manager_id, state, created_at, ended_at
                from bindings_pre_v4_shape;
                drop table bindings_pre_v4_shape;
                create unique index if not exists one_active_binding_per_worker
                  on bindings(worker_id) where state in ('active', 'ending');
                create unique index if not exists one_active_binding_per_task
                  on bindings(task_id) where state in ('active', 'ending');
                drop table sessions;
                """
            )
            conn.execute("PRAGMA user_version = 4")
            conn.commit()
            conn.close()

            # Reopen and re-init: this is the actual v4→v5 migration path.
            conn = worker_db.connect(db_path)
            worker_db.initialize_database(conn)
            self.addCleanup(conn.close)

            # The binding row must still exist with the same data and NULL for new cols.
            row = conn.execute(
                "select task_id, worker_id, worker_session_id, manager_session_id, state "
                "from bindings where id = 'binding-x'"
            ).fetchone()
            self.assertIsNotNone(row)
            self.assertEqual(row["task_id"], "task-x")
            self.assertEqual(row["worker_id"], "worker-x")
            self.assertIsNone(row["worker_session_id"])
            self.assertIsNone(row["manager_session_id"])
            self.assertEqual(row["state"], "active")

            # All four bindings indexes must exist.
            indexes = {
                r["name"]
                for r in conn.execute(
                    "select name from sqlite_master where type='index' and tbl_name='bindings'"
                )
            }
            self.assertIn("one_active_binding_per_worker", indexes)
            self.assertIn("one_active_binding_per_task", indexes)
            self.assertIn("one_active_binding_per_worker_session", indexes)
            self.assertIn("one_active_binding_per_manager_session", indexes)

    def test_migrate_self_heals_partial_v5_state(self):
        """Simulate the real-world bug: sessions table present, user_version=5, but
        bindings still v4-shaped (no session_id columns, no new indexes). The next
        initialize_database call must self-heal."""
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "workerctl.db"
            conn = worker_db.connect(db_path)
            worker_db.initialize_database(conn)
            # Seed a binding so we can verify it survives.
            now = "2026-05-11T00:00:00Z"
            conn.execute(
                "insert into tasks(id, name, goal, state, created_at, updated_at) "
                "values ('task-x', 'tx', 'g', 'managed', ?, ?)",
                (now, now),
            )
            conn.execute(
                """
                insert into workers(
                  id, name, tmux_session, identity_token, cwd, state, created_at, updated_at
                )
                values ('worker-x', 'wx', 'codex-wx', 'tok-x', '/repo', 'active', ?, ?)
                """,
                (now, now),
            )
            conn.execute(
                """
                insert into bindings(id, task_id, worker_id, state, created_at)
                values ('binding-x', 'task-x', 'worker-x', 'active', ?)
                """,
                (now,),
            )
            conn.commit()

            # Surgically degrade to the broken state: drop session-id columns and
            # the two new indexes from bindings, but LEAVE user_version=5 and the
            # sessions table intact (this is the real-world divergence).
            conn.executescript(
                """
                drop index if exists one_active_binding_per_worker_session;
                drop index if exists one_active_binding_per_manager_session;
                alter table bindings rename to bindings_partial;
                create table bindings(
                  id text primary key,
                  task_id text not null references tasks(id),
                  worker_id text not null references workers(id),
                  manager_id text references managers(id),
                  state text not null check (state in ('active','ending','ended','invalid')),
                  created_at text not null,
                  ended_at text
                );
                insert into bindings(id, task_id, worker_id, manager_id, state, created_at, ended_at)
                select id, task_id, worker_id, manager_id, state, created_at, ended_at
                from bindings_partial;
                drop table bindings_partial;
                create unique index if not exists one_active_binding_per_worker
                  on bindings(worker_id) where state in ('active', 'ending');
                create unique index if not exists one_active_binding_per_task
                  on bindings(task_id) where state in ('active', 'ending');
                """
            )
            # IMPORTANT: keep user_version at SCHEMA_VERSION; do NOT reset it.
            # That's the bug shape — version pragma claims fully migrated but bindings
            # are still v4-shaped.
            self.assertEqual(
                conn.execute("PRAGMA user_version").fetchone()[0],
                worker_db.SCHEMA_VERSION,
            )
            conn.commit()
            conn.close()

            # Reopen and re-init — must self-heal.
            conn = worker_db.connect(db_path)
            worker_db.initialize_database(conn)
            self.addCleanup(conn.close)

            cols = {row["name"] for row in conn.execute("pragma table_info(bindings)")}
            self.assertIn("worker_session_id", cols)
            self.assertIn("manager_session_id", cols)

            indexes = {
                r["name"]
                for r in conn.execute(
                    "select name from sqlite_master where type='index' and tbl_name='bindings'"
                )
            }
            self.assertIn("one_active_binding_per_worker_session", indexes)
            self.assertIn("one_active_binding_per_manager_session", indexes)

            # Existing binding row must still be there.
            row = conn.execute(
                "select worker_id, worker_session_id from bindings where id = 'binding-x'"
            ).fetchone()
            self.assertEqual(row["worker_id"], "worker-x")
            self.assertIsNone(row["worker_session_id"])


class AcceptanceCriteriaDbTests(unittest.TestCase):
    def open_db(self, tmpdir):
        path = Path(tmpdir) / "workerctl.db"
        conn = worker_db.connect(path)
        worker_db.initialize_database(conn)
        self.addCleanup(conn.close)
        return conn

    def insert_task(self, conn, task_id="task-criteria", name="criteria-task"):
        now = "2026-05-15T10:00:00Z"
        conn.execute(
            """
            insert into tasks(id, name, goal, state, created_at, updated_at)
            values (?, ?, 'goal', 'candidate', ?, ?)
            """,
            (task_id, name, now, now),
        )

    def test_insert_list_and_update_acceptance_criteria(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)
            self.insert_task(conn)
            self.insert_task(conn, task_id="task-other", name="other-task")

            first_id = worker_db.insert_acceptance_criterion(
                conn,
                task_id="task-criteria",
                criterion="Targeted DB tests pass",
                status="accepted",
                source="manager_inferred",
                proof="python3 -m unittest tests.test_workerctl.AcceptanceCriteriaDbTests -v",
                rationale="The ledger must be covered before CLI integration.",
                evidence={"phase": "red", "attempt": 1},
            )
            second_id = worker_db.insert_acceptance_criterion(
                conn,
                task_id="task-criteria",
                criterion="Worker proposes final audit criteria",
                status="proposed",
                source="worker_proposed",
                evidence={"notes": ["needs manager review"]},
            )
            worker_db.insert_acceptance_criterion(
                conn,
                task_id="task-other",
                criterion="Unrelated task criterion",
                status="accepted",
                source="user_requested",
            )

            all_for_task = worker_db.acceptance_criteria_for_task(conn, task_id="task-criteria")
            accepted = worker_db.acceptance_criteria_for_task(
                conn,
                task_id="task-criteria",
                statuses=["accepted"],
            )
            proposed = worker_db.acceptance_criteria_for_task(
                conn,
                task_id="task-criteria",
                statuses=["proposed"],
            )

            self.assertEqual([row["id"] for row in all_for_task], [first_id, second_id])
            self.assertEqual([row["id"] for row in accepted], [first_id])
            self.assertEqual([row["id"] for row in proposed], [second_id])
            self.assertEqual(accepted[0]["criterion"], "Targeted DB tests pass")
            self.assertEqual(accepted[0]["status"], "accepted")
            self.assertEqual(accepted[0]["source"], "manager_inferred")
            self.assertEqual(accepted[0]["proof"], "python3 -m unittest tests.test_workerctl.AcceptanceCriteriaDbTests -v")
            self.assertEqual(accepted[0]["rationale"], "The ledger must be covered before CLI integration.")
            self.assertEqual(accepted[0]["evidence"], {"phase": "red", "attempt": 1})
            self.assertIsNotNone(accepted[0]["created_at"])
            self.assertEqual(accepted[0]["created_at"], accepted[0]["updated_at"])

            updated = worker_db.update_acceptance_criterion(
                conn,
                criterion_id=first_id,
                status="satisfied",
                evidence={"command": "python3 -m unittest", "ok": True},
                proof="Acceptance criteria DB tests passed",
                rationale="Satisfied by the targeted DB test run.",
            )

            self.assertEqual(updated["id"], first_id)
            self.assertEqual(updated["status"], "satisfied")
            self.assertEqual(updated["source"], "manager_inferred")
            self.assertEqual(updated["proof"], "Acceptance criteria DB tests passed")
            self.assertEqual(updated["rationale"], "Satisfied by the targeted DB test run.")
            self.assertEqual(updated["evidence"], {"command": "python3 -m unittest", "ok": True})
            self.assertEqual(updated["created_at"], accepted[0]["created_at"])
            self.assertGreaterEqual(updated["updated_at"], updated["created_at"])

    def test_duplicate_acceptance_criterion_insert_returns_existing_id(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)
            self.insert_task(conn)

            first_id = worker_db.insert_acceptance_criterion(
                conn,
                task_id="task-criteria",
                criterion="Do not duplicate criteria",
                status="accepted",
                source="manager_inferred",
                proof="original proof",
                rationale="original rationale",
                evidence={"original": True},
            )
            duplicate_id = worker_db.insert_acceptance_criterion(
                conn,
                task_id="task-criteria",
                criterion="Do not duplicate criteria",
                status="rejected",
                source="manager_inferred",
                proof="replacement proof",
                rationale="replacement rationale",
                evidence={"replacement": True},
            )

            rows = worker_db.acceptance_criteria_for_task(conn, task_id="task-criteria")

            self.assertEqual(duplicate_id, first_id)
            self.assertEqual(len(rows), 1)
            self.assertEqual(rows[0]["status"], "accepted")
            self.assertEqual(rows[0]["proof"], "original proof")
            self.assertEqual(rows[0]["rationale"], "original rationale")
            self.assertEqual(rows[0]["evidence"], {"original": True})

    def test_acceptance_criterion_unique_index_exists(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)

            indexes = {
                row["name"]
                for row in conn.execute(
                    "select name from sqlite_master where type = 'index' and name not like 'sqlite_%'"
                )
            }

            self.assertIn("acceptance_criteria_task_source_criterion", indexes)

    def test_update_acceptance_criterion_preserves_and_clears_optional_fields(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)
            self.insert_task(conn)
            criterion_id = worker_db.insert_acceptance_criterion(
                conn,
                task_id="task-criteria",
                criterion="Optional fields can be preserved or cleared",
                status="accepted",
                source="final_audit",
                proof="existing proof",
                rationale="existing rationale",
                evidence={"existing": True},
            )

            preserved = worker_db.update_acceptance_criterion(
                conn,
                criterion_id=criterion_id,
                status="satisfied",
            )

            self.assertEqual(preserved["status"], "satisfied")
            self.assertEqual(preserved["proof"], "existing proof")
            self.assertEqual(preserved["rationale"], "existing rationale")
            self.assertEqual(preserved["evidence"], {"existing": True})

            cleared = worker_db.update_acceptance_criterion(
                conn,
                criterion_id=criterion_id,
                status="deferred",
                proof=None,
                rationale=None,
                evidence=None,
            )

            self.assertEqual(cleared["status"], "deferred")
            self.assertIsNone(cleared["proof"])
            self.assertIsNone(cleared["rationale"])
            self.assertEqual(cleared["evidence"], {})

    def test_acceptance_criteria_validate_status_and_source(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)
            self.insert_task(conn)

            with self.assertRaisesRegex(WorkerError, "invalid acceptance criterion status"):
                worker_db.insert_acceptance_criterion(
                    conn,
                    task_id="task-criteria",
                    criterion="Bad status",
                    status="done",
                    source="manager_inferred",
                )

            with self.assertRaisesRegex(WorkerError, "invalid acceptance criterion source"):
                worker_db.insert_acceptance_criterion(
                    conn,
                    task_id="task-criteria",
                    criterion="Bad source",
                    status="proposed",
                    source="worker",
                )

            criterion_id = worker_db.insert_acceptance_criterion(
                conn,
                task_id="task-criteria",
                criterion="Valid criterion",
                status="proposed",
                source="final_audit",
            )
            with self.assertRaisesRegex(WorkerError, "invalid acceptance criterion status"):
                worker_db.update_acceptance_criterion(
                    conn,
                    criterion_id=criterion_id,
                    status="done",
                )


class RegisterCommandsTests(unittest.TestCase):
    def open_db(self, tmpdir):
        path = Path(tmpdir) / "workerctl.db"
        conn = worker_db.connect(path)
        worker_db.initialize_database(conn)
        self.addCleanup(conn.close)
        return conn

    def test_register_session_inserts_new_worker(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)
            session_id = worker_db.register_session(
                conn,
                name="auth-worker",
                role="worker",
                codex_session_path="/path/to/rollout.jsonl",
                codex_session_id="codex-uuid-1",
                pid=12345,
                cwd="/repo",
                tmux_session="codex-auth-worker",
                tmux_pane_id="%5",
            )
            self.assertTrue(session_id.startswith("session-"))
            row = conn.execute(
                "select * from sessions where id = ?", (session_id,)
            ).fetchone()
            self.assertEqual(row["name"], "auth-worker")
            self.assertEqual(row["role"], "worker")
            self.assertEqual(row["pid"], 12345)
            self.assertEqual(row["state"], "active")

    def test_register_session_idempotent_on_name(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)
            id1 = worker_db.register_session(
                conn, name="w", role="worker", codex_session_path="/a",
                codex_session_id="u1", pid=1, cwd="/repo",
            )
            id2 = worker_db.register_session(
                conn, name="w", role="worker", codex_session_path="/a",
                codex_session_id="u1", pid=2, cwd="/repo",
            )
            self.assertEqual(id1, id2)
            row = conn.execute("select pid from sessions where id = ?", (id1,)).fetchone()
            self.assertEqual(row["pid"], 2)  # pid updated on re-register

    def test_register_session_rejects_role_change(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)
            worker_db.register_session(
                conn, name="x", role="worker", codex_session_path="/a",
                codex_session_id="u1", pid=1, cwd="/repo",
            )
            with self.assertRaises(WorkerError):
                worker_db.register_session(
                    conn, name="x", role="manager", codex_session_path="/a",
                    codex_session_id="u1", pid=2, cwd="/repo",
                )

    def test_register_session_creates_manager_without_tmux(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)
            session_id = worker_db.register_session(
                conn, name="m1", role="manager", codex_session_path="/a",
                codex_session_id="u-m", pid=99, cwd="/repo",
            )
            row = conn.execute("select tmux_session, role from sessions where id = ?", (session_id,)).fetchone()
            self.assertIsNone(row["tmux_session"])
            self.assertEqual(row["role"], "manager")

    def test_deregister_session_rejects_when_active_binding_exists(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)
            now = "2026-05-11T00:00:00Z"
            conn.execute(
                "insert into tasks(id, name, goal, state, created_at, updated_at) "
                "values ('task-1', 'tt', 'g', 'managed', ?, ?)",
                (now, now),
            )
            worker_sid = worker_db.register_session(
                conn, name="w", role="worker", codex_session_path="/a",
                codex_session_id="u-w", pid=1, cwd="/repo",
            )
            manager_sid = worker_db.register_session(
                conn, name="m", role="manager", codex_session_path="/b",
                codex_session_id="u-m", pid=2, cwd="/repo",
            )
            conn.execute(
                """
                insert into bindings(
                  id, task_id, worker_session_id, manager_session_id, state, created_at
                )
                values ('b-1', 'task-1', ?, ?, 'active', ?)
                """,
                (worker_sid, manager_sid, now),
            )
            with self.assertRaises(WorkerError):
                worker_db.deregister_session(conn, name="w")
            with self.assertRaises(WorkerError):
                worker_db.deregister_session(conn, name="m")
            # Session state must remain active.
            row = conn.execute("select state from sessions where name='w'").fetchone()
            self.assertEqual(row["state"], "active")

    def test_deregister_session_succeeds_when_no_active_binding(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)
            worker_db.register_session(
                conn, name="w", role="worker", codex_session_path="/a",
                codex_session_id="u-w", pid=1, cwd="/repo",
            )
            worker_db.deregister_session(conn, name="w")
            row = conn.execute("select state from sessions where name='w'").fetchone()
            self.assertEqual(row["state"], "gone")

    def run_cli(self, *args, env_extra=None):
        # Use the workerctl script directly to exercise the full argparse path.
        env = os.environ.copy()
        if env_extra:
            env.update(env_extra)
        proc = subprocess.run(
            [sys.executable, "-m", "workerctl", *args],
            capture_output=True,
            text=True,
            env=env,
            cwd=str(ROOT),
        )
        return proc

    def test_cli_register_worker_with_explicit_session_path(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            rollout = Path(tmpdir) / "rollout-2026-05-11-fake.jsonl"
            rollout.write_text(json.dumps({
                "type": "session_meta",
                "payload": {"id": "fake-uuid", "cwd": str(ROOT), "originator": "codex-tui"},
            }) + "\n")

            state_dir = Path(tmpdir) / "state"
            state_dir.mkdir()

            proc = self.run_cli(
                "register-worker",
                "--name", "test-w",
                "--codex-session", str(rollout),
                "--pid", "12345",
                "--cwd", str(ROOT),
                env_extra={"WORKERCTL_STATE_ROOT": str(state_dir)},
            )
            self.assertEqual(proc.returncode, 0, proc.stderr)

            conn = worker_db.connect(state_dir / "workerctl.db")
            self.addCleanup(conn.close)
            row = conn.execute(
                "select role, pid, codex_session_id from sessions where name='test-w'"
            ).fetchone()
            self.assertIsNotNone(row)
            self.assertEqual(row["role"], "worker")
            self.assertEqual(row["pid"], 12345)
            self.assertEqual(row["codex_session_id"], "fake-uuid")

    def test_cli_register_manager_without_tmux(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            rollout = Path(tmpdir) / "rollout-fake-mgr.jsonl"
            rollout.write_text(json.dumps({
                "type": "session_meta",
                "payload": {"id": "mgr-uuid", "cwd": str(ROOT), "originator": "codex-tui"},
            }) + "\n")
            state_dir = Path(tmpdir) / "state"
            state_dir.mkdir()

            proc = self.run_cli(
                "register-manager",
                "--name", "test-m",
                "--codex-session", str(rollout),
                "--pid", "99999",
                "--cwd", str(ROOT),
                env_extra={"WORKERCTL_STATE_ROOT": str(state_dir)},
            )
            self.assertEqual(proc.returncode, 0, proc.stderr)

            conn = worker_db.connect(state_dir / "workerctl.db")
            self.addCleanup(conn.close)
            row = conn.execute(
                "select role, tmux_session, codex_session_id from sessions where name='test-m'"
            ).fetchone()
            self.assertEqual(row["role"], "manager")
            self.assertIsNone(row["tmux_session"])
            self.assertEqual(row["codex_session_id"], "mgr-uuid")

    def test_cli_sessions_lists_registered(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            rollout = Path(tmpdir) / "r.jsonl"
            rollout.write_text(json.dumps({
                "type": "session_meta",
                "payload": {"id": "u1", "cwd": str(ROOT), "originator": "codex-tui"},
            }) + "\n")
            state_dir = Path(tmpdir) / "state"
            state_dir.mkdir()
            env = {"WORKERCTL_STATE_ROOT": str(state_dir)}

            self.run_cli("register-worker", "--name", "w", "--codex-session", str(rollout),
                         "--pid", "1", "--cwd", str(ROOT), env_extra=env)
            self.run_cli("register-manager", "--name", "m", "--codex-session", str(rollout),
                         "--pid", "2", "--cwd", str(ROOT), env_extra=env)

            proc = self.run_cli("sessions", env_extra=env)
            self.assertEqual(proc.returncode, 0, proc.stderr)
            rows = json.loads(proc.stdout)
            names = {r["name"] for r in rows}
            self.assertEqual(names, {"w", "m"})

    def test_cli_deregister_marks_gone(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            rollout = Path(tmpdir) / "r.jsonl"
            rollout.write_text(json.dumps({
                "type": "session_meta",
                "payload": {"id": "u1", "cwd": str(ROOT), "originator": "codex-tui"},
            }) + "\n")
            state_dir = Path(tmpdir) / "state"
            state_dir.mkdir()
            env = {"WORKERCTL_STATE_ROOT": str(state_dir)}

            self.run_cli("register-worker", "--name", "w", "--codex-session", str(rollout),
                         "--pid", "1", "--cwd", str(ROOT), env_extra=env)
            proc = self.run_cli("deregister", "w", env_extra=env)
            self.assertEqual(proc.returncode, 0, proc.stderr)

            conn = worker_db.connect(state_dir / "workerctl.db")
            self.addCleanup(conn.close)
            row = conn.execute("select state from sessions where name='w'").fetchone()
            self.assertEqual(row["state"], "gone")

    def test_cli_deregister_bound_session_records_failed_command(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            rollout = Path(tmpdir) / "r.jsonl"
            rollout.write_text(json.dumps({
                "type": "session_meta",
                "payload": {"id": "u1", "cwd": str(ROOT), "originator": "codex-tui"},
            }) + "\n")
            state_dir = Path(tmpdir) / "state"
            state_dir.mkdir()
            env = {"WORKERCTL_STATE_ROOT": str(state_dir)}

            self.run_cli("register-worker", "--name", "w", "--codex-session", str(rollout),
                         "--pid", "1", "--cwd", str(ROOT), env_extra=env)
            self.run_cli("register-manager", "--name", "m", "--codex-session", str(rollout),
                         "--pid", "2", "--cwd", str(ROOT), env_extra=env)
            conn = worker_db.connect(state_dir / "workerctl.db")
            self.addCleanup(conn.close)
            task_id = worker_db.create_task(conn, name="bound-task", goal="g")
            worker_db.bind_sessions(
                conn,
                task_name="bound-task",
                worker_session_name="w",
                manager_session_name="m",
            )
            conn.commit()

            proc = self.run_cli("deregister", "w", env_extra=env)

            self.assertNotEqual(proc.returncode, 0)
            self.assertIn("still bound to task", proc.stderr)
            audit = worker_db.task_audit(conn, task="bound-task")
            command = [row for row in audit["commands"] if row["type"] == "deregister_session"][0]
            self.assertEqual(command["state"], "failed")
            self.assertTrue(command["result"]["expected_failure"])
            self.assertEqual(command["task_id"], task_id)
            events = [row["type"] for row in audit["events"]]
            self.assertIn("session_deregister_failed", events)

    def test_cli_register_worker_bad_rollout_path_returns_clean_error(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            state_dir = Path(tmpdir) / "state"
            state_dir.mkdir()
            bogus = Path(tmpdir) / "does-not-exist.jsonl"

            proc = self.run_cli(
                "register-worker",
                "--name", "x",
                "--codex-session", str(bogus),
                "--pid", "1",
                env_extra={"WORKERCTL_STATE_ROOT": str(state_dir)},
            )
            self.assertEqual(proc.returncode, 1)
            self.assertNotIn("Traceback", proc.stderr)
            self.assertIn("workerctl:", proc.stderr)

    def test_register_session_re_register_resets_ingest_offset(self):
        """Re-registering a session (e.g. pointing at a new rollout file) must
        clear last_ingest_offset so the new rollout is ingested from byte 0."""
        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)
            session_id = worker_db.register_session(
                conn, name="w", role="worker",
                codex_session_path="/path/a", codex_session_id="cuid-a",
                pid=1, cwd="/repo",
            )
            worker_db.set_session_ingest_offset(conn, session_id=session_id, offset=12345)
            row = conn.execute(
                "select last_ingest_offset from sessions where id = ?", (session_id,)
            ).fetchone()
            self.assertEqual(row["last_ingest_offset"], 12345)

            # Re-register with a different rollout path.
            worker_db.register_session(
                conn, name="w", role="worker",
                codex_session_path="/path/b", codex_session_id="cuid-b",
                pid=2, cwd="/repo",
            )
            row = conn.execute(
                "select last_ingest_offset, codex_session_path from sessions where id = ?",
                (session_id,),
            ).fetchone()
            self.assertIsNone(row["last_ingest_offset"])
            self.assertEqual(row["codex_session_path"], "/path/b")


class BindCommandTests(unittest.TestCase):
    def open_db(self, tmpdir):
        path = Path(tmpdir) / "workerctl.db"
        conn = worker_db.connect(path)
        worker_db.initialize_database(conn)
        self.addCleanup(conn.close)
        return conn

    def setup_pair(self, conn):
        now = "2026-05-11T00:00:00Z"
        conn.execute(
            "insert into tasks(id, name, goal, state, created_at, updated_at) "
            "values ('task-1', 'auth-refactor', 'g', 'candidate', ?, ?)",
            (now, now),
        )
        worker_db.register_session(
            conn, name="w1", role="worker", codex_session_path="/a",
            codex_session_id="cuid-w", pid=1, cwd="/repo",
        )
        worker_db.register_session(
            conn, name="m1", role="manager", codex_session_path="/b",
            codex_session_id="cuid-m", pid=2, cwd="/repo",
        )

    def test_bind_sessions_creates_active_binding(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)
            self.setup_pair(conn)
            binding_id = worker_db.bind_sessions(
                conn,
                task_name="auth-refactor",
                worker_session_name="w1",
                manager_session_name="m1",
            )
            self.assertTrue(binding_id.startswith("binding-"))
            row = conn.execute(
                "select * from bindings where id = ?", (binding_id,)
            ).fetchone()
            self.assertEqual(row["state"], "active")
            self.assertEqual(row["task_id"], "task-1")
            self.assertIsNotNone(row["worker_session_id"])
            self.assertIsNotNone(row["manager_session_id"])
            self.assertIsNone(row["worker_id"])
            self.assertIsNone(row["manager_id"])

    def test_bind_sessions_rejects_double_bind_same_task(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)
            self.setup_pair(conn)
            worker_db.bind_sessions(
                conn, task_name="auth-refactor",
                worker_session_name="w1", manager_session_name="m1",
            )
            worker_db.register_session(
                conn, name="m2", role="manager", codex_session_path="/c",
                codex_session_id="cuid-m2", pid=3, cwd="/repo",
            )
            with self.assertRaises(WorkerError):
                worker_db.bind_sessions(
                    conn, task_name="auth-refactor",
                    worker_session_name="w1", manager_session_name="m2",
                )

    def test_bind_sessions_rejects_role_mismatch(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)
            self.setup_pair(conn)
            with self.assertRaises(WorkerError):
                worker_db.bind_sessions(
                    conn, task_name="auth-refactor",
                    worker_session_name="m1",  # wrong role
                    manager_session_name="w1",
                )

    def test_unbind_task_ends_active_binding(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)
            self.setup_pair(conn)
            binding_id = worker_db.bind_sessions(
                conn, task_name="auth-refactor",
                worker_session_name="w1", manager_session_name="m1",
            )
            worker_db.unbind_task(conn, task_name="auth-refactor")
            row = conn.execute(
                "select state, ended_at from bindings where id = ?", (binding_id,)
            ).fetchone()
            self.assertEqual(row["state"], "ended")
            self.assertIsNotNone(row["ended_at"])

    def test_bind_sessions_rejects_already_bound_worker(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)
            self.setup_pair(conn)
            now = "2026-05-11T00:00:00Z"
            conn.execute(
                "insert into tasks(id, name, goal, state, created_at, updated_at) "
                "values ('task-2', 'second-task', 'g', 'candidate', ?, ?)",
                (now, now),
            )
            worker_db.register_session(
                conn, name="m2", role="manager", codex_session_path="/c",
                codex_session_id="cuid-m2", pid=3, cwd="/repo",
            )
            worker_db.bind_sessions(
                conn, task_name="auth-refactor",
                worker_session_name="w1", manager_session_name="m1",
            )
            with self.assertRaises(WorkerError) as ctx:
                worker_db.bind_sessions(
                    conn, task_name="second-task",
                    worker_session_name="w1",  # already bound to auth-refactor
                    manager_session_name="m2",
                )
            self.assertIn("worker session", str(ctx.exception))
            self.assertIn("w1", str(ctx.exception))

    def test_bind_sessions_rejects_already_bound_manager(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)
            self.setup_pair(conn)
            now = "2026-05-11T00:00:00Z"
            conn.execute(
                "insert into tasks(id, name, goal, state, created_at, updated_at) "
                "values ('task-2', 'second-task', 'g', 'candidate', ?, ?)",
                (now, now),
            )
            worker_db.register_session(
                conn, name="w2", role="worker", codex_session_path="/c",
                codex_session_id="cuid-w2", pid=3, cwd="/repo",
            )
            worker_db.bind_sessions(
                conn, task_name="auth-refactor",
                worker_session_name="w1", manager_session_name="m1",
            )
            with self.assertRaises(WorkerError) as ctx:
                worker_db.bind_sessions(
                    conn, task_name="second-task",
                    worker_session_name="w2",
                    manager_session_name="m1",  # already bound to auth-refactor
                )
            self.assertIn("manager session", str(ctx.exception))
            self.assertIn("m1", str(ctx.exception))

    def run_cli(self, *args, env_extra=None):
        env = os.environ.copy()
        if env_extra:
            env.update(env_extra)
        return subprocess.run(
            [sys.executable, "-m", "workerctl", *args],
            capture_output=True, text=True, env=env, cwd=str(ROOT),
        )

    def _setup_state_dir(self, tmpdir):
        rollout = Path(tmpdir) / "r.jsonl"
        rollout.write_text(json.dumps({
            "type": "session_meta",
            "payload": {"id": "u1", "cwd": str(ROOT), "originator": "codex-tui"},
        }) + "\n")
        state_dir = Path(tmpdir) / "state"
        state_dir.mkdir()
        env = {"WORKERCTL_STATE_ROOT": str(state_dir)}
        return rollout, state_dir, env

    def test_cli_bind_creates_binding(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            rollout, state_dir, env = self._setup_state_dir(tmpdir)

            self.run_cli("register-worker", "--name", "w", "--codex-session", str(rollout),
                         "--pid", "1", "--cwd", str(ROOT), env_extra=env)
            self.run_cli("register-manager", "--name", "m", "--codex-session", str(rollout),
                         "--pid", "2", "--cwd", str(ROOT), env_extra=env)
            self.run_cli("tasks", "--create", "myTask", "--goal", "do the thing", env_extra=env)

            proc = self.run_cli(
                "bind", "--task", "myTask", "--worker", "w", "--manager", "m",
                env_extra=env,
            )
            self.assertEqual(proc.returncode, 0, proc.stderr)
            payload = json.loads(proc.stdout)
            self.assertTrue(payload["binding_id"].startswith("binding-"))

            conn = worker_db.connect(state_dir / "workerctl.db")
            self.addCleanup(conn.close)
            row = conn.execute(
                "select state, worker_session_id, manager_session_id from bindings "
                "where id = ?", (payload["binding_id"],),
            ).fetchone()
            self.assertEqual(row["state"], "active")
            self.assertIsNotNone(row["worker_session_id"])
            self.assertIsNotNone(row["manager_session_id"])

    def test_cli_unbind_ends_binding(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            rollout, state_dir, env = self._setup_state_dir(tmpdir)

            self.run_cli("register-worker", "--name", "w", "--codex-session", str(rollout),
                         "--pid", "1", "--cwd", str(ROOT), env_extra=env)
            self.run_cli("register-manager", "--name", "m", "--codex-session", str(rollout),
                         "--pid", "2", "--cwd", str(ROOT), env_extra=env)
            self.run_cli("tasks", "--create", "myTask", "--goal", "do it", env_extra=env)
            self.run_cli("bind", "--task", "myTask", "--worker", "w", "--manager", "m", env_extra=env)

            proc = self.run_cli("unbind", "--task", "myTask", env_extra=env)
            self.assertEqual(proc.returncode, 0, proc.stderr)
            conn = worker_db.connect(state_dir / "workerctl.db")
            self.addCleanup(conn.close)
            row = conn.execute(
                "select state from bindings where task_id=(select id from tasks where name='myTask')"
            ).fetchone()
            self.assertEqual(row["state"], "ended")

    def test_cli_bind_event_is_linked_to_task(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            rollout, state_dir, env = self._setup_state_dir(tmpdir)

            self.run_cli("register-worker", "--name", "w", "--codex-session", str(rollout),
                         "--pid", "1", "--cwd", str(ROOT), env_extra=env)
            self.run_cli("register-manager", "--name", "m", "--codex-session", str(rollout),
                         "--pid", "2", "--cwd", str(ROOT), env_extra=env)
            self.run_cli("tasks", "--create", "evtTask", "--goal", "g", env_extra=env)
            self.run_cli("bind", "--task", "evtTask", "--worker", "w", "--manager", "m", env_extra=env)
            self.run_cli("unbind", "--task", "evtTask", env_extra=env)

            conn = worker_db.connect(state_dir / "workerctl.db")
            self.addCleanup(conn.close)
            task_id = conn.execute("select id from tasks where name='evtTask'").fetchone()["id"]
            event_types = [
                r["type"]
                for r in conn.execute(
                    "select type from events where task_id = ? order by id", (task_id,)
                )
            ]
            self.assertIn("binding_created", event_types)
            self.assertIn("binding_ended", event_types)

    def test_active_binding_for_task_returns_resolved_dict(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)
            self.setup_pair(conn)
            binding_id = worker_db.bind_sessions(
                conn, task_name="auth-refactor",
                worker_session_name="w1", manager_session_name="m1",
            )
            row = worker_db.active_binding_for_task(conn, task_name="auth-refactor")
            self.assertEqual(row["binding_id"], binding_id)
            self.assertEqual(row["worker_session_name"], "w1")
            self.assertEqual(row["manager_session_name"], "m1")
            self.assertIsNotNone(row["worker_session_id"])
            self.assertIsNotNone(row["manager_session_id"])

    def test_active_binding_for_task_raises_when_no_active_binding(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)
            self.setup_pair(conn)
            with self.assertRaises(WorkerError):
                worker_db.active_binding_for_task(conn, task_name="auth-refactor")

    def test_active_binding_for_task_only_returns_active_or_ending(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)
            self.setup_pair(conn)
            worker_db.bind_sessions(
                conn, task_name="auth-refactor",
                worker_session_name="w1", manager_session_name="m1",
            )
            worker_db.unbind_task(conn, task_name="auth-refactor")
            with self.assertRaises(WorkerError):
                worker_db.active_binding_for_task(conn, task_name="auth-refactor")

    def test_active_binding_for_task_returns_ending_state(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)
            self.setup_pair(conn)
            binding_id = worker_db.bind_sessions(
                conn, task_name="auth-refactor",
                worker_session_name="w1", manager_session_name="m1",
            )
            # Manually transition to 'ending' (simulates finish-task handoff).
            conn.execute(
                "update bindings set state = 'ending' where id = ?",
                (binding_id,),
            )
            conn.commit()
            row = worker_db.active_binding_for_task(conn, task_name="auth-refactor")
            self.assertEqual(row["binding_id"], binding_id)
            self.assertEqual(row["state"], "ending")


class CodexEventsSchemaTests(unittest.TestCase):
    def open_db(self, tmpdir):
        path = Path(tmpdir) / "workerctl.db"
        conn = worker_db.connect(path)
        worker_db.initialize_database(conn)
        self.addCleanup(conn.close)
        return conn

    def test_codex_events_table_exists(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)
            tables = {
                row["name"]
                for row in conn.execute("select name from sqlite_master where type='table'")
            }
            self.assertIn("codex_events", tables)

    def test_codex_events_columns(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)
            cols = {row["name"] for row in conn.execute("pragma table_info(codex_events)")}
            expected = {"id", "session_id", "timestamp", "type", "subtype",
                        "payload_json", "byte_offset", "ingested_at"}
            self.assertTrue(expected <= cols, f"missing: {expected - cols}")

    def test_codex_events_fk_to_sessions_enforced(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)
            with self.assertRaises(sqlite3.IntegrityError):
                conn.execute(
                    """
                    insert into codex_events(
                      session_id, timestamp, type, payload_json, byte_offset, ingested_at
                    )
                    values ('does-not-exist', '2026-05-11T00:00:00Z', 'event_msg',
                            '{}', 0, '2026-05-11T00:00:00Z')
                    """
                )

    def test_sessions_has_last_ingest_offset_column(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)
            cols = {row["name"] for row in conn.execute("pragma table_info(sessions)")}
            self.assertIn("last_ingest_offset", cols)

    def test_codex_events_session_id_index_exists(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)
            indexes = {
                r["name"] for r in conn.execute(
                    "select name from sqlite_master where type='index' and tbl_name='codex_events'"
                )
            }
            self.assertIn("codex_events_session_id", indexes)

    def test_migrate_to_v6_adds_last_ingest_offset_to_existing_sessions(self):
        """Simulate a v5 DB without `last_ingest_offset` column; verify the v6 migration
        adds the column without losing existing session rows."""
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "workerctl.db"
            conn = worker_db.connect(db_path)
            worker_db.initialize_database(conn)
            now = "2026-05-11T00:00:00Z"
            worker_db.register_session(
                conn, name="w", role="worker", codex_session_path="/a",
                codex_session_id="cuid-w", pid=1, cwd="/repo",
            )
            conn.commit()

            # Degrade to v5 shape: drop last_ingest_offset column via rebuild.
            conn.executescript(
                """
                alter table sessions rename to sessions_v5;
                create table sessions(
                  id text primary key,
                  name text unique not null,
                  role text not null check (role in ('worker','manager')),
                  identity_token text unique not null,
                  tmux_session text,
                  tmux_pane_id text,
                  codex_session_path text,
                  codex_session_id text,
                  pid integer,
                  cwd text not null,
                  registered_at text not null,
                  last_heartbeat_at text,
                  state text not null check (state in ('active','gone'))
                );
                insert into sessions(
                  id, name, role, identity_token,
                  tmux_session, tmux_pane_id,
                  codex_session_path, codex_session_id, pid,
                  cwd, registered_at, last_heartbeat_at, state
                )
                select id, name, role, identity_token,
                       tmux_session, tmux_pane_id,
                       codex_session_path, codex_session_id, pid,
                       cwd, registered_at, last_heartbeat_at, state
                from sessions_v5;
                drop table sessions_v5;
                """
            )
            conn.execute("PRAGMA user_version = 5")
            conn.commit()
            conn.close()

            # Reopen — must self-heal.
            conn = worker_db.connect(db_path)
            worker_db.initialize_database(conn)
            self.addCleanup(conn.close)

            cols = {row["name"] for row in conn.execute("pragma table_info(sessions)")}
            self.assertIn("last_ingest_offset", cols)

            row = conn.execute("select id, last_ingest_offset from sessions where name='w'").fetchone()
            self.assertIsNotNone(row)
            self.assertIsNone(row["last_ingest_offset"])  # NULL means "not yet ingested"

    def test_insert_codex_event_persists_row(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)
            session_id = worker_db.register_session(
                conn, name="w", role="worker", codex_session_path="/a",
                codex_session_id="cuid-w", pid=1, cwd="/repo",
            )
            event_id = worker_db.insert_codex_event(
                conn,
                session_id=session_id,
                timestamp="2026-05-11T14:32:11.791Z",
                event_type="event_msg",
                subtype="task_started",
                payload={"turn_id": "t1", "started_at": "2026-05-11T14:32:11Z"},
                byte_offset=128,
            )
            self.assertIsInstance(event_id, int)
            row = conn.execute(
                "select session_id, type, subtype, byte_offset from codex_events where id = ?",
                (event_id,),
            ).fetchone()
            self.assertEqual(row["session_id"], session_id)
            self.assertEqual(row["type"], "event_msg")
            self.assertEqual(row["subtype"], "task_started")
            self.assertEqual(row["byte_offset"], 128)

    def test_latest_codex_events_for_session_orders_and_limits(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)
            session_id = worker_db.register_session(
                conn, name="w", role="worker", codex_session_path="/a",
                codex_session_id="cuid-w", pid=1, cwd="/repo",
            )
            for i in range(5):
                worker_db.insert_codex_event(
                    conn, session_id=session_id,
                    timestamp=f"2026-05-11T14:32:{10+i:02d}Z",
                    event_type="event_msg",
                    subtype="agent_message",
                    payload={"i": i},
                    byte_offset=i * 100,
                )
            rows = worker_db.latest_codex_events_for_session(
                conn, session_id=session_id, limit=3,
            )
            self.assertEqual(len(rows), 3)
            # Newest first
            offsets = [r["byte_offset"] for r in rows]
            self.assertEqual(offsets, [400, 300, 200])

    def test_set_session_ingest_offset_updates_column(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)
            session_id = worker_db.register_session(
                conn, name="w", role="worker", codex_session_path="/a",
                codex_session_id="cuid-w", pid=1, cwd="/repo",
            )
            # NULL semantics: freshly registered session has no offset.
            initial = conn.execute(
                "select last_ingest_offset from sessions where id = ?", (session_id,)
            ).fetchone()
            self.assertIsNone(initial["last_ingest_offset"])

            worker_db.set_session_ingest_offset(conn, session_id=session_id, offset=42)
            row = conn.execute(
                "select last_ingest_offset from sessions where id = ?", (session_id,)
            ).fetchone()
            self.assertEqual(row["last_ingest_offset"], 42)

            # Also verify offset 0 is distinguishable from NULL — round-trip 0.
            worker_db.set_session_ingest_offset(conn, session_id=session_id, offset=0)
            row = conn.execute(
                "select last_ingest_offset from sessions where id = ?", (session_id,)
            ).fetchone()
            self.assertEqual(row["last_ingest_offset"], 0)

    def test_bump_session_heartbeat_sets_timestamp(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)
            session_id = worker_db.register_session(
                conn, name="w", role="worker", codex_session_path="/a",
                codex_session_id="cuid-w", pid=1, cwd="/repo",
            )
            worker_db.bump_session_heartbeat(
                conn, session_id=session_id, timestamp="2026-05-11T15:00:00Z",
            )
            row = conn.execute(
                "select last_heartbeat_at from sessions where id = ?", (session_id,)
            ).fetchone()
            self.assertEqual(row["last_heartbeat_at"], "2026-05-11T15:00:00Z")


class IngestModuleTests(unittest.TestCase):
    def test_parse_jsonl_events_empty_content_yields_nothing(self):
        from workerctl import ingest

        events = list(ingest.parse_jsonl_events(b"", start_offset=0))
        self.assertEqual(events, [])

    def test_parse_jsonl_events_yields_parsed_records_with_offsets(self):
        from workerctl import ingest

        line1 = '{"type":"session_meta","payload":{"id":"u1","cwd":"/r"}}\n'
        line2 = '{"timestamp":"2026-05-11T14:32:11Z","type":"event_msg","payload":{"type":"task_started","turn_id":"t1"}}\n'
        content = (line1 + line2).encode("utf-8")
        events = list(ingest.parse_jsonl_events(content, start_offset=0))
        self.assertEqual(len(events), 2)

        self.assertEqual(events[0]["type"], "session_meta")
        self.assertEqual(events[0]["payload"]["id"], "u1")
        self.assertEqual(events[0]["byte_offset"], 0)
        self.assertEqual(events[0]["new_offset"], len(line1.encode("utf-8")))

        self.assertEqual(events[1]["type"], "event_msg")
        self.assertEqual(events[1]["subtype"], "task_started")
        self.assertEqual(events[1]["byte_offset"], len(line1.encode("utf-8")))
        self.assertEqual(events[1]["new_offset"], len(content))
        self.assertEqual(events[1]["timestamp"], "2026-05-11T14:32:11Z")

    def test_parse_jsonl_events_ignores_partial_trailing_line(self):
        """If the file ends without a newline, the trailing partial line is skipped
        and the offset advances only to the last complete line."""
        from workerctl import ingest

        complete = '{"type":"event_msg","payload":{"type":"agent_message"}}\n'
        partial = '{"type":"event_'  # truncated mid-write
        content = (complete + partial).encode("utf-8")
        events = list(ingest.parse_jsonl_events(content, start_offset=0))
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["new_offset"], len(complete.encode("utf-8")))

    def test_parse_jsonl_events_respects_start_offset(self):
        from workerctl import ingest

        line1 = '{"type":"event_msg","payload":{"type":"agent_message"}}\n'
        line2 = '{"type":"event_msg","payload":{"type":"task_complete","duration_ms":100}}\n'
        content = (line1 + line2).encode("utf-8")
        start = len(line1.encode("utf-8"))
        # Caller has already read line1. Pass only the unread portion.
        events = list(ingest.parse_jsonl_events(content[start:], start_offset=start))
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["subtype"], "task_complete")
        self.assertEqual(events[0]["byte_offset"], start)
        self.assertEqual(events[0]["new_offset"], len(content))

    def test_parse_jsonl_events_skips_malformed_line(self):
        from workerctl import ingest

        good = '{"type":"event_msg","payload":{"type":"agent_message"}}\n'
        bad = '{this is not json}\n'
        good2 = '{"type":"event_msg","payload":{"type":"task_complete"}}\n'
        content = (good + bad + good2).encode("utf-8")
        events = list(ingest.parse_jsonl_events(content, start_offset=0))
        # Malformed line is skipped; offsets still advance past it.
        self.assertEqual(len(events), 2)
        self.assertEqual(events[0]["subtype"], "agent_message")
        self.assertEqual(events[1]["subtype"], "task_complete")
        self.assertEqual(events[1]["new_offset"], len(content))

    def test_infer_state_returns_busy_for_task_started(self):
        from workerctl import ingest
        self.assertEqual(
            ingest.infer_state({"type": "event_msg", "subtype": "task_started", "payload": {}}),
            "busy",
        )

    def test_infer_state_returns_busy_for_user_message(self):
        from workerctl import ingest
        self.assertEqual(
            ingest.infer_state({"type": "event_msg", "subtype": "user_message", "payload": {}}),
            "busy",
        )

    def test_infer_state_returns_idle_for_task_complete(self):
        from workerctl import ingest
        self.assertEqual(
            ingest.infer_state({"type": "event_msg", "subtype": "task_complete", "payload": {}}),
            "idle",
        )

    def test_infer_state_returns_none_for_agent_message(self):
        from workerctl import ingest
        # agent_message indicates progress but doesn't change state
        self.assertIsNone(
            ingest.infer_state({"type": "event_msg", "subtype": "agent_message", "payload": {}}),
        )

    def test_infer_state_returns_none_for_token_count(self):
        from workerctl import ingest
        self.assertIsNone(
            ingest.infer_state({"type": "event_msg", "subtype": "token_count", "payload": {}}),
        )

    def test_infer_state_returns_none_for_non_event_msg(self):
        from workerctl import ingest
        self.assertIsNone(
            ingest.infer_state({"type": "response_item", "subtype": None, "payload": {}}),
        )
        self.assertIsNone(
            ingest.infer_state({"type": "session_meta", "subtype": None, "payload": {}}),
        )

    def test_current_state_returns_unknown_when_no_events(self):
        from workerctl import ingest

        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "workerctl.db"
            conn = worker_db.connect(path)
            self.addCleanup(conn.close)
            worker_db.initialize_database(conn)
            session_id = worker_db.register_session(
                conn, name="w", role="worker", codex_session_path="/a",
                codex_session_id="u", pid=1, cwd="/repo",
            )
            self.assertEqual(ingest.current_state(conn, session_id=session_id), "unknown")

    def test_current_state_walks_back_to_most_recent_state_event(self):
        from workerctl import ingest

        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "workerctl.db"
            conn = worker_db.connect(path)
            self.addCleanup(conn.close)
            worker_db.initialize_database(conn)
            session_id = worker_db.register_session(
                conn, name="w", role="worker", codex_session_path="/a",
                codex_session_id="u", pid=1, cwd="/repo",
            )
            # Sequence: task_started -> agent_message (no change) -> task_complete -> agent_message
            for subtype, offset in [
                ("task_started", 100),
                ("agent_message", 200),
                ("task_complete", 300),
                ("agent_message", 400),  # newest but no state change
            ]:
                worker_db.insert_codex_event(
                    conn, session_id=session_id,
                    timestamp="2026-05-11T00:00:00Z",
                    event_type="event_msg",
                    subtype=subtype,
                    payload={},
                    byte_offset=offset,
                )
            # Latest state-bearing event was task_complete -> idle
            self.assertEqual(ingest.current_state(conn, session_id=session_id), "idle")

    def test_current_state_picks_most_recent_busy_signal(self):
        from workerctl import ingest

        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "workerctl.db"
            conn = worker_db.connect(path)
            self.addCleanup(conn.close)
            worker_db.initialize_database(conn)
            session_id = worker_db.register_session(
                conn, name="w", role="worker", codex_session_path="/a",
                codex_session_id="u", pid=1, cwd="/repo",
            )
            for subtype, offset in [
                ("task_complete", 100),
                ("user_message", 200),
                ("task_started", 300),
            ]:
                worker_db.insert_codex_event(
                    conn, session_id=session_id,
                    timestamp="2026-05-11T00:00:00Z",
                    event_type="event_msg",
                    subtype=subtype,
                    payload={},
                    byte_offset=offset,
                )
            self.assertEqual(ingest.current_state(conn, session_id=session_id), "busy")

    def test_ingest_session_persists_new_events_and_advances_offset(self):
        from workerctl import ingest

        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "workerctl.db"
            rollout = Path(tmpdir) / "rollout.jsonl"
            conn = worker_db.connect(db_path)
            self.addCleanup(conn.close)
            worker_db.initialize_database(conn)

            # Create a rollout file with two events.
            line1 = json.dumps({"type": "session_meta", "payload": {"id": "u", "cwd": "/r"}}) + "\n"
            line2 = json.dumps({
                "timestamp": "2026-05-11T14:32:11Z",
                "type": "event_msg",
                "payload": {"type": "task_started", "turn_id": "t1"},
            }) + "\n"
            rollout.write_text(line1 + line2)

            worker_db.register_session(
                conn, name="w", role="worker",
                codex_session_path=str(rollout),
                codex_session_id="u", pid=1, cwd="/r",
            )
            conn.commit()

            result = ingest.ingest_session(conn, session_name="w")
            self.assertEqual(result["new_events"], 2)
            self.assertEqual(result["new_offset"], len((line1 + line2).encode("utf-8")))

            rows = conn.execute(
                "select type, subtype, byte_offset from codex_events "
                "where session_id = (select id from sessions where name='w') "
                "order by id"
            ).fetchall()
            self.assertEqual(len(rows), 2)
            self.assertEqual(rows[0]["type"], "session_meta")
            self.assertEqual(rows[1]["type"], "event_msg")
            self.assertEqual(rows[1]["subtype"], "task_started")

            offset_row = conn.execute(
                "select last_ingest_offset, last_heartbeat_at from sessions where name='w'"
            ).fetchone()
            self.assertEqual(offset_row["last_ingest_offset"], result["new_offset"])
            self.assertIsNotNone(offset_row["last_heartbeat_at"])

    def test_ingest_session_is_idempotent_on_unchanged_file(self):
        from workerctl import ingest

        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "workerctl.db"
            rollout = Path(tmpdir) / "rollout.jsonl"
            conn = worker_db.connect(db_path)
            self.addCleanup(conn.close)
            worker_db.initialize_database(conn)

            rollout.write_text(json.dumps({
                "type": "event_msg",
                "payload": {"type": "task_started"},
            }) + "\n")
            worker_db.register_session(
                conn, name="w", role="worker",
                codex_session_path=str(rollout),
                codex_session_id="u", pid=1, cwd="/r",
            )
            conn.commit()

            r1 = ingest.ingest_session(conn, session_name="w")
            r2 = ingest.ingest_session(conn, session_name="w")
            self.assertEqual(r1["new_events"], 1)
            self.assertEqual(r2["new_events"], 0)

            count = conn.execute("select count(*) from codex_events").fetchone()[0]
            self.assertEqual(count, 1)

    def test_ingest_session_picks_up_appended_events(self):
        from workerctl import ingest

        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "workerctl.db"
            rollout = Path(tmpdir) / "rollout.jsonl"
            conn = worker_db.connect(db_path)
            self.addCleanup(conn.close)
            worker_db.initialize_database(conn)

            initial = json.dumps({"type": "event_msg", "payload": {"type": "task_started"}}) + "\n"
            rollout.write_text(initial)
            worker_db.register_session(
                conn, name="w", role="worker",
                codex_session_path=str(rollout),
                codex_session_id="u", pid=1, cwd="/r",
            )
            conn.commit()
            ingest.ingest_session(conn, session_name="w")

            # Append a second event
            with open(rollout, "a") as fh:
                fh.write(json.dumps({"type": "event_msg", "payload": {"type": "task_complete"}}) + "\n")

            result = ingest.ingest_session(conn, session_name="w")
            self.assertEqual(result["new_events"], 1)
            rows = conn.execute("select subtype from codex_events order by id").fetchall()
            self.assertEqual([r["subtype"] for r in rows], ["task_started", "task_complete"])

    def test_ingest_session_raises_on_missing_session(self):
        from workerctl import ingest

        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "workerctl.db"
            conn = worker_db.connect(db_path)
            self.addCleanup(conn.close)
            worker_db.initialize_database(conn)
            with self.assertRaises(WorkerError):
                ingest.ingest_session(conn, session_name="does-not-exist")

    def test_ingest_session_raises_when_rollout_path_missing(self):
        from workerctl import ingest

        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "workerctl.db"
            conn = worker_db.connect(db_path)
            self.addCleanup(conn.close)
            worker_db.initialize_database(conn)
            worker_db.register_session(
                conn, name="w", role="worker",
                codex_session_path=str(Path(tmpdir) / "does-not-exist.jsonl"),
                codex_session_id="u", pid=1, cwd="/r",
            )
            conn.commit()
            from workerctl.ingest import IngestError
            with self.assertRaises(IngestError):
                ingest.ingest_session(conn, session_name="w")

    def test_ingest_session_raises_on_rollout_file_shrink(self):
        """If the rollout file was rotated to a shorter file (or truncated), the
        cached last_ingest_offset is now past EOF. Surface this as IngestError so
        the operator can decide whether to reset."""
        from workerctl import ingest
        from workerctl.ingest import IngestError

        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "workerctl.db"
            rollout = Path(tmpdir) / "rollout.jsonl"
            conn = worker_db.connect(db_path)
            self.addCleanup(conn.close)
            worker_db.initialize_database(conn)

            # Initial ingest reads two events.
            line1 = json.dumps({"type": "event_msg", "payload": {"type": "task_started"}}) + "\n"
            line2 = json.dumps({"type": "event_msg", "payload": {"type": "task_complete"}}) + "\n"
            rollout.write_text(line1 + line2)
            worker_db.register_session(
                conn, name="w", role="worker",
                codex_session_path=str(rollout),
                codex_session_id="u", pid=1, cwd="/r",
            )
            conn.commit()
            ingest.ingest_session(conn, session_name="w")

            # Now truncate (simulate rotation): rewrite with only one (different) event.
            rollout.write_text(json.dumps({"type": "event_msg", "payload": {"type": "task_started"}}) + "\n")

            with self.assertRaises(IngestError) as ctx:
                ingest.ingest_session(conn, session_name="w")
            self.assertIn("rollout file shrank", str(ctx.exception))

    def test_ingest_session_refuses_gone_session(self):
        from workerctl import ingest
        from workerctl.ingest import IngestError

        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "workerctl.db"
            rollout = Path(tmpdir) / "rollout.jsonl"
            rollout.write_text(json.dumps({"type": "event_msg", "payload": {"type": "task_started"}}) + "\n")
            conn = worker_db.connect(db_path)
            self.addCleanup(conn.close)
            worker_db.initialize_database(conn)
            worker_db.register_session(
                conn, name="w", role="worker",
                codex_session_path=str(rollout),
                codex_session_id="u", pid=1, cwd="/r",
            )
            worker_db.deregister_session(conn, name="w")
            conn.commit()

            with self.assertRaises(IngestError) as ctx:
                ingest.ingest_session(conn, session_name="w")
            self.assertIn("gone", str(ctx.exception))

    def test_parse_jsonl_events_with_stats_counts_skipped_lines(self):
        from workerctl import ingest

        content = (
            b'{"type":"event_msg","payload":{"type":"task_started"}}\n'
            b'not-json-at-all\n'
            b'{"type":"event_msg","payload":{"type":"agent_message"}}\n'
            b'{"not_a_record": "missing type field"}\n'
            b'42\n'  # non-dict top-level
            b'{"type":"event_msg","payload":{"type":"task_complete"}}\n'
        )
        events, skipped = ingest.parse_jsonl_events_with_stats(
            content, start_offset=0,
        )
        self.assertEqual(len(events), 3)
        self.assertEqual(skipped, 3)

    def test_ingest_session_reports_skipped_lines(self):
        from workerctl import ingest

        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "workerctl.db"
            rollout = Path(tmpdir) / "rollout.jsonl"
            conn = worker_db.connect(db_path)
            self.addCleanup(conn.close)
            worker_db.initialize_database(conn)

            rollout.write_text(
                json.dumps({"type": "event_msg", "payload": {"type": "task_started"}}) + "\n"
                + "garbage-line-no-json\n"
                + json.dumps({"type": "event_msg", "payload": {"type": "task_complete"}}) + "\n"
            )
            worker_db.register_session(
                conn, name="w", role="worker",
                codex_session_path=str(rollout),
                codex_session_id="u", pid=1, cwd="/r",
            )
            conn.commit()

            result = ingest.ingest_session(conn, session_name="w")
            self.assertEqual(result["new_events"], 2)
            self.assertEqual(result["skipped_lines"], 1)


class IngestCliTests(unittest.TestCase):
    def run_cli(self, *args, env_extra=None):
        env = os.environ.copy()
        if env_extra:
            env.update(env_extra)
        return subprocess.run(
            [sys.executable, "-m", "workerctl", *args],
            capture_output=True, text=True, env=env, cwd=str(ROOT),
        )

    def _setup_with_rollout(self, tmpdir, events):
        rollout = Path(tmpdir) / "rollout.jsonl"
        # register-worker requires the rollout to begin with session_meta.
        prepared = list(events)
        if not prepared or prepared[0].get("type") != "session_meta":
            prepared.insert(0, {"type": "session_meta", "payload": {"id": "u1", "cwd": "/r"}})
        rollout.write_text("".join(json.dumps(e) + "\n" for e in prepared))
        state_dir = Path(tmpdir) / "state"
        state_dir.mkdir()
        env = {"WORKERCTL_STATE_ROOT": str(state_dir)}
        self.run_cli(
            "register-worker", "--name", "w",
            "--codex-session", str(rollout),
            "--pid", "1", "--cwd", str(ROOT),
            env_extra=env,
        )
        return rollout, state_dir, env

    def test_cli_ingest_persists_events(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            rollout, state_dir, env = self._setup_with_rollout(tmpdir, events=[
                {"type": "session_meta", "payload": {"id": "u1", "cwd": "/r"}},
                {"timestamp": "2026-05-11T14:32:11Z",
                 "type": "event_msg",
                 "payload": {"type": "task_started", "turn_id": "t1"}},
            ])
            proc = self.run_cli("ingest", "w", env_extra=env)
            self.assertEqual(proc.returncode, 0, proc.stderr)
            result = json.loads(proc.stdout)
            self.assertEqual(result["new_events"], 2)
            self.assertEqual(result["session"], "w")

            conn = worker_db.connect(state_dir / "workerctl.db")
            self.addCleanup(conn.close)
            count = conn.execute(
                "select count(*) from codex_events where session_id = "
                "(select id from sessions where name='w')"
            ).fetchone()[0]
            self.assertEqual(count, 2)

    def test_cli_tail_prints_events(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            rollout, state_dir, env = self._setup_with_rollout(tmpdir, events=[
                {"timestamp": "2026-05-11T14:32:11Z",
                 "type": "event_msg",
                 "payload": {"type": "task_started", "turn_id": "t1"}},
                {"timestamp": "2026-05-11T14:32:12Z",
                 "type": "event_msg",
                 "payload": {"type": "task_complete", "duration_ms": 1000}},
            ])
            self.run_cli("ingest", "w", env_extra=env)

            proc = self.run_cli("tail", "w", env_extra=env)
            self.assertEqual(proc.returncode, 0, proc.stderr)
            events = json.loads(proc.stdout)
            # Newest first; event_msg entries appear before the prepended session_meta.
            event_msgs = [e for e in events if e["type"] == "event_msg"]
            self.assertEqual(len(event_msgs), 2)
            self.assertEqual(event_msgs[0]["subtype"], "task_complete")
            self.assertEqual(event_msgs[1]["subtype"], "task_started")

    def test_cli_tail_respects_limit(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            events_list = [
                {"timestamp": f"2026-05-11T14:32:{10+i:02d}Z",
                 "type": "event_msg",
                 "payload": {"type": "agent_message", "message": f"chunk {i}"}}
                for i in range(5)
            ]
            rollout, state_dir, env = self._setup_with_rollout(tmpdir, events=events_list)
            self.run_cli("ingest", "w", env_extra=env)

            proc = self.run_cli("tail", "w", "--limit", "2", env_extra=env)
            self.assertEqual(proc.returncode, 0, proc.stderr)
            events = json.loads(proc.stdout)
            self.assertEqual(len(events), 2)

    def test_cli_ingest_unknown_session_clean_error(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            state_dir = Path(tmpdir) / "state"
            state_dir.mkdir()
            proc = self.run_cli(
                "ingest", "missing",
                env_extra={"WORKERCTL_STATE_ROOT": str(state_dir)},
            )
            self.assertEqual(proc.returncode, 1)
            self.assertNotIn("Traceback", proc.stderr)
            self.assertIn("workerctl:", proc.stderr)


class StalenessTests(unittest.TestCase):
    def open_db(self, tmpdir):
        path = Path(tmpdir) / "workerctl.db"
        conn = worker_db.connect(path)
        worker_db.initialize_database(conn)
        self.addCleanup(conn.close)
        return conn

    def _register(self, conn):
        return worker_db.register_session(
            conn, name="w", role="worker", codex_session_path="/a",
            codex_session_id="cuid-w", pid=1, cwd="/repo",
        )

    def test_last_state_event_timestamp_none_when_no_events(self):
        from workerctl import ingest

        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)
            sid = self._register(conn)
            self.assertIsNone(
                ingest.last_state_event_timestamp(conn, session_id=sid),
            )

    def test_last_state_event_timestamp_skips_non_state_bearing(self):
        from workerctl import ingest

        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)
            sid = self._register(conn)
            # Only non-state-bearing events present.
            worker_db.insert_codex_event(
                conn, session_id=sid,
                timestamp="2026-05-11T14:32:11Z",
                event_type="event_msg", subtype="agent_message",
                payload={}, byte_offset=0,
            )
            worker_db.insert_codex_event(
                conn, session_id=sid,
                timestamp="2026-05-11T14:32:12Z",
                event_type="event_msg", subtype="token_count",
                payload={}, byte_offset=100,
            )
            self.assertIsNone(
                ingest.last_state_event_timestamp(conn, session_id=sid),
            )

    def test_last_state_event_timestamp_returns_most_recent(self):
        from workerctl import ingest

        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)
            sid = self._register(conn)
            for subtype, ts, offset in [
                ("task_started", "2026-05-11T14:32:10Z", 0),
                ("agent_message", "2026-05-11T14:32:11Z", 100),
                ("task_complete", "2026-05-11T14:32:12Z", 200),
                ("agent_message", "2026-05-11T14:32:13Z", 300),
            ]:
                worker_db.insert_codex_event(
                    conn, session_id=sid,
                    timestamp=ts, event_type="event_msg",
                    subtype=subtype, payload={}, byte_offset=offset,
                )
            self.assertEqual(
                ingest.last_state_event_timestamp(conn, session_id=sid),
                "2026-05-11T14:32:12Z",
            )

    def test_session_staleness_seconds_none_when_no_state_events(self):
        from workerctl import ingest

        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)
            sid = self._register(conn)
            self.assertIsNone(
                ingest.session_staleness_seconds(
                    conn, session_id=sid, now="2026-05-11T14:33:00Z",
                ),
            )

    def test_session_staleness_seconds_computes_against_now(self):
        from workerctl import ingest

        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)
            sid = self._register(conn)
            worker_db.insert_codex_event(
                conn, session_id=sid,
                timestamp="2026-05-11T14:30:00Z",
                event_type="event_msg", subtype="task_complete",
                payload={}, byte_offset=0,
            )
            staleness = ingest.session_staleness_seconds(
                conn, session_id=sid, now="2026-05-11T14:35:00Z",
            )
            self.assertEqual(staleness, 300)


class SessionTmuxTests(unittest.TestCase):
    def open_db(self, tmpdir):
        path = Path(tmpdir) / "workerctl.db"
        conn = worker_db.connect(path)
        worker_db.initialize_database(conn)
        self.addCleanup(conn.close)
        return conn

    def _register_with_tmux(self, conn, **overrides):
        kwargs = {
            "name": "w", "role": "worker",
            "codex_session_path": "/a", "codex_session_id": "u", "pid": 1, "cwd": "/repo",
            "tmux_session": "codex-w", "tmux_pane_id": "%5",
        }
        kwargs.update(overrides)
        return worker_db.register_session(conn, **kwargs)

    def test_session_tmux_target_uses_session_and_pane(self):
        from workerctl import tmux as worker_tmux

        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)
            self._register_with_tmux(conn)
            row = worker_db.session_row(conn, name="w")
            target = worker_tmux.session_tmux_target(row)
            self.assertEqual(target, "codex-w:%5")

    def test_session_tmux_target_falls_back_to_session_when_no_pane(self):
        from workerctl import tmux as worker_tmux

        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)
            self._register_with_tmux(conn, tmux_pane_id=None)
            row = worker_db.session_row(conn, name="w")
            self.assertEqual(worker_tmux.session_tmux_target(row), "codex-w")

    def test_session_exists_raises_on_tmux_permission_denied(self):
        from workerctl import tmux as worker_tmux

        original_run = worker_tmux.run
        try:
            worker_tmux.run = lambda argv, **kwargs: subprocess.CompletedProcess(
                argv, 1, "", "Operation not permitted\n"
            )

            with self.assertRaisesRegex(WorkerError, "tmux access was denied"):
                worker_tmux.session_exists("blocked")
        finally:
            worker_tmux.run = original_run

    def test_send_text_to_session_raises_when_no_tmux_session(self):
        from workerctl import tmux as worker_tmux
        from workerctl.core import WorkerError

        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)
            worker_db.register_session(
                conn, name="m", role="manager",
                codex_session_path="/a", codex_session_id="u", pid=1, cwd="/repo",
            )
            with self.assertRaises(WorkerError):
                worker_tmux.send_text_to_session(conn, session_name="m", text="hi")

    def test_send_text_to_session_dry_run_does_not_invoke_tmux(self):
        from workerctl import tmux as worker_tmux

        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)
            self._register_with_tmux(conn)
            captured_calls = []

            def fake_run(cmd, check=True):
                captured_calls.append(list(cmd))
                class Result:
                    returncode = 0
                    stdout = ""
                    stderr = ""
                return Result()

            original_run = worker_tmux.run
            worker_tmux.run = fake_run
            try:
                result = worker_tmux.send_text_to_session(
                    conn, session_name="w", text="hello", dry_run=True,
                )
            finally:
                worker_tmux.run = original_run

            self.assertEqual(captured_calls, [])
            self.assertEqual(result["dry_run"], True)
            self.assertEqual(result["target"], "codex-w:%5")
            self.assertEqual(result["text"], "hello")

    def test_send_text_to_session_raises_permission_error_instead_of_missing(self):
        from workerctl import tmux as worker_tmux

        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)
            self._register_with_tmux(conn)
            original_run = worker_tmux.run
            try:
                worker_tmux.run = lambda argv, **kwargs: subprocess.CompletedProcess(
                    argv, 1, "", "Operation not permitted\n"
                )

                with self.assertRaisesRegex(WorkerError, "tmux access was denied"):
                    worker_tmux.send_text_to_session(conn, session_name="w", text="hello")
            finally:
                worker_tmux.run = original_run

    def test_send_text_to_session_invokes_set_paste_send_keys(self):
        from workerctl import tmux as worker_tmux

        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)
            self._register_with_tmux(conn)
            calls = []

            def fake_run(cmd, check=True):
                calls.append(list(cmd))
                class Result:
                    returncode = 0
                    stdout = ""
                    stderr = ""
                return Result()

            original_run = worker_tmux.run
            worker_tmux.run = fake_run
            try:
                worker_tmux.send_text_to_session(
                    conn, session_name="w", text="payload",
                )
            finally:
                worker_tmux.run = original_run

            verbs = [c[1] for c in calls if len(c) > 1]
            self.assertIn("set-buffer", verbs)
            self.assertIn("paste-buffer", verbs)
            self.assertIn("send-keys", verbs)
            self.assertIn("delete-buffer", verbs)
            paste_calls = [c for c in calls if len(c) > 1 and c[1] == "paste-buffer"]
            send_calls = [c for c in calls if len(c) > 1 and c[1] == "send-keys"]
            self.assertTrue(all("codex-w:%5" in c for c in paste_calls))
            self.assertTrue(all("codex-w:%5" in c for c in send_calls))

    def test_interrupt_session_dry_run(self):
        from workerctl import tmux as worker_tmux

        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)
            self._register_with_tmux(conn)
            captured_calls = []

            def fake_run(cmd, check=True):
                captured_calls.append(list(cmd))
                class Result:
                    returncode = 0
                    stdout = ""
                    stderr = ""
                return Result()

            original_run = worker_tmux.run
            worker_tmux.run = fake_run
            try:
                result = worker_tmux.interrupt_session(
                    conn, session_name="w", dry_run=True,
                )
            finally:
                worker_tmux.run = original_run

            self.assertEqual(captured_calls, [])
            self.assertEqual(result["dry_run"], True)
            self.assertEqual(result["key"], "C-c")

    def test_interrupt_session_sends_key_then_followup_to_target(self):
        from workerctl import tmux as worker_tmux

        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)
            self._register_with_tmux(conn)
            calls = []

            def fake_run(cmd, check=True):
                calls.append(list(cmd))
                class Result:
                    returncode = 0
                    stdout = ""
                    stderr = ""
                return Result()

            original_run = worker_tmux.run
            worker_tmux.run = fake_run
            try:
                worker_tmux.interrupt_session(
                    conn, session_name="w",
                    key="C-c", followup="retry please",
                )
            finally:
                worker_tmux.run = original_run

            # Must include: has-session liveness check, send-keys C-c, then the
            # send_text_to_session follow-up (set-buffer / paste-buffer / send-keys / delete-buffer).
            verbs = [c[1] if len(c) > 1 else c[0] for c in calls]
            self.assertIn("has-session", verbs)
            send_key_calls = [c for c in calls if len(c) > 1 and c[1] == "send-keys"]
            # First send-keys should be the interrupt key against our target.
            self.assertEqual(send_key_calls[0], ["tmux", "send-keys", "-t", "codex-w:%5", "C-c"])
            # Followup payload must reach set-buffer.
            set_buffer_calls = [c for c in calls if len(c) > 1 and c[1] == "set-buffer"]
            self.assertTrue(any("retry please" in c for c in set_buffer_calls))
            # All targets must point at our resolved pane.
            paste_calls = [c for c in calls if len(c) > 1 and c[1] == "paste-buffer"]
            self.assertTrue(all("codex-w:%5" in c for c in paste_calls))

    def test_interrupt_session_no_followup_does_not_send_text(self):
        from workerctl import tmux as worker_tmux

        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)
            self._register_with_tmux(conn)
            calls = []

            def fake_run(cmd, check=True):
                calls.append(list(cmd))
                class Result:
                    returncode = 0
                    stdout = ""
                    stderr = ""
                return Result()

            original_run = worker_tmux.run
            worker_tmux.run = fake_run
            try:
                worker_tmux.interrupt_session(
                    conn, session_name="w", key="C-c", followup=None,
                )
            finally:
                worker_tmux.run = original_run

            # No followup -> no set-buffer/paste-buffer at all.
            verbs = [c[1] if len(c) > 1 else c[0] for c in calls]
            self.assertNotIn("set-buffer", verbs)
            self.assertNotIn("paste-buffer", verbs)

    def test_send_text_to_session_carries_text_in_correct_order(self):
        from workerctl import tmux as worker_tmux

        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)
            self._register_with_tmux(conn)
            calls = []

            def fake_run(cmd, check=True):
                calls.append(list(cmd))
                class Result:
                    returncode = 0
                    stdout = ""
                    stderr = ""
                return Result()

            original_run = worker_tmux.run
            worker_tmux.run = fake_run
            try:
                worker_tmux.send_text_to_session(
                    conn, session_name="w", text="payload-with-unique-marker",
                )
            finally:
                worker_tmux.run = original_run

            # Find the set-buffer / paste-buffer / send-keys / delete-buffer indexes.
            verbs = [c[1] if len(c) > 1 else c[0] for c in calls]
            set_idx = verbs.index("set-buffer")
            paste_idx = verbs.index("paste-buffer")
            send_keys_idxs = [i for i, v in enumerate(verbs) if v == "send-keys"]
            self.assertTrue(send_keys_idxs, "expected at least one send-keys call")
            send_idx = send_keys_idxs[0]
            delete_idx = verbs.index("delete-buffer")
            # Ordering: set-buffer < paste-buffer < send-keys < delete-buffer.
            self.assertLess(set_idx, paste_idx)
            self.assertLess(paste_idx, send_idx)
            self.assertLess(send_idx, delete_idx)
            # Text payload must reach set-buffer.
            self.assertIn("payload-with-unique-marker", calls[set_idx])


class SessionActionCliTests(unittest.TestCase):
    def run_cli(self, *args, env_extra=None):
        env = os.environ.copy()
        if env_extra:
            env.update(env_extra)
        return subprocess.run(
            [sys.executable, "-m", "workerctl", *args],
            capture_output=True, text=True, env=env, cwd=str(ROOT),
        )

    def _setup_with_worker(self, tmpdir):
        rollout = Path(tmpdir) / "rollout.jsonl"
        rollout.write_text(json.dumps({
            "type": "session_meta",
            "payload": {"id": "u", "cwd": str(ROOT), "originator": "codex-tui"},
        }) + "\n")
        state_dir = Path(tmpdir) / "state"
        state_dir.mkdir()
        env = {"WORKERCTL_STATE_ROOT": str(state_dir)}
        self.run_cli(
            "register-worker", "--name", "w",
            "--codex-session", str(rollout),
            "--pid", "1", "--cwd", str(ROOT),
            "--tmux-session", "codex-w",
            env_extra=env,
        )
        return rollout, state_dir, env

    def test_cli_session_nudge_dry_run(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            _, state_dir, env = self._setup_with_worker(tmpdir)
            proc = self.run_cli(
                "session-nudge", "w", "hello there", "--dry-run",
                env_extra=env,
            )
            self.assertEqual(proc.returncode, 0, proc.stderr)
            payload = json.loads(proc.stdout)
            self.assertEqual(payload["session"], "w")
            self.assertEqual(payload["text"], "hello there")
            self.assertEqual(payload["dry_run"], True)
            self.assertIn("codex-w", payload["target"])

    def test_cli_session_nudge_rejects_session_without_tmux(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            rollout = Path(tmpdir) / "rollout.jsonl"
            rollout.write_text(json.dumps({
                "type": "session_meta",
                "payload": {"id": "u", "cwd": str(ROOT), "originator": "codex-tui"},
            }) + "\n")
            state_dir = Path(tmpdir) / "state"
            state_dir.mkdir()
            env = {"WORKERCTL_STATE_ROOT": str(state_dir)}
            # Register a manager WITHOUT --tmux-session — clean error path.
            self.run_cli(
                "register-manager", "--name", "m",
                "--codex-session", str(rollout),
                "--pid", "2", "--cwd", str(ROOT),
                env_extra=env,
            )
            proc = self.run_cli(
                "session-nudge", "m", "shouldn't work", "--dry-run",
                env_extra=env,
            )
            self.assertEqual(proc.returncode, 1)
            self.assertNotIn("Traceback", proc.stderr)
            self.assertIn("workerctl:", proc.stderr)

    def test_cli_session_interrupt_dry_run(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            _, state_dir, env = self._setup_with_worker(tmpdir)
            proc = self.run_cli(
                "session-interrupt", "w", "--dry-run",
                env_extra=env,
            )
            self.assertEqual(proc.returncode, 0, proc.stderr)
            payload = json.loads(proc.stdout)
            self.assertEqual(payload["session"], "w")
            self.assertEqual(payload["key"], "C-c")
            self.assertEqual(payload["dry_run"], True)

    def test_cli_session_interrupt_dry_run_with_followup(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            _, state_dir, env = self._setup_with_worker(tmpdir)
            proc = self.run_cli(
                "session-interrupt", "w",
                "--followup", "retry please",
                "--dry-run",
                env_extra=env,
            )
            self.assertEqual(proc.returncode, 0, proc.stderr)
            payload = json.loads(proc.stdout)
            self.assertEqual(payload["session"], "w")
            self.assertEqual(payload["key"], "C-c")
            self.assertEqual(payload["followup"], "retry please")
            self.assertEqual(payload["dry_run"], True)

            # Confirm the event payload carries followup_length, not the content.
            conn = worker_db.connect(state_dir / "workerctl.db")
            self.addCleanup(conn.close)
            row = conn.execute(
                "select payload_json from events where type = 'session_interrupted' "
                "order by id desc limit 1"
            ).fetchone()
            self.assertIsNotNone(row)
            event_payload = json.loads(row["payload_json"])
            self.assertEqual(event_payload["followup_length"], len("retry please"))
            self.assertNotIn("followup", event_payload)  # content not stored

    def test_session_nudge_records_failure_event_when_tmux_fails(self):
        """When tmux send fails, the audit event must still be recorded with
        success=False so operators can debug from the events table."""
        with tempfile.TemporaryDirectory() as tmpdir:
            _, state_dir, env = self._setup_with_worker(tmpdir)
            # Use a name registered with a tmux_session that will NOT have a live
            # tmux session — the new session_exists check will raise WorkerError.
            # (The fixture's "codex-w" is registered as the tmux_session string,
            # but no tmux server has that session, so has-session will fail.)
            proc = self.run_cli(
                "session-nudge", "w", "will-fail-no-tmux",
                env_extra=env,
            )
            # Should exit non-zero with a clean error.
            self.assertNotEqual(proc.returncode, 0)
            self.assertNotIn("Traceback", proc.stderr)
            self.assertIn("workerctl:", proc.stderr)

            # And the audit event must be present with success=False.
            conn = worker_db.connect(state_dir / "workerctl.db")
            self.addCleanup(conn.close)
            row = conn.execute(
                "select payload_json from events where type='session_nudged' "
                "order by id desc limit 1"
            ).fetchone()
            self.assertIsNotNone(row, "session_nudged event must be recorded on failure")
            payload = json.loads(row["payload_json"])
            self.assertEqual(payload["success"], False)
            self.assertIn("error", payload)

    def test_session_nudge_attaches_rollback_error_when_rollback_fails(self):
        """When the inner conn.rollback() also fails, the audit event must
        record both the original tmux error AND the rollback error."""
        with tempfile.TemporaryDirectory() as tmpdir:
            state_dir = Path(tmpdir) / "state"
            state_dir.mkdir()
            os.environ["WORKERCTL_STATE_ROOT"] = str(state_dir)
            try:
                # Register a session via the CLI.
                rollout = Path(tmpdir) / "rollout.jsonl"
                rollout.write_text(json.dumps({
                    "type": "session_meta",
                    "payload": {"id": "u", "cwd": str(ROOT), "originator": "codex-tui"},
                }) + "\n")
                self.run_cli(
                    "register-worker", "--name", "w",
                    "--codex-session", str(rollout),
                    "--pid", "1", "--cwd", str(ROOT),
                    "--tmux-session", "codex-w",
                )

                # Monkey-patch: tmux raises, rollback raises.
                orig_send = worker_tmux.send_text_to_session
                orig_connect = worker_db.connect

                def boom_send(*a, **kw):
                    raise WorkerError("tmux exploded")

                class WrappedConn:
                    def __init__(self, conn):
                        self._conn = conn
                    def __getattr__(self, name):
                        return getattr(self._conn, name)
                    def rollback(self):
                        raise RuntimeError("rollback exploded")

                def wrapped_connect(*a, **kw):
                    return WrappedConn(orig_connect(*a, **kw))

                worker_tmux.send_text_to_session = boom_send
                worker_db.connect = wrapped_connect
                try:
                    args = argparse.Namespace(name="w", text="hi", dry_run=False)
                    with self.assertRaises(WorkerError):
                        commands.command_session_nudge(args)
                finally:
                    worker_tmux.send_text_to_session = orig_send
                    worker_db.connect = orig_connect

                # Check the audit event has BOTH errors.
                conn = worker_db.connect()
                self.addCleanup(conn.close)
                row = conn.execute(
                    "select payload_json from events where type='session_nudged' "
                    "order by id desc limit 1"
                ).fetchone()
                self.assertIsNotNone(row)
                payload = json.loads(row["payload_json"])
                self.assertEqual(payload["success"], False)
                self.assertIn("tmux exploded", payload["error"])
                self.assertIsNotNone(payload.get("rollback_error"))
                self.assertIn("rollback exploded", payload["rollback_error"])
            finally:
                os.environ.pop("WORKERCTL_STATE_ROOT", None)

    def test_session_interrupt_attaches_rollback_error_when_rollback_fails(self):
        """When the inner conn.rollback() also fails, the audit event must
        record both the original interrupt error AND the rollback error."""
        with tempfile.TemporaryDirectory() as tmpdir:
            state_dir = Path(tmpdir) / "state"
            state_dir.mkdir()
            os.environ["WORKERCTL_STATE_ROOT"] = str(state_dir)
            try:
                # Register a session via the CLI.
                rollout = Path(tmpdir) / "rollout.jsonl"
                rollout.write_text(json.dumps({
                    "type": "session_meta",
                    "payload": {"id": "u", "cwd": str(ROOT), "originator": "codex-tui"},
                }) + "\n")
                self.run_cli(
                    "register-worker", "--name", "w",
                    "--codex-session", str(rollout),
                    "--pid", "1", "--cwd", str(ROOT),
                    "--tmux-session", "codex-w",
                )

                # Monkey-patch: interrupt raises, rollback raises.
                orig_interrupt = worker_tmux.interrupt_session
                orig_connect = worker_db.connect

                def boom_interrupt(*a, **kw):
                    raise WorkerError("interrupt exploded")

                class WrappedConn:
                    def __init__(self, conn):
                        self._conn = conn
                    def __getattr__(self, name):
                        return getattr(self._conn, name)
                    def rollback(self):
                        raise RuntimeError("rollback exploded")

                def wrapped_connect(*a, **kw):
                    return WrappedConn(orig_connect(*a, **kw))

                worker_tmux.interrupt_session = boom_interrupt
                worker_db.connect = wrapped_connect
                try:
                    args = argparse.Namespace(
                        name="w", key="C-c", followup=None, dry_run=False
                    )
                    with self.assertRaises(WorkerError):
                        commands.command_session_interrupt(args)
                finally:
                    worker_tmux.interrupt_session = orig_interrupt
                    worker_db.connect = orig_connect

                # Check the audit event has BOTH errors.
                conn = worker_db.connect()
                self.addCleanup(conn.close)
                row = conn.execute(
                    "select payload_json from events where type='session_interrupted' "
                    "order by id desc limit 1"
                ).fetchone()
                self.assertIsNotNone(row)
                payload = json.loads(row["payload_json"])
                self.assertEqual(payload["success"], False)
                self.assertIn("interrupt exploded", payload["error"])
                self.assertIsNotNone(payload.get("rollback_error"))
                self.assertIn("rollback exploded", payload["rollback_error"])
            finally:
                os.environ.pop("WORKERCTL_STATE_ROOT", None)


class SuperviseCycleTests(unittest.TestCase):
    def open_db(self, tmpdir):
        path = Path(tmpdir) / "workerctl.db"
        conn = worker_db.connect(path)
        worker_db.initialize_database(conn)
        self.addCleanup(conn.close)
        return conn

    def _setup_bound_task(self, conn, tmpdir, rollout_events):
        rollout = Path(tmpdir) / "rollout.jsonl"
        rollout.write_text("".join(json.dumps(e) + "\n" for e in rollout_events))
        now = "2026-05-11T00:00:00Z"
        conn.execute(
            "insert into tasks(id, name, goal, state, created_at, updated_at) "
            "values ('task-1', 't', 'g', 'candidate', ?, ?)",
            (now, now),
        )
        worker_db.register_session(
            conn, name="w", role="worker",
            codex_session_path=str(rollout),
            codex_session_id="u-w", pid=1, cwd="/r",
        )
        worker_db.register_session(
            conn, name="m", role="manager",
            codex_session_path=str(rollout),  # reuses fixture; not under test
            codex_session_id="u-m", pid=2, cwd="/r",
        )
        worker_db.bind_sessions(
            conn, task_name="t",
            worker_session_name="w", manager_session_name="m",
        )
        conn.commit()
        return rollout

    def test_run_cycle_ingests_and_returns_state(self):
        from workerctl import supervise_cycle

        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)
            self._setup_bound_task(conn, tmpdir, [
                {"type": "session_meta", "payload": {"id": "u-w", "cwd": "/r"}},
                {"timestamp": "2026-05-11T14:32:11Z",
                 "type": "event_msg",
                 "payload": {"type": "task_started", "turn_id": "t1"}},
            ])

            result = supervise_cycle.run_cycle(
                conn, task_name="t", now="2026-05-11T14:32:15Z",
            )
            self.assertEqual(result["task"], "t")
            self.assertEqual(result["worker_session"], "w")
            self.assertEqual(result["manager_session"], "m")
            self.assertEqual(result["ingest"]["new_events"], 2)
            self.assertEqual(result["state"], "busy")
            self.assertEqual(result["last_state_event_at"], "2026-05-11T14:32:11Z")
            self.assertAlmostEqual(result["staleness_seconds"], 4.0, places=0)
            self.assertIn("cycle_id", result)

    def test_run_cycle_records_manager_cycle_row(self):
        from workerctl import supervise_cycle

        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)
            self._setup_bound_task(conn, tmpdir, [
                {"type": "session_meta", "payload": {"id": "u-w", "cwd": "/r"}},
                {"timestamp": "2026-05-11T14:32:11Z",
                 "type": "event_msg",
                 "payload": {"type": "task_complete"}},
            ])

            result = supervise_cycle.run_cycle(
                conn, task_name="t", now="2026-05-11T14:33:00Z",
            )
            row = conn.execute(
                "select state, status_json from manager_cycles where id = ?",
                (result["cycle_id"],),
            ).fetchone()
            self.assertIsNotNone(row)
            self.assertEqual(row["state"], "succeeded")
            status = json.loads(row["status_json"])
            self.assertEqual(status["state"], "idle")
            self.assertEqual(status["worker_session"], "w")

    def test_run_cycle_unknown_task_raises(self):
        from workerctl import supervise_cycle

        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)
            with self.assertRaises(WorkerError):
                supervise_cycle.run_cycle(conn, task_name="does-not-exist")

    def test_run_cycle_no_active_binding_raises(self):
        from workerctl import supervise_cycle

        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)
            now = "2026-05-11T00:00:00Z"
            conn.execute(
                "insert into tasks(id, name, goal, state, created_at, updated_at) "
                "values ('task-1', 't', 'g', 'candidate', ?, ?)",
                (now, now),
            )
            conn.commit()
            with self.assertRaises(WorkerError):
                supervise_cycle.run_cycle(conn, task_name="t")

    def test_run_cycle_handles_session_without_state_events(self):
        from workerctl import supervise_cycle

        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)
            self._setup_bound_task(conn, tmpdir, [
                {"type": "session_meta", "payload": {"id": "u-w", "cwd": "/r"}},
            ])

            result = supervise_cycle.run_cycle(
                conn, task_name="t", now="2026-05-11T14:32:15Z",
            )
            self.assertEqual(result["state"], "unknown")
            self.assertIsNone(result["last_state_event_at"])
            self.assertIsNone(result["staleness_seconds"])

    def test_run_cycle_records_failed_row_on_ingest_error(self):
        from workerctl import supervise_cycle
        from workerctl.ingest import IngestError

        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)
            # Build binding pointing at a rollout that does NOT exist on disk.
            now = "2026-05-11T00:00:00Z"
            conn.execute(
                "insert into tasks(id, name, goal, state, created_at, updated_at) "
                "values ('task-1', 't', 'g', 'candidate', ?, ?)",
                (now, now),
            )
            worker_db.register_session(
                conn, name="w", role="worker",
                codex_session_path=str(Path(tmpdir) / "does-not-exist.jsonl"),
                codex_session_id="u-w", pid=1, cwd="/r",
            )
            worker_db.register_session(
                conn, name="m", role="manager",
                codex_session_path="/m",
                codex_session_id="u-m", pid=2, cwd="/r",
            )
            worker_db.bind_sessions(
                conn, task_name="t",
                worker_session_name="w", manager_session_name="m",
            )
            conn.commit()

            with self.assertRaises(IngestError):
                supervise_cycle.run_cycle(
                    conn, task_name="t", now="2026-05-11T14:32:15Z",
                )

            # Failed row must be present for audit.
            row = conn.execute(
                "select state, status_json, error from manager_cycles "
                "where task_id = 'task-1' order by id desc limit 1"
            ).fetchone()
            self.assertIsNotNone(row)
            self.assertEqual(row["state"], "failed")
            self.assertIsNotNone(row["error"])
            status = json.loads(row["status_json"])
            self.assertEqual(status["kind"], "session_cycle")
            self.assertEqual(status["worker_session"], "w")

    def test_run_cycle_succeeded_row_has_kind_discriminator(self):
        from workerctl import supervise_cycle

        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)
            self._setup_bound_task(conn, tmpdir, [
                {"type": "session_meta", "payload": {"id": "u-w", "cwd": "/r"}},
                {"timestamp": "2026-05-11T14:32:11Z",
                 "type": "event_msg",
                 "payload": {"type": "task_complete"}},
            ])
            result = supervise_cycle.run_cycle(
                conn, task_name="t", now="2026-05-11T14:33:00Z",
            )
            self.assertEqual(result["kind"], "session_cycle")
            row = conn.execute(
                "select status_json from manager_cycles where id = ?",
                (result["cycle_id"],),
            ).fetchone()
            status = json.loads(row["status_json"])
            self.assertEqual(status["kind"], "session_cycle")

    def test_run_cycle_row_is_legible_via_replay(self):
        """Phase 3 manager_cycles rows should render a useful summary via the
        replay module, not the generic 'observed task' fallback."""
        from workerctl import supervise_cycle
        from workerctl import replay as worker_replay

        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)
            self._setup_bound_task(conn, tmpdir, [
                {"type": "session_meta", "payload": {"id": "u-w", "cwd": "/r"}},
                {"timestamp": "2026-05-11T14:32:11Z",
                 "type": "event_msg",
                 "payload": {"type": "task_started", "turn_id": "t1"}},
            ])
            supervise_cycle.run_cycle(
                conn, task_name="t", now="2026-05-11T14:32:15Z",
            )

            # Build the replay timeline and confirm the session cycle row was
            # rendered with the new-shape summary, not the generic fallback.
            audit = worker_db.task_audit(conn, task="t")
            entries = worker_replay.replay_entries(audit, role="all", mode="timeline")
            summary_lines = [
                entry["summary"]
                for entry in entries
                if entry.get("kind") == "observe"
            ]
            self.assertTrue(summary_lines, "expected at least one observe entry")
            joined = " | ".join(summary_lines)
            self.assertNotIn("observed task", joined,
                             f"replay produced generic fallback summary: {joined!r}")
            self.assertIn("busy", joined.lower())
            self.assertIn("w", joined)  # worker session name

    def test_replay_renders_failed_session_cycle_with_error(self):
        """Failed cycle rows must surface their error in replay output, not
        render as a generic 'state unknown' summary."""
        from workerctl import supervise_cycle
        from workerctl import replay as worker_replay
        from workerctl.ingest import IngestError

        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)
            # Build binding pointing at a rollout that does NOT exist on disk.
            now = "2026-05-11T00:00:00Z"
            conn.execute(
                "insert into tasks(id, name, goal, state, created_at, updated_at) "
                "values ('task-1', 't', 'g', 'candidate', ?, ?)",
                (now, now),
            )
            worker_db.register_session(
                conn, name="w", role="worker",
                codex_session_path=str(Path(tmpdir) / "does-not-exist.jsonl"),
                codex_session_id="u-w", pid=1, cwd="/r",
            )
            worker_db.register_session(
                conn, name="m", role="manager",
                codex_session_path="/m",
                codex_session_id="u-m", pid=2, cwd="/r",
            )
            worker_db.bind_sessions(
                conn, task_name="t",
                worker_session_name="w", manager_session_name="m",
            )
            conn.commit()

            with self.assertRaises(IngestError):
                supervise_cycle.run_cycle(conn, task_name="t")

            audit = worker_db.task_audit(conn, task="t")
            entries = worker_replay.replay_entries(audit, role="all", mode="timeline")
            cycle_summaries = [
                e.get("summary", "")
                for e in entries
                if e.get("kind") == "observe"
            ]
            joined = " | ".join(cycle_summaries).lower()
            self.assertIn("observe failed", joined,
                          f"replay did not surface failure text: {cycle_summaries!r}")
            self.assertNotIn("state unknown", joined,
                             f"replay used generic fallback: {cycle_summaries!r}")

    def test_run_cycle_includes_pane_signal_when_tmux_attached(self):
        from workerctl import supervise_cycle
        from workerctl import tmux as worker_tmux

        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)
            # Register worker with tmux_session populated so pane signal can resolve.
            rollout = Path(tmpdir) / "rollout.jsonl"
            rollout.write_text("".join(json.dumps(e) + "\n" for e in [
                {"type": "session_meta", "payload": {"id": "u-w", "cwd": "/r"}},
                {"timestamp": "2026-05-11T14:32:11Z",
                 "type": "event_msg",
                 "payload": {"type": "task_started"}},
            ]))
            now = "2026-05-11T00:00:00Z"
            conn.execute(
                "insert into tasks(id, name, goal, state, created_at, updated_at) "
                "values ('task-1', 't', 'g', 'candidate', ?, ?)",
                (now, now),
            )
            worker_db.register_session(
                conn, name="w", role="worker",
                codex_session_path=str(rollout),
                codex_session_id="u-w", pid=1, cwd="/r",
                tmux_session="codex-w", tmux_pane_id="%5",
            )
            worker_db.register_session(
                conn, name="m", role="manager",
                codex_session_path=str(rollout),
                codex_session_id="u-m", pid=2, cwd="/r",
            )
            worker_db.bind_sessions(
                conn, task_name="t",
                worker_session_name="w", manager_session_name="m",
            )
            conn.commit()

            # Stub the pane capture to return a trust-prompt-bearing string.
            original = worker_tmux.capture_tmux_target
            worker_tmux.capture_tmux_target = (
                lambda target, lines=100:
                "$ codex\nDo you trust the contents of this directory? (y/n)\n"
            )
            try:
                result = supervise_cycle.run_cycle(
                    conn, task_name="t", now="2026-05-11T14:33:50Z",
                )
            finally:
                worker_tmux.capture_tmux_target = original

            self.assertEqual(result["state"], "busy")
            self.assertEqual(result["notable_pane_pattern"], "trust_prompt")
            self.assertIsNotNone(result["pane_signal"])
            self.assertEqual(result["pane_signal"]["captured"], True)
            self.assertEqual(result["pane_signal"]["notable_pattern"], "trust_prompt")

    def test_run_cycle_pane_signal_none_when_session_has_no_tmux(self):
        """Manager-style sessions registered without --tmux-session should yield
        a non-captured pane_signal but the cycle still succeeds with JSON state."""
        from workerctl import supervise_cycle

        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)
            self._setup_bound_task(conn, tmpdir, [
                {"type": "session_meta", "payload": {"id": "u-w", "cwd": "/r"}},
                {"timestamp": "2026-05-11T14:32:11Z",
                 "type": "event_msg",
                 "payload": {"type": "task_complete"}},
            ])
            # _setup_bound_task registers worker WITHOUT tmux_session.
            result = supervise_cycle.run_cycle(
                conn, task_name="t", now="2026-05-11T14:33:00Z",
            )
            self.assertEqual(result["state"], "idle")
            self.assertIsNone(result["notable_pane_pattern"])
            self.assertIsNotNone(result["pane_signal"])
            self.assertEqual(result["pane_signal"]["captured"], False)
            self.assertEqual(result["pane_signal"]["reason"], "no tmux session attached")

    def test_run_cycle_pane_signal_swallows_capture_errors(self):
        """A tmux capture exception must not abort the cycle."""
        from workerctl import supervise_cycle
        from workerctl import tmux as worker_tmux
        from workerctl.core import WorkerError as CoreWorkerError

        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)
            # Re-use _setup_bound_task but then patch the worker session row to
            # add a tmux_session, so pane_signal tries to capture.
            self._setup_bound_task(conn, tmpdir, [
                {"type": "session_meta", "payload": {"id": "u-w", "cwd": "/r"}},
                {"timestamp": "2026-05-11T14:32:11Z",
                 "type": "event_msg",
                 "payload": {"type": "task_complete"}},
            ])
            conn.execute(
                "update sessions set tmux_session = 'codex-w', tmux_pane_id = '%5' "
                "where name = 'w'"
            )
            conn.commit()

            original = worker_tmux.capture_tmux_target

            def boom(target, lines=100):
                # WorkerError is what capture_tmux_target actually raises via
                # run() in real life — the narrowed except in shadow_state
                # treats this as a benign capture failure.
                raise CoreWorkerError("tmux server went away")

            worker_tmux.capture_tmux_target = boom
            try:
                result = supervise_cycle.run_cycle(
                    conn, task_name="t", now="2026-05-11T14:33:00Z",
                )
            finally:
                worker_tmux.capture_tmux_target = original

            self.assertEqual(result["state"], "idle")
            self.assertEqual(result["pane_signal"]["captured"], False)
            self.assertTrue(result["pane_signal"]["degraded"])
            self.assertIn("tmux server went away", result["pane_signal"]["reason"])
            self.assertIsNone(result["notable_pane_pattern"])

    def test_replay_renders_session_cycle_with_pane_pattern(self):
        """When a successful cycle has a notable_pane_pattern, the replay summary
        should mention it for operator visibility during the shadow period."""
        from workerctl import supervise_cycle
        from workerctl import replay as worker_replay
        from workerctl import tmux as worker_tmux

        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)
            self._setup_bound_task(conn, tmpdir, [
                {"type": "session_meta", "payload": {"id": "u-w", "cwd": "/r"}},
                {"timestamp": "2026-05-11T14:32:11Z",
                 "type": "event_msg",
                 "payload": {"type": "task_started"}},
            ])
            conn.execute(
                "update sessions set tmux_session = 'codex-w', tmux_pane_id = '%5' "
                "where name = 'w'"
            )
            conn.commit()

            original = worker_tmux.capture_tmux_target
            worker_tmux.capture_tmux_target = (
                lambda target, lines=100:
                "$ codex\nDo you trust the contents of this directory? (y/n)\n"
            )
            try:
                supervise_cycle.run_cycle(
                    conn, task_name="t", now="2026-05-11T14:33:50Z",
                )
            finally:
                worker_tmux.capture_tmux_target = original

            audit = worker_db.task_audit(conn, task="t")
            entries = list(worker_replay.replay_entries(audit))
            cycle_summaries = [
                e.get("summary", "")
                for e in entries
                if e.get("kind") == "observe"
            ]
            joined = " | ".join(cycle_summaries)
            self.assertIn("trust_prompt", joined,
                          f"replay did not surface pane pattern: {cycle_summaries!r}")
            self.assertIn("busy", joined.lower())

    def test_e2e_run_cycle_writes_row_visible_in_divergent_cycles_for_task(self):
        """End-to-end: a successful run_cycle with a detected pane pattern must
        write a manager_cycles row that divergent_cycles_for_task picks up.

        This catches writer/reader key-name mismatches (e.g. run_cycle writing
        `notable_pattern` instead of `notable_pane_pattern` at the top level)
        that would slip past both the unit tests in isolation."""
        from workerctl import supervise_cycle
        from workerctl import tmux as worker_tmux

        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)
            self._setup_bound_task(conn, tmpdir, [
                {"type": "session_meta", "payload": {"id": "u-w", "cwd": "/r"}},
                {"timestamp": "2026-05-11T14:32:11Z",
                 "type": "event_msg",
                 "payload": {"type": "task_started"}},
            ])
            conn.execute(
                "update sessions set tmux_session = 'codex-w', tmux_pane_id = '%5' "
                "where name = 'w'"
            )
            conn.commit()

            original = worker_tmux.capture_tmux_target
            worker_tmux.capture_tmux_target = (
                lambda target, lines=100:
                "$ codex\nDo you trust the contents of this directory? (y/n)\n"
            )
            try:
                # `now` is chosen so staleness > busy_wait_seconds (90s),
                # which lets classify_busy_wait actually return a pattern.
                result = supervise_cycle.run_cycle(
                    conn, task_name="t", now="2026-05-11T14:33:50Z",
                )
            finally:
                worker_tmux.capture_tmux_target = original

            rows = worker_db.divergent_cycles_for_task(conn, task_name="t")
            self.assertEqual(len(rows), 1)
            self.assertEqual(rows[0]["id"], result["cycle_id"])
            self.assertEqual(rows[0]["notable_pane_pattern"], "trust_prompt")
            self.assertEqual(rows[0]["status"]["kind"], "session_cycle")
            self.assertTrue(rows[0]["status"]["pane_signal"]["captured"])
            # The duplicated top-level key must match the nested one.
            self.assertEqual(
                rows[0]["status"]["notable_pane_pattern"],
                rows[0]["status"]["pane_signal"]["notable_pattern"],
            )

    def test_run_cycle_propagates_skipped_lines_in_ingest_field(self):
        from workerctl import supervise_cycle

        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)
            # Build a rollout with one malformed line.
            rollout = Path(tmpdir) / "rollout.jsonl"
            rollout.write_text(
                json.dumps({"type": "session_meta", "payload": {"id": "u-w", "cwd": "/r"}}) + "\n"
                + "garbage\n"
                + json.dumps({"timestamp": "2026-05-11T14:32:11Z",
                              "type": "event_msg",
                              "payload": {"type": "task_complete"}}) + "\n"
            )
            now = "2026-05-11T00:00:00Z"
            conn.execute(
                "insert into tasks(id, name, goal, state, created_at, updated_at) "
                "values ('task-1', 't', 'g', 'candidate', ?, ?)",
                (now, now),
            )
            worker_db.register_session(
                conn, name="w", role="worker",
                codex_session_path=str(rollout),
                codex_session_id="u-w", pid=1, cwd="/r",
            )
            worker_db.register_session(
                conn, name="m", role="manager",
                codex_session_path=str(rollout),
                codex_session_id="u-m", pid=2, cwd="/r",
            )
            worker_db.bind_sessions(
                conn, task_name="t",
                worker_session_name="w", manager_session_name="m",
            )
            conn.commit()
            result = supervise_cycle.run_cycle(
                conn, task_name="t", now="2026-05-11T14:33:00Z",
            )
            self.assertEqual(result["ingest"]["new_events"], 2)
            self.assertEqual(result["ingest"]["skipped_lines"], 1)

    def test_run_cycle_logs_audit_write_failure_to_stderr(self):
        """When the failed-cycle audit insert ALSO fails, the secondary failure
        must land on stderr rather than being silently swallowed."""
        import io
        import contextlib
        from workerctl import supervise_cycle
        from workerctl.ingest import IngestError

        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)
            now = "2026-05-12T00:00:00Z"
            conn.execute(
                "insert into tasks(id, name, goal, state, created_at, updated_at) "
                "values ('task-1', 't', 'g', 'managed', ?, ?)",
                (now, now),
            )
            worker_db.register_session(
                conn, name="w", role="worker",
                # Bad rollout path → ingest_session raises IngestError.
                codex_session_path=str(Path(tmpdir) / "does-not-exist.jsonl"),
                codex_session_id="u-w", pid=1, cwd="/r",
            )
            worker_db.register_session(
                conn, name="m", role="manager",
                codex_session_path="/m",
                codex_session_id="u-m", pid=2, cwd="/r",
            )
            worker_db.bind_sessions(
                conn, task_name="t",
                worker_session_name="w", manager_session_name="m",
            )
            conn.commit()

            # Wrap conn so that execute() fails on the failure-row insert.
            original_execute = conn.execute

            class WrappedConn:
                def __init__(self, conn):
                    self._conn = conn
                def __getattr__(self, name):
                    return getattr(self._conn, name)
                def execute(self, sql, params=()):
                    # Only the failure-row insert mentions 'failed' as a constant in the SQL.
                    if "'failed'" in sql or "failed" in str(params):
                        raise sqlite3.OperationalError("disk full")
                    return original_execute(sql, params)
                def commit(self):
                    return original_execute("commit")

            wrapped_conn = WrappedConn(conn)
            stderr_buf = io.StringIO()
            try:
                with self.assertRaises(IngestError):
                    with contextlib.redirect_stderr(stderr_buf):
                        supervise_cycle.run_cycle(wrapped_conn, task_name="t")
            finally:
                pass

            stderr_text = stderr_buf.getvalue()
            self.assertIn("disk full", stderr_text)
            self.assertIn("audit", stderr_text.lower())

    @staticmethod
    def _find_unused_pid() -> int:
        candidate = 999983
        while candidate > 1:
            try:
                os.kill(candidate, 0)
            except ProcessLookupError:
                return candidate
            except PermissionError:
                candidate -= 1
                continue
            candidate -= 1
        raise RuntimeError("no free pid found")

    def _make_codex_session(self, tmpdir, session_id):
        rollout = Path(tmpdir) / f"rollout-{session_id}.jsonl"
        rollout.write_text(json.dumps({"type": "session_meta", "payload": {"id": session_id, "cwd": tmpdir}}) + "\n")
        return rollout

    def test_cycle_includes_worker_and_manager_alive_true_for_live_pids(self):
        from workerctl import supervise_cycle
        # Use the current Python interpreter's own PID — guaranteed alive.
        live_pid = os.getpid()
        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)
            worker_db.register_session(
                conn, name="w-live", role="worker",
                codex_session_path=str(self._make_codex_session(tmpdir, "u-w")),
                codex_session_id="u-w", pid=live_pid, cwd=tmpdir,
            )
            worker_db.register_session(
                conn, name="m-live", role="manager",
                codex_session_path=str(self._make_codex_session(tmpdir, "u-m")),
                codex_session_id="u-m", pid=live_pid, cwd=tmpdir,
            )
            worker_db.create_task(
                conn, name="t1", goal="test goal",
            )
            worker_db.bind_sessions(
                conn,
                task_name="t1",
                worker_session_name="w-live",
                manager_session_name="m-live",
            )
            conn.commit()

            result = supervise_cycle.run_cycle(
                conn, task_name="t1", now="2026-05-11T14:32:15Z",
            )
            self.assertTrue(result["worker_alive"])
            self.assertTrue(result["manager_alive"])

    def test_cycle_includes_worker_alive_false_for_dead_pid(self):
        from workerctl import supervise_cycle
        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)
            # Pid 1 is init/launchd — always alive. Use a (likely) free pid.
            dead_pid = self._find_unused_pid()
            worker_db.register_session(
                conn, name="w-dead", role="worker",
                codex_session_path=str(self._make_codex_session(tmpdir, "u-w")),
                codex_session_id="u-w", pid=dead_pid, cwd=tmpdir,
            )
            worker_db.register_session(
                conn, name="m-live", role="manager",
                codex_session_path=str(self._make_codex_session(tmpdir, "u-m")),
                codex_session_id="u-m", pid=os.getpid(), cwd=tmpdir,
            )
            worker_db.create_task(
                conn, name="t1", goal="test goal",
            )
            worker_db.bind_sessions(
                conn,
                task_name="t1",
                worker_session_name="w-dead",
                manager_session_name="m-live",
            )
            conn.commit()

            result = supervise_cycle.run_cycle(
                conn, task_name="t1", now="2026-05-11T14:32:15Z",
            )
            self.assertFalse(result["worker_alive"])
            self.assertTrue(result["manager_alive"])

    def test_cycle_alive_false_when_pid_is_null(self):
        from workerctl import supervise_cycle
        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)
            now = "2026-05-13T00:00:00Z"
            # Worker registered legacy-style with NULL pid.
            rollout_path = self._make_codex_session(tmpdir, "u-w")
            conn.execute(
                """
                insert into sessions(id, name, role, identity_token, cwd,
                                     registered_at, state, pid, codex_session_path,
                                     codex_session_id)
                values ('s-w-null', 'w-null', 'worker', 'tok-w', ?,
                        ?, 'active', NULL, ?, ?)
                """,
                (tmpdir, now, str(rollout_path), "u-w"),
            )
            worker_db.register_session(
                conn, name="m-live", role="manager",
                codex_session_path=str(self._make_codex_session(tmpdir, "u-m")),
                codex_session_id="u-m", pid=os.getpid(), cwd=tmpdir,
            )
            worker_db.create_task(
                conn, name="t1", goal="test goal",
            )
            worker_db.bind_sessions(
                conn,
                task_name="t1",
                worker_session_name="w-null",
                manager_session_name="m-live",
            )
            conn.commit()

            result = supervise_cycle.run_cycle(
                conn, task_name="t1", now="2026-05-11T14:32:15Z",
            )
            self.assertFalse(result["worker_alive"])
            self.assertTrue(result["manager_alive"])

    def test_cycle_busy_wait_seconds_default_is_propagated(self):
        """Test: when no busy-wait-seconds is passed, default (from classifier) is used."""
        from workerctl import supervise_cycle
        from workerctl import shadow_state

        captured = {}

        def fake_pane_signal(conn, *, session_id, busy_wait_seconds=None, now=None, recent_event_count=0, **kwargs):
            if busy_wait_seconds is None:
                busy_wait_seconds = shadow_state.DEFAULT_BUSY_WAIT_SECONDS
            captured["busy_wait_seconds"] = busy_wait_seconds
            return {
                "captured": False,
                "classifier": None,
                "notable_pattern": None,
                "status_age_seconds": None,
                "reason": "test",
                "degraded": False,
            }

        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)
            self._setup_bound_task(conn, tmpdir, [
                {"type": "session_meta", "payload": {"id": "u-w", "cwd": "/r"}},
                {"timestamp": "2026-05-11T14:32:11Z",
                 "type": "event_msg",
                 "payload": {"type": "task_complete"}},
            ])
            # Patch pane_signal_for_session to capture busy_wait_seconds
            original = shadow_state.pane_signal_for_session
            shadow_state.pane_signal_for_session = fake_pane_signal
            try:
                supervise_cycle.run_cycle(
                    conn, task_name="t", now="2026-05-11T14:33:00Z",
                )
            finally:
                shadow_state.pane_signal_for_session = original

        self.assertEqual(captured["busy_wait_seconds"], shadow_state.DEFAULT_BUSY_WAIT_SECONDS)

    def test_cycle_busy_wait_seconds_override(self):
        """Test: busy_wait_seconds parameter overrides the default."""
        from workerctl import supervise_cycle
        from workerctl import shadow_state

        captured = {}

        def fake_pane_signal(conn, *, session_id, busy_wait_seconds=None, now=None, recent_event_count=0, **kwargs):
            if busy_wait_seconds is None:
                busy_wait_seconds = shadow_state.DEFAULT_BUSY_WAIT_SECONDS
            captured["busy_wait_seconds"] = busy_wait_seconds
            return {
                "captured": False,
                "classifier": None,
                "notable_pattern": None,
                "status_age_seconds": None,
                "reason": "test",
                "degraded": False,
            }

        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)
            self._setup_bound_task(conn, tmpdir, [
                {"type": "session_meta", "payload": {"id": "u-w", "cwd": "/r"}},
                {"timestamp": "2026-05-11T14:32:11Z",
                 "type": "event_msg",
                 "payload": {"type": "task_complete"}},
            ])
            # Patch pane_signal_for_session to capture busy_wait_seconds
            original = shadow_state.pane_signal_for_session
            shadow_state.pane_signal_for_session = fake_pane_signal
            try:
                supervise_cycle.run_cycle(
                    conn, task_name="t", busy_wait_seconds=37, now="2026-05-11T14:33:00Z",
                )
            finally:
                shadow_state.pane_signal_for_session = original

        self.assertEqual(captured["busy_wait_seconds"], 37)

    def test_cycle_includes_task_completed_true_after_task_complete_event(self):
        """Test: task_completed and last_event_subtype are set when task_complete event exists."""
        from workerctl import supervise_cycle

        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)
            self._setup_bound_task(conn, tmpdir, [
                {"type": "session_meta", "payload": {"id": "u-w", "cwd": "/r"}},
                {"timestamp": "2026-05-11T14:32:11Z",
                 "type": "event_msg",
                 "payload": {"type": "task_started", "turn_id": "t1"}},
                {"timestamp": "2026-05-11T14:32:30Z",
                 "type": "event_msg",
                 "payload": {"type": "task_complete"}},
            ])
            result = supervise_cycle.run_cycle(
                conn, task_name="t", now="2026-05-11T14:33:00Z",
            )
            self.assertEqual(result["last_event_subtype"], "task_complete")
            self.assertTrue(result["task_completed"])

    def test_cycle_includes_task_completed_false_when_no_complete_event(self):
        """Test: task_completed is false when latest event is not task_complete."""
        from workerctl import supervise_cycle

        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)
            self._setup_bound_task(conn, tmpdir, [
                {"type": "session_meta", "payload": {"id": "u-w", "cwd": "/r"}},
                {"timestamp": "2026-05-11T14:32:11Z",
                 "type": "event_msg",
                 "payload": {"type": "task_started", "turn_id": "t1"}},
            ])
            result = supervise_cycle.run_cycle(
                conn, task_name="t", now="2026-05-11T14:33:00Z",
            )
            self.assertEqual(result["last_event_subtype"], "task_started")
            self.assertFalse(result["task_completed"])

    def test_cycle_task_completed_false_when_latest_event_is_not_task_complete(self):
        """Test: task_completed is false when latest event is not task_complete."""
        from workerctl import supervise_cycle

        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)
            self._setup_bound_task(conn, tmpdir, [
                {"type": "session_meta", "payload": {"id": "u-w", "cwd": "/r"}},
                {"timestamp": "2026-05-11T14:32:11Z",
                 "type": "event_msg",
                 "payload": {"type": "task_started", "turn_id": "t1"}},
                {"timestamp": "2026-05-11T14:32:15Z",
                 "type": "event_msg",
                 "payload": {"type": "token_count", "count": 100}},
            ])
            result = supervise_cycle.run_cycle(
                conn, task_name="t", now="2026-05-11T14:33:00Z",
            )
            self.assertEqual(result["last_event_subtype"], "token_count")
            self.assertFalse(result["task_completed"])


class SuperviseCycleCriteriaTests(unittest.TestCase):
    def open_db(self, tmpdir):
        path = Path(tmpdir) / "workerctl.db"
        conn = worker_db.connect(path)
        worker_db.initialize_database(conn)
        self.addCleanup(conn.close)
        return conn

    def _setup_bound_task(self, conn, tmpdir):
        rollout = Path(tmpdir) / "rollout.jsonl"
        rollout.write_text(
            json.dumps({"type": "session_meta", "payload": {"id": "u-w", "cwd": "/r"}}) + "\n"
        )
        now = "2026-05-15T00:00:00Z"
        conn.execute(
            "insert into tasks(id, name, goal, state, created_at, updated_at) "
            "values ('task-criteria-cycle', 'criteria-cycle', 'g', 'candidate', ?, ?)",
            (now, now),
        )
        worker_db.register_session(
            conn, name="criteria-worker", role="worker",
            codex_session_path=str(rollout),
            codex_session_id="u-w", pid=1, cwd="/r",
        )
        worker_db.register_session(
            conn, name="criteria-manager", role="manager",
            codex_session_path=str(rollout),
            codex_session_id="u-m", pid=2, cwd="/r",
        )
        worker_db.bind_sessions(
            conn,
            task_name="criteria-cycle",
            worker_session_name="criteria-worker",
            manager_session_name="criteria-manager",
        )
        conn.commit()

    def test_run_cycle_groups_acceptance_criteria_in_manager_context(self):
        from workerctl import supervise_cycle

        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)
            self._setup_bound_task(conn, tmpdir)
            for status in ["proposed", "accepted", "satisfied", "deferred", "rejected"]:
                worker_db.insert_acceptance_criterion(
                    conn,
                    task_id="task-criteria-cycle",
                    criterion=f"{status} criterion",
                    status=status,
                    source="manager_inferred",
                    proof=f"{status} proof",
                    rationale=f"{status} rationale",
                    evidence={"status": status},
                )
            conn.commit()

            expected = {
                status: worker_db.acceptance_criteria_for_task(
                    conn,
                    task_id="task-criteria-cycle",
                    statuses=[status],
                )
                for status in ["proposed", "accepted", "satisfied", "deferred", "rejected"]
            }

            result = supervise_cycle.run_cycle(
                conn,
                task_name="criteria-cycle",
                now="2026-05-15T14:32:15Z",
            )

            criteria_context = result["manager_context"]["acceptance_criteria"]
            self.assertEqual(
                criteria_context["summary"],
                {
                    "proposed": 1,
                    "accepted": 1,
                    "satisfied": 1,
                    "deferred": 1,
                    "rejected": 1,
                },
            )
            self.assertEqual(criteria_context["open"], expected["accepted"])
            for status in ["proposed", "satisfied", "deferred", "rejected"]:
                self.assertEqual(criteria_context[status], expected[status])

            row = conn.execute(
                "select status_json from manager_cycles where id = ?",
                (result["cycle_id"],),
            ).fetchone()
            persisted = json.loads(row["status_json"])
            self.assertEqual(
                persisted["manager_context"]["acceptance_criteria"],
                criteria_context,
            )

    def test_run_cycle_recommends_criteria_negotiation_when_no_criteria_exist(self):
        from workerctl import supervise_cycle

        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)
            self._setup_bound_task(conn, tmpdir)

            result = supervise_cycle.run_cycle(
                conn,
                task_name="criteria-cycle",
                now="2026-05-15T14:32:15Z",
            )

            negotiation = result["manager_context"]["criteria_negotiation"]
            self.assertTrue(negotiation["needed"])
            self.assertEqual(negotiation["reason"], "no_criteria")
            self.assertIn("must-have current-task criteria", negotiation["prompt"])
            self.assertIn("follow-up criteria", negotiation["prompt"])
            self.assertTrue(
                any("workerctl criteria criteria-cycle --add" in action for action in negotiation["suggested_actions"])
            )

            row = conn.execute(
                "select status_json from manager_cycles where id = ?",
                (result["cycle_id"],),
            ).fetchone()
            persisted = json.loads(row["status_json"])
            self.assertEqual(
                persisted["manager_context"]["criteria_negotiation"],
                negotiation,
            )

    def test_run_cycle_recommends_criteria_negotiation_when_only_non_current_criteria_exist(self):
        from workerctl import supervise_cycle

        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)
            self._setup_bound_task(conn, tmpdir)
            for status in ["deferred", "rejected"]:
                worker_db.insert_acceptance_criterion(
                    conn,
                    task_id="task-criteria-cycle",
                    criterion=f"{status} criterion",
                    status=status,
                    source="manager_inferred",
                )
            conn.commit()

            result = supervise_cycle.run_cycle(
                conn,
                task_name="criteria-cycle",
                now="2026-05-15T14:32:15Z",
            )

            negotiation = result["manager_context"]["criteria_negotiation"]
            self.assertTrue(negotiation["needed"])
            self.assertEqual(negotiation["reason"], "no_current_task_criteria")

    def test_criteria_negotiation_quotes_task_names_in_suggested_commands(self):
        from workerctl import supervise_cycle

        negotiation = supervise_cycle._criteria_negotiation_context(
            task_name="criteria cycle; echo bad",
            criteria_context={
                "summary": {
                    "proposed": 0,
                    "accepted": 0,
                    "satisfied": 0,
                    "deferred": 0,
                    "rejected": 0,
                },
            },
        )

        joined_actions = " ".join(negotiation["suggested_actions"])
        self.assertIn("workerctl criteria 'criteria cycle; echo bad' --add", joined_actions)
        self.assertNotIn("workerctl criteria criteria cycle; echo bad --add", joined_actions)

    def test_run_cycle_does_not_recommend_criteria_negotiation_when_active_criteria_exist(self):
        from workerctl import supervise_cycle

        for active_status in ["proposed", "accepted", "satisfied"]:
            with self.subTest(active_status=active_status):
                with tempfile.TemporaryDirectory() as tmpdir:
                    conn = self.open_db(tmpdir)
                    self._setup_bound_task(conn, tmpdir)
                    worker_db.insert_acceptance_criterion(
                        conn,
                        task_id="task-criteria-cycle",
                        criterion=f"{active_status} criterion",
                        status=active_status,
                        source="manager_inferred",
                    )
                    conn.commit()

                    result = supervise_cycle.run_cycle(
                        conn,
                        task_name="criteria-cycle",
                        now="2026-05-15T14:32:15Z",
                    )

                    negotiation = result["manager_context"]["criteria_negotiation"]
                    self.assertFalse(negotiation["needed"])
                    self.assertEqual(negotiation["reason"], "active_criteria_present")
                    self.assertIsNone(negotiation["prompt"])


class ReadEventsStatsTests(unittest.TestCase):
    def test_read_events_with_stats_counts_malformed_lines(self):
        from workerctl import state

        with tempfile.TemporaryDirectory() as tmpdir:
            os.environ["WORKERCTL_STATE_ROOT"] = tmpdir
            self.addCleanup(os.environ.pop, "WORKERCTL_STATE_ROOT", None)
            name = "w-stats"
            state.worker_dir(name).mkdir(parents=True, exist_ok=True)
            events_path = state.events_path(name)
            events_path.write_text(
                '{"type":"x","ts":"2026-05-12T00:00:00Z"}\n'
                'not-json\n'
                '{"type":"y","ts":"2026-05-12T00:00:01Z"}\n'
            )
            events, skipped = state.read_events_with_stats(name)
            self.assertEqual(len(events), 2)
            self.assertEqual(skipped, 1)


class CycleCliTests(unittest.TestCase):
    def run_cli(self, *args, env_extra=None):
        env = os.environ.copy()
        if env_extra:
            env.update(env_extra)
        return subprocess.run(
            [sys.executable, "-m", "workerctl", *args],
            capture_output=True, text=True, env=env, cwd=str(ROOT),
        )

    def _setup_bound_task_via_cli(self, tmpdir, events):
        rollout = Path(tmpdir) / "rollout.jsonl"
        full_events = ([{"type": "session_meta",
                          "payload": {"id": "u", "cwd": str(ROOT), "originator": "codex-tui"}}]
                       + events)
        rollout.write_text("".join(json.dumps(e) + "\n" for e in full_events))
        state_dir = Path(tmpdir) / "state"
        state_dir.mkdir()
        env = {"WORKERCTL_STATE_ROOT": str(state_dir)}
        self.run_cli("register-worker", "--name", "w",
                     "--codex-session", str(rollout),
                     "--pid", "1", "--cwd", str(ROOT),
                     "--tmux-session", "codex-w",
                     env_extra=env)
        self.run_cli("register-manager", "--name", "m",
                     "--codex-session", str(rollout),
                     "--pid", "2", "--cwd", str(ROOT),
                     env_extra=env)
        self.run_cli("tasks", "--create", "myTask", "--goal", "g", env_extra=env)
        self.run_cli("bind", "--task", "myTask", "--worker", "w", "--manager", "m",
                     env_extra=env)
        return rollout, state_dir, env

    def test_cli_cycle_returns_structured_payload(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            _, state_dir, env = self._setup_bound_task_via_cli(tmpdir, events=[
                {"timestamp": "2026-05-11T14:32:11Z",
                 "type": "event_msg",
                 "payload": {"type": "task_started", "turn_id": "t1"}},
            ])
            proc = self.run_cli("cycle", "myTask", env_extra=env)
            self.assertEqual(proc.returncode, 0, proc.stderr)
            result = json.loads(proc.stdout)
            self.assertEqual(result["task"], "myTask")
            self.assertEqual(result["worker_session"], "w")
            self.assertEqual(result["manager_session"], "m")
            self.assertEqual(result["state"], "busy")
            self.assertEqual(result["ingest"]["new_events"], 2)
            self.assertIn("cycle_id", result)

    def test_cli_cycle_idempotent_on_unchanged_rollout(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            _, state_dir, env = self._setup_bound_task_via_cli(tmpdir, events=[
                {"timestamp": "2026-05-11T14:32:11Z",
                 "type": "event_msg",
                 "payload": {"type": "task_complete"}},
            ])
            self.run_cli("cycle", "myTask", env_extra=env)
            proc = self.run_cli("cycle", "myTask", env_extra=env)
            self.assertEqual(proc.returncode, 0, proc.stderr)
            result = json.loads(proc.stdout)
            self.assertEqual(result["ingest"]["new_events"], 0)
            self.assertEqual(result["state"], "idle")

    def test_cli_cycle_unknown_task_clean_error(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            state_dir = Path(tmpdir) / "state"
            state_dir.mkdir()
            proc = self.run_cli(
                "cycle", "no-such-task",
                env_extra={"WORKERCTL_STATE_ROOT": str(state_dir)},
            )
            self.assertEqual(proc.returncode, 1)
            self.assertNotIn("Traceback", proc.stderr)
            self.assertIn("workerctl:", proc.stderr)


class ShadowStateTests(unittest.TestCase):
    def open_db(self, tmpdir):
        path = Path(tmpdir) / "workerctl.db"
        conn = worker_db.connect(path)
        worker_db.initialize_database(conn)
        self.addCleanup(conn.close)
        return conn

    def _register_with_tmux(self, conn, **overrides):
        kwargs = {
            "name": "w", "role": "worker",
            "codex_session_path": "/a", "codex_session_id": "u", "pid": 1, "cwd": "/repo",
            "tmux_session": "codex-w", "tmux_pane_id": "%5",
        }
        kwargs.update(overrides)
        return worker_db.register_session(conn, **kwargs)

    def test_pane_signal_for_session_returns_no_tmux_when_unattached(self):
        from workerctl import shadow_state

        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)
            session_id = worker_db.register_session(
                conn, name="m", role="manager",
                codex_session_path="/a", codex_session_id="u", pid=1, cwd="/repo",
            )
            result = shadow_state.pane_signal_for_session(
                conn, session_id=session_id,
            )
            self.assertEqual(result["captured"], False)
            self.assertIsNone(result["classifier"])
            self.assertIsNone(result["notable_pattern"])
            self.assertEqual(result["reason"], "no tmux session attached")

    def test_pane_signal_for_session_captures_and_runs_classifier(self):
        from workerctl import shadow_state
        from workerctl import tmux as worker_tmux

        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)
            session_id = self._register_with_tmux(conn)

            # Stub the capture to return text matching the trust-prompt pattern.
            original = worker_tmux.capture_tmux_target
            worker_tmux.capture_tmux_target = (
                lambda target, lines=100:
                "$ codex\nDo you trust the contents of this directory? (y/n)\n"
            )
            try:
                result = shadow_state.pane_signal_for_session(
                    conn, session_id=session_id,
                )
            finally:
                worker_tmux.capture_tmux_target = original

            self.assertEqual(result["captured"], True)
            self.assertIsNotNone(result["classifier"])
            self.assertEqual(result["notable_pattern"], "trust_prompt")
            self.assertIn("trust", result["classifier"]["reason"].lower())

    def test_pane_signal_for_session_no_pattern_returns_classifier_none(self):
        from workerctl import shadow_state
        from workerctl import tmux as worker_tmux

        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)
            session_id = self._register_with_tmux(conn)

            original = worker_tmux.capture_tmux_target
            worker_tmux.capture_tmux_target = (
                lambda target, lines=100: "$ codex\nready and typing...\n"
            )
            try:
                result = shadow_state.pane_signal_for_session(
                    conn, session_id=session_id,
                )
            finally:
                worker_tmux.capture_tmux_target = original

            self.assertEqual(result["captured"], True)
            self.assertIsNone(result["classifier"])
            self.assertIsNone(result["notable_pattern"])

    def test_pane_signal_for_session_swallows_tmux_capture_error(self):
        from workerctl import shadow_state
        from workerctl import tmux as worker_tmux
        from workerctl.core import WorkerError as CoreWorkerError

        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)
            self._register_with_tmux(conn)
            session_id = worker_db.session_row(conn, name="w")["id"]

            original = worker_tmux.capture_tmux_target

            def boom(target, lines=100):
                # WorkerError is what capture_tmux_target actually raises via
                # run() in real life — the narrowed except in shadow_state must
                # still treat it as a benign capture failure.
                raise CoreWorkerError("tmux died")

            worker_tmux.capture_tmux_target = boom
            try:
                result = shadow_state.pane_signal_for_session(
                    conn, session_id=session_id,
                )
            finally:
                worker_tmux.capture_tmux_target = original

            # Best-effort: a capture failure should NOT raise; it should be reported
            # in the result so callers (run_cycle) can surface it without aborting.
            self.assertEqual(result["captured"], False)
            self.assertIsNone(result["classifier"])
            self.assertIsNone(result["notable_pattern"])
            self.assertTrue(result["degraded"])
            self.assertIn("tmux died", result["reason"])

    def test_pane_signal_for_session_uses_staleness_as_status_age(self):
        from workerctl import shadow_state
        from workerctl import tmux as worker_tmux

        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)
            session_id = self._register_with_tmux(conn)
            # Insert a state-bearing event 200 seconds before `now`.
            worker_db.insert_codex_event(
                conn, session_id=session_id,
                timestamp="2026-05-11T14:30:00Z",
                event_type="event_msg", subtype="task_started",
                payload={}, byte_offset=0,
            )

            original = worker_tmux.capture_tmux_target
            # Pane shows "esc to interrupt" — only fires the `long_running_interruptible`
            # pattern when status_age >= busy_wait_seconds. With staleness=200s and
            # threshold=90s, the pattern should fire.
            worker_tmux.capture_tmux_target = (
                lambda target, lines=100: "running tests... esc to interrupt\n"
            )
            try:
                result = shadow_state.pane_signal_for_session(
                    conn,
                    session_id=session_id,
                    busy_wait_seconds=90,
                    now="2026-05-11T14:33:20Z",  # 200s after the event
                )
            finally:
                worker_tmux.capture_tmux_target = original

            self.assertEqual(result["captured"], True)
            self.assertEqual(result["notable_pattern"], "long_running_interruptible")
            self.assertEqual(result["status_age_seconds"], 200)

    def test_pane_signal_for_session_degrades_on_ingest_error(self):
        """If session_staleness_seconds raises IngestError (e.g. malformed event
        timestamp), the pane signal stays best-effort: captured=True, classifier
        still runs without age, and the reason field flags the degradation."""
        from workerctl import shadow_state
        from workerctl import ingest as worker_ingest
        from workerctl import tmux as worker_tmux

        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)
            session_id = self._register_with_tmux(conn)
            # Insert a state-bearing event with a deliberately malformed timestamp.
            conn.execute(
                """
                insert into codex_events(
                  session_id, timestamp, type, subtype, payload_json, byte_offset, ingested_at
                )
                values (?, 'not-a-valid-iso', 'event_msg', 'task_started', '{}', 0, '2026-05-11T00:00:00Z')
                """,
                (session_id,),
            )
            conn.commit()

            original = worker_tmux.capture_tmux_target
            worker_tmux.capture_tmux_target = (
                lambda target, lines=100:
                "$ codex\nDo you trust the contents of this directory? (y/n)\n"
            )
            try:
                result = shadow_state.pane_signal_for_session(
                    conn, session_id=session_id,
                )
            finally:
                worker_tmux.capture_tmux_target = original

            self.assertEqual(result["captured"], True)
            # Classifier still ran against the captured text.
            self.assertEqual(result["notable_pattern"], "trust_prompt")
            # Status age unavailable because staleness raised IngestError.
            self.assertIsNone(result["status_age_seconds"])
            # Reason field carries a hint about the degradation.
            self.assertIn("staleness unavailable", result["reason"])

    def test_pane_signal_for_session_unknown_session_id(self):
        """Passing a non-existent session id returns a clean non-captured signal
        rather than raising. Documents the None-on-miss contract of session_by_id."""
        from workerctl import shadow_state

        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)
            result = shadow_state.pane_signal_for_session(
                conn, session_id="does-not-exist",
            )
            self.assertFalse(result["captured"])
            self.assertIsNone(result["classifier"])
            self.assertIsNone(result["notable_pattern"])
            self.assertIn("unknown session id", result["reason"])
            self.assertFalse(result["degraded"])

    def test_pane_signal_for_session_degraded_field_set_on_ingest_error(self):
        """The IngestError-degradation path must set degraded=True so operators
        can distinguish clean captures from those where classification ran with
        reduced inputs (e.g. status_age unavailable)."""
        from workerctl import shadow_state
        from workerctl import tmux as worker_tmux

        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)
            session_id = self._register_with_tmux(conn)
            # Insert a state-bearing event with a malformed timestamp.
            conn.execute(
                """
                insert into codex_events(
                  session_id, timestamp, type, subtype, payload_json, byte_offset, ingested_at
                )
                values (?, 'not-a-valid-iso', 'event_msg', 'task_started', '{}', 0, '2026-05-11T00:00:00Z')
                """,
                (session_id,),
            )
            conn.commit()

            original = worker_tmux.capture_tmux_target
            worker_tmux.capture_tmux_target = (
                lambda target, lines=100: "$ codex\nDo you trust the contents of this directory? (y/n)\n"
            )
            try:
                result = shadow_state.pane_signal_for_session(
                    conn, session_id=session_id,
                )
            finally:
                worker_tmux.capture_tmux_target = original

            self.assertTrue(result["captured"])
            self.assertTrue(result["degraded"])  # the new field
            self.assertEqual(result["notable_pattern"], "trust_prompt")
            self.assertIn("staleness unavailable", result["reason"])

    def test_pane_signal_for_session_degraded_false_on_normal_paths(self):
        """`degraded` defaults to False on expected non-pane and clean-capture paths."""
        from workerctl import shadow_state
        from workerctl import tmux as worker_tmux

        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)
            # No-tmux session.
            session_id = worker_db.register_session(
                conn, name="m", role="manager",
                codex_session_path="/a", codex_session_id="u", pid=1, cwd="/repo",
            )
            result = shadow_state.pane_signal_for_session(conn, session_id=session_id)
            self.assertFalse(result["degraded"])

            # Successful capture.
            session_id_w = self._register_with_tmux(conn, name="w2", codex_session_id="u-w2")
            original = worker_tmux.capture_tmux_target
            worker_tmux.capture_tmux_target = lambda t, lines=100: "$ codex\nready\n"
            try:
                result = shadow_state.pane_signal_for_session(conn, session_id=session_id_w)
            finally:
                worker_tmux.capture_tmux_target = original
            self.assertFalse(result["degraded"])

    def test_pane_signal_for_session_forwards_recent_event_count(self):
        from workerctl import shadow_state
        from workerctl import tmux as worker_tmux

        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)
            session_id = self._register_with_tmux(conn)

            # Insert a state-bearing event 300 seconds before `now` to trigger
            # the long_running_interruptible condition on stale status.
            worker_db.insert_codex_event(
                conn, session_id=session_id,
                timestamp="2026-05-11T14:30:00Z",
                event_type="event_msg", subtype="task_started",
                payload={}, byte_offset=0,
            )

            original = worker_tmux.capture_tmux_target
            worker_tmux.capture_tmux_target = (
                lambda target, lines=100: "running tests... esc to interrupt\n"
            )
            try:
                # With high recent_event_count, long_running_interruptible should be suppressed.
                result = shadow_state.pane_signal_for_session(
                    conn,
                    session_id=session_id,
                    busy_wait_seconds=60,
                    now="2026-05-11T14:35:00Z",  # 300s after the event
                    recent_event_count=133,
                )
            finally:
                worker_tmux.capture_tmux_target = original

            # With recent_event_count=133, the pattern should be suppressed (None).
            self.assertEqual(result["captured"], True)
            self.assertIsNone(result["notable_pattern"])


class DivergencesTests(unittest.TestCase):
    def open_db(self, tmpdir):
        path = Path(tmpdir) / "workerctl.db"
        conn = worker_db.connect(path)
        worker_db.initialize_database(conn)
        self.addCleanup(conn.close)
        return conn

    def _insert_task(self, conn, task_id="task-1", task_name="t"):
        now = "2026-05-11T00:00:00Z"
        conn.execute(
            "insert into tasks(id, name, goal, state, created_at, updated_at) "
            "values (?, ?, 'g', 'candidate', ?, ?)",
            (task_id, task_name, now, now),
        )
        return task_id

    def _insert_cycle(self, conn, *, task_id, status_payload, state="succeeded", error=None):
        now = "2026-05-11T00:00:00Z"
        cursor = conn.execute(
            """
            insert into manager_cycles(
              task_id, started_at, completed_at, state, status_json, error
            )
            values (?, ?, ?, ?, ?, ?)
            """,
            (task_id, now, now, state,
             json.dumps(status_payload, sort_keys=True, default=str), error),
        )
        return int(cursor.lastrowid)

    def test_divergent_cycles_for_task_returns_only_cycles_with_pane_pattern(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)
            task_id = self._insert_task(conn)
            # Cycle 1: no pane pattern → should NOT appear.
            self._insert_cycle(conn, task_id=task_id, status_payload={
                "kind": "session_cycle",
                "task": "t",
                "state": "busy",
                "notable_pane_pattern": None,
            })
            # Cycle 2: pane pattern present → SHOULD appear.
            cycle_id_2 = self._insert_cycle(conn, task_id=task_id, status_payload={
                "kind": "session_cycle",
                "task": "t",
                "state": "busy",
                "notable_pane_pattern": "trust_prompt",
            })
            # Cycle 3: failed cycle (no pane pattern field at all) → should NOT appear.
            self._insert_cycle(
                conn, task_id=task_id,
                status_payload={"kind": "session_cycle", "task": "t"},
                state="failed", error="boom",
            )
            conn.commit()

            rows = worker_db.divergent_cycles_for_task(conn, task_name="t")
            self.assertEqual(len(rows), 1)
            self.assertEqual(rows[0]["id"], cycle_id_2)
            self.assertEqual(rows[0]["notable_pane_pattern"], "trust_prompt")

    def test_divergent_cycles_for_task_orders_newest_first(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)
            task_id = self._insert_task(conn)
            ids = []
            for pattern in ["enter_to_confirm", "trust_prompt", "rate_limit_prompt"]:
                ids.append(self._insert_cycle(conn, task_id=task_id, status_payload={
                    "kind": "session_cycle",
                    "task": "t",
                    "notable_pane_pattern": pattern,
                }))
            conn.commit()

            rows = worker_db.divergent_cycles_for_task(conn, task_name="t")
            row_ids = [r["id"] for r in rows]
            self.assertEqual(row_ids, list(reversed(ids)))

    def test_divergent_cycles_for_task_raises_on_unknown_task(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)
            with self.assertRaises(WorkerError):
                worker_db.divergent_cycles_for_task(conn, task_name="missing")

    def test_divergent_cycles_for_task_respects_limit(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)
            task_id = self._insert_task(conn)
            for i in range(5):
                self._insert_cycle(conn, task_id=task_id, status_payload={
                    "kind": "session_cycle",
                    "task": "t",
                    "notable_pane_pattern": "trust_prompt",
                })
            conn.commit()
            rows = worker_db.divergent_cycles_for_task(conn, task_name="t", limit=2)
            self.assertEqual(len(rows), 2)

    def test_divergent_cycles_for_task_excludes_failed_with_pane_pattern(self):
        """Even if a future code path writes notable_pane_pattern on a failure
        payload, the `state = 'succeeded'` SQL filter must exclude it. This
        documents and locks in the belt-and-suspenders guardrail."""
        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)
            task_id = self._insert_task(conn)
            # Insert a failed row that DOES carry notable_pane_pattern.
            self._insert_cycle(
                conn, task_id=task_id,
                status_payload={
                    "kind": "session_cycle",
                    "task": "t",
                    "notable_pane_pattern": "trust_prompt",
                },
                state="failed", error="boom",
            )
            conn.commit()
            rows = worker_db.divergent_cycles_for_task(conn, task_name="t")
            self.assertEqual(rows, [])


class DivergencesCliTests(unittest.TestCase):
    def run_cli(self, *args, env_extra=None):
        env = os.environ.copy()
        if env_extra:
            env.update(env_extra)
        return subprocess.run(
            [sys.executable, "-m", "workerctl", *args],
            capture_output=True, text=True, env=env, cwd=str(ROOT),
        )

    def test_cli_divergences_returns_cycles_with_pane_patterns(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            state_dir = Path(tmpdir) / "state"
            state_dir.mkdir()
            env = {"WORKERCTL_STATE_ROOT": str(state_dir)}
            db_path = state_dir / "workerctl.db"

            # Build the DB by running workerctl through the CLI so initialize_database
            # runs and we use real DB plumbing.
            self.run_cli("sessions", env_extra=env)  # touches initialize_database

            # Inject a task and two cycles directly: one with a pane pattern, one without.
            conn = worker_db.connect(db_path)
            self.addCleanup(conn.close)
            now = "2026-05-11T00:00:00Z"
            conn.execute(
                "insert into tasks(id, name, goal, state, created_at, updated_at) "
                "values ('task-1', 'mytask', 'g', 'candidate', ?, ?)",
                (now, now),
            )
            for pattern in [None, "trust_prompt"]:
                conn.execute(
                    """
                    insert into manager_cycles(
                      task_id, started_at, completed_at, state, status_json
                    )
                    values ('task-1', ?, ?, 'succeeded', ?)
                    """,
                    (now, now, json.dumps({
                        "kind": "session_cycle",
                        "task": "mytask",
                        "notable_pane_pattern": pattern,
                    }, sort_keys=True)),
                )
            conn.commit()

            proc = self.run_cli("divergences", "mytask", env_extra=env)
            self.assertEqual(proc.returncode, 0, proc.stderr)
            rows = json.loads(proc.stdout)
            self.assertEqual(len(rows), 1)
            self.assertEqual(rows[0]["notable_pane_pattern"], "trust_prompt")

    def test_cli_divergences_unknown_task_clean_error(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            state_dir = Path(tmpdir) / "state"
            state_dir.mkdir()
            proc = self.run_cli(
                "divergences", "no-such-task",
                env_extra={"WORKERCTL_STATE_ROOT": str(state_dir)},
            )
            self.assertEqual(proc.returncode, 1)
            self.assertNotIn("Traceback", proc.stderr)
            self.assertIn("workerctl:", proc.stderr)

    def test_cli_divergences_empty_when_no_pane_patterns(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            state_dir = Path(tmpdir) / "state"
            state_dir.mkdir()
            env = {"WORKERCTL_STATE_ROOT": str(state_dir)}
            self.run_cli("sessions", env_extra=env)
            db_path = state_dir / "workerctl.db"
            conn = worker_db.connect(db_path)
            self.addCleanup(conn.close)
            now = "2026-05-11T00:00:00Z"
            conn.execute(
                "insert into tasks(id, name, goal, state, created_at, updated_at) "
                "values ('task-1', 'mytask', 'g', 'candidate', ?, ?)",
                (now, now),
            )
            conn.execute(
                """
                insert into manager_cycles(
                  task_id, started_at, completed_at, state, status_json
                )
                values ('task-1', ?, ?, 'succeeded', ?)
                """,
                (now, now, json.dumps({
                    "kind": "session_cycle",
                    "task": "mytask",
                    "notable_pane_pattern": None,
                }, sort_keys=True)),
            )
            conn.commit()

            proc = self.run_cli("divergences", "mytask", env_extra=env)
            self.assertEqual(proc.returncode, 0, proc.stderr)
            self.assertEqual(json.loads(proc.stdout), [])


class ReconcileTests(unittest.TestCase):
    def open_db(self, tmpdir):
        path = Path(tmpdir) / "workerctl.db"
        conn = worker_db.connect(path)
        worker_db.initialize_database(conn)
        self.addCleanup(conn.close)
        return conn

    def test_reconcile_reports_dead_pid_session(self):
        from workerctl import commands as worker_commands

        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)
            worker_db.register_session(
                conn, name="dead", role="worker",
                codex_session_path="/a", codex_session_id="u",
                pid=2147483646, cwd="/repo",
                tmux_session="codex-dead",
            )
            conn.commit()

            report = worker_commands.collect_reconcile_report(conn)
            dead_pid_sessions = [
                s for s in report["dead_pid_sessions"]
                if s["name"] == "dead"
            ]
            self.assertEqual(len(dead_pid_sessions), 1)
            self.assertEqual(dead_pid_sessions[0]["pid"], 2147483646)

    def test_reconcile_reports_dangling_binding(self):
        from workerctl import commands as worker_commands

        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)
            now = "2026-05-12T00:00:00Z"
            conn.execute(
                "insert into tasks(id, name, goal, state, created_at, updated_at) "
                "values ('task-1', 't', 'g', 'managed', ?, ?)",
                (now, now),
            )
            worker_db.register_session(
                conn, name="w", role="worker",
                codex_session_path="/a", codex_session_id="u-w", pid=1, cwd="/r",
            )
            worker_db.register_session(
                conn, name="m", role="manager",
                codex_session_path="/b", codex_session_id="u-m", pid=2, cwd="/r",
            )
            worker_db.bind_sessions(
                conn, task_name="t", worker_session_name="w", manager_session_name="m",
            )
            # Mark the worker session gone manually - the binding now dangles.
            conn.execute("update sessions set state='gone' where name='w'")
            conn.commit()

            report = worker_commands.collect_reconcile_report(conn)
            dangling = [b for b in report["dangling_bindings"] if b["task_name"] == "t"]
            self.assertEqual(len(dangling), 1)
            self.assertEqual(dangling[0]["gone_role"], "worker")

    def test_reconcile_apply_marks_gone_pid_session_gone(self):
        from workerctl import commands as worker_commands

        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)
            worker_db.register_session(
                conn, name="dead", role="worker",
                codex_session_path="/a", codex_session_id="u",
                pid=2147483646, cwd="/repo",
            )
            conn.commit()

            worker_commands.apply_reconcile(conn)

            row = conn.execute("select state from sessions where name='dead'").fetchone()
            self.assertEqual(row["state"], "gone")

    def test_reconcile_apply_marks_dangling_binding_invalid(self):
        from workerctl import commands as worker_commands

        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)
            now = "2026-05-12T00:00:00Z"
            conn.execute(
                "insert into tasks(id, name, goal, state, created_at, updated_at) "
                "values ('task-1', 't', 'g', 'managed', ?, ?)",
                (now, now),
            )
            worker_db.register_session(
                conn, name="w", role="worker",
                codex_session_path="/a", codex_session_id="u-w", pid=1, cwd="/r",
            )
            worker_db.register_session(
                conn, name="m", role="manager",
                codex_session_path="/b", codex_session_id="u-m", pid=2, cwd="/r",
            )
            binding_id = worker_db.bind_sessions(
                conn, task_name="t", worker_session_name="w", manager_session_name="m",
            )
            conn.execute("update sessions set state='gone' where name='w'")
            conn.commit()

            worker_commands.apply_reconcile(conn)

            row = conn.execute(
                "select state from bindings where id = ?", (binding_id,)
            ).fetchone()
            self.assertEqual(row["state"], "invalid")

    def test_reconcile_cli_dry_run_does_not_mutate(self):
        """End-to-end CLI smoke test: dry-run prints JSON and leaves state alone."""
        env = os.environ.copy()
        with tempfile.TemporaryDirectory() as tmpdir:
            state_dir = Path(tmpdir) / "state"
            state_dir.mkdir()
            env["WORKERCTL_STATE_ROOT"] = str(state_dir)

            # Build a fixture rollout so register-worker accepts the dead-pid session.
            rollout = Path(tmpdir) / "rollout.jsonl"
            rollout.write_text(
                json.dumps({
                    "type": "session_meta",
                    "payload": {"id": "u", "cwd": str(ROOT), "originator": "codex-tui"},
                }) + "\n"
            )
            subprocess.run(
                [sys.executable, "-m", "workerctl", "register-worker",
                 "--name", "dead", "--pid", "2147483646",
                 "--codex-session", str(rollout),
                 "--cwd", str(ROOT)],
                env=env, capture_output=True, text=True, cwd=str(ROOT),
            )

            proc = subprocess.run(
                [sys.executable, "-m", "workerctl", "reconcile"],
                env=env, capture_output=True, text=True, cwd=str(ROOT),
            )
            self.assertEqual(proc.returncode, 0, proc.stderr)
            report = json.loads(proc.stdout)
            self.assertIn("dead_pid_sessions", report)
            self.assertTrue(any(s["name"] == "dead" for s in report["dead_pid_sessions"]))

            # Dry-run must NOT have mutated the session.
            db_path = state_dir / "workerctl.db"
            conn = worker_db.connect(db_path)
            self.addCleanup(conn.close)
            row = conn.execute("select state from sessions where name='dead'").fetchone()
            self.assertEqual(row["state"], "active")

    def test_apply_reconcile_event_appears_in_task_audit(self):
        from workerctl import commands as worker_commands

        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)
            now = "2026-05-12T00:00:00Z"
            conn.execute(
                "insert into tasks(id, name, goal, state, created_at, updated_at) "
                "values ('task-1', 'audit-task', 'g', 'managed', ?, ?)",
                (now, now),
            )
            worker_db.register_session(
                conn, name="w", role="worker",
                codex_session_path="/a", codex_session_id="u-w", pid=1, cwd="/r",
            )
            worker_db.register_session(
                conn, name="m", role="manager",
                codex_session_path="/b", codex_session_id="u-m", pid=2, cwd="/r",
            )
            worker_db.bind_sessions(
                conn, task_name="audit-task",
                worker_session_name="w", manager_session_name="m",
            )
            conn.execute("update sessions set state='gone' where name='w'")
            conn.commit()

            worker_commands.apply_reconcile(conn)

            audit = worker_db.task_audit(conn, task="audit-task")
            types = [e["type"] for e in audit["events"]]
            self.assertIn("binding_marked_invalid_by_reconcile", types)

    def test_reconcile_respects_stale_cycles_seconds_override(self):
        """Threshold should be configurable: a 100-second-old cycle is NOT stuck
        at the default (3600) but IS stuck at a 50-second threshold."""
        from workerctl import commands as worker_commands
        from datetime import datetime, timezone, timedelta

        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)
            now_dt = datetime.now(timezone.utc)
            old_ts = (now_dt - timedelta(seconds=100)).strftime("%Y-%m-%dT%H:%M:%SZ")
            recent_ts = now_dt.strftime("%Y-%m-%dT%H:%M:%SZ")

            # Set up a task with an active binding + manager_cycles row 100 seconds old.
            conn.execute(
                "insert into tasks(id, name, goal, state, created_at, updated_at) "
                "values ('task-1', 'aging-task', 'g', 'managed', ?, ?)",
                (recent_ts, recent_ts),
            )
            worker_db.register_session(
                conn, name="w", role="worker",
                codex_session_path="/a", codex_session_id="u-w", pid=1, cwd="/r",
            )
            worker_db.register_session(
                conn, name="m", role="manager",
                codex_session_path="/b", codex_session_id="u-m", pid=2, cwd="/r",
            )
            worker_db.bind_sessions(
                conn, task_name="aging-task",
                worker_session_name="w", manager_session_name="m",
            )
            conn.execute(
                """
                insert into manager_cycles(
                  task_id, started_at, completed_at, state, status_json
                )
                values ('task-1', ?, ?, 'succeeded', ?)
                """,
                (old_ts, old_ts, json.dumps({"kind": "session_cycle", "task": "aging-task"})),
            )
            conn.commit()

            # Default threshold (3600): NOT stuck.
            report = worker_commands.collect_reconcile_report(conn)
            stuck_names = [s["task_name"] for s in report["stuck_tasks"]]
            self.assertNotIn("aging-task", stuck_names)

            # 50s threshold: IS stuck.
            report = worker_commands.collect_reconcile_report(
                conn, stale_cycles_seconds=50,
            )
            stuck_names = [s["task_name"] for s in report["stuck_tasks"]]
            self.assertIn("aging-task", stuck_names)

    def test_cli_reconcile_threshold_flag(self):
        """The --stale-cycles-seconds CLI flag should be plumbed through."""
        env = os.environ.copy()
        with tempfile.TemporaryDirectory() as tmpdir:
            state_dir = Path(tmpdir) / "state"
            state_dir.mkdir()
            env["WORKERCTL_STATE_ROOT"] = str(state_dir)

            # Seed a task with old cycle (same setup as above, via direct DB).
            db_path = state_dir / "workerctl.db"
            conn = worker_db.connect(db_path)
            worker_db.initialize_database(conn)
            from datetime import datetime, timezone, timedelta
            now_dt = datetime.now(timezone.utc)
            old_ts = (now_dt - timedelta(seconds=100)).strftime("%Y-%m-%dT%H:%M:%SZ")
            recent_ts = now_dt.strftime("%Y-%m-%dT%H:%M:%SZ")
            conn.execute(
                "insert into tasks(id, name, goal, state, created_at, updated_at) "
                "values ('task-1', 'aging-task', 'g', 'managed', ?, ?)",
                (recent_ts, recent_ts),
            )
            worker_db.register_session(
                conn, name="w", role="worker",
                codex_session_path="/a", codex_session_id="u-w", pid=1, cwd="/r",
            )
            worker_db.register_session(
                conn, name="m", role="manager",
                codex_session_path="/b", codex_session_id="u-m", pid=2, cwd="/r",
            )
            worker_db.bind_sessions(
                conn, task_name="aging-task",
                worker_session_name="w", manager_session_name="m",
            )
            conn.execute(
                """
                insert into manager_cycles(
                  task_id, started_at, completed_at, state, status_json
                )
                values ('task-1', ?, ?, 'succeeded', ?)
                """,
                (old_ts, old_ts, json.dumps({"kind": "session_cycle", "task": "aging-task"})),
            )
            conn.commit()
            conn.close()

            # CLI with --stale-cycles-seconds 50 — should flag the 100s-old cycle.
            proc = subprocess.run(
                [sys.executable, "-m", "workerctl", "reconcile", "--stale-cycles-seconds", "50"],
                env=env, capture_output=True, text=True, cwd=str(ROOT),
            )
            self.assertEqual(proc.returncode, 0, proc.stderr)
            report = json.loads(proc.stdout)
            stuck_names = [s["task_name"] for s in report["stuck_tasks"]]
            self.assertIn("aging-task", stuck_names)


class CaptureErrorVisibilityTests(unittest.TestCase):
    def _setup_legacy_worker(self, name):
        worker_path = worker_dir(name)
        if worker_path.exists():
            shutil.rmtree(worker_path)
        worker_path.mkdir(parents=True)
        config_path(name).write_text(
            json.dumps(
                {
                    "cwd": str(ROOT),
                    "name": name,
                    "tmux_pane_id": "%1",
                    "tmux_session": f"codex-{name}",
                }
            )
            + "\n"
        )
        status_path(name).write_text(
            json.dumps(
                {
                    "blocker": None,
                    "current_task": "Investigating capture errors.",
                    "last_update": "2026-05-11T10:00:00Z",
                    "next_action": "Run tests.",
                    "state": "waiting",
                }
            )
            + "\n"
        )
        write_json(
            capture_meta_path(name),
            {
                "captured_at": "2026-05-11T10:00:00Z",
                "changed_at": "2026-05-11T10:00:00Z",
                "history_lines": 80,
            },
        )
        transcript_path(name).write_text("stale\ntranscript\n")
        self.addCleanup(self._cleanup_worker, name)

    def _cleanup_worker(self, name):
        path = worker_dir(name)
        if path.exists():
            shutil.rmtree(path)

    def test_command_status_includes_terminal_capture_error_when_capture_fails(self):
        name = "capture-error-status"
        self._setup_legacy_worker(name)

        original_session_exists = commands.session_exists
        original_capture_output = commands.capture_output
        commands.session_exists = lambda worker_name: True
        commands.capture_output = lambda worker_name, lines: (_ for _ in ()).throw(
            WorkerError("tmux capture-pane failed: exit 1")
        )
        args = argparse.Namespace(name=name, refresh=True, lines=80)
        try:
            with contextlib.redirect_stdout(io.StringIO()) as stdout:
                result = commands.command_status(args)
            self.assertEqual(result, 0)
            payload = json.loads(stdout.getvalue())
            self.assertIn("terminal_capture_error", payload)
            self.assertIsNotNone(payload["terminal_capture_error"])
            self.assertIn("tmux capture-pane failed", payload["terminal_capture_error"])
        finally:
            commands.session_exists = original_session_exists
            commands.capture_output = original_capture_output

    def test_idle_summary_marks_terminal_freshness_when_capture_fails(self):
        name = "capture-error-idle"
        self._setup_legacy_worker(name)

        original_session_exists = commands.session_exists
        original_capture_output = commands.capture_output
        original_capture_tmux_target = commands.capture_tmux_target
        commands.session_exists = lambda worker_name: True
        commands.capture_output = lambda worker_name, lines: (_ for _ in ()).throw(
            WorkerError("tmux refresh failed: exit 2")
        )
        commands.capture_tmux_target = lambda target, lines: (_ for _ in ()).throw(
            WorkerError("tmux live capture failed: exit 2")
        )
        try:
            summary = commands.idle_summary(
                name,
                status_stale_seconds=120,
                terminal_stale_seconds=120,
                busy_wait_seconds=120,
                refresh=True,
                lines=80,
            )
            self.assertIn("capture_error", summary)
            self.assertIsNotNone(summary["capture_error"])
            self.assertIn("tmux", summary["capture_error"])
            self.assertIn("terminal_fresh", summary)
            self.assertFalse(summary["terminal_fresh"])
        finally:
            commands.session_exists = original_session_exists
            commands.capture_output = original_capture_output
            commands.capture_tmux_target = original_capture_tmux_target

    def test_wait_for_status_update_writes_capture_failed_event_on_capture_error(self):
        name = "capture-error-wait"
        self._setup_legacy_worker(name)

        original_session_exists = commands.session_exists
        original_capture_output = commands.capture_output
        original_sleep = commands.time.sleep
        commands.session_exists = lambda worker_name: True
        commands.capture_output = lambda worker_name, lines: (_ for _ in ()).throw(
            WorkerError("tmux capture-pane failed during verify")
        )
        commands.time.sleep = lambda seconds: None
        try:
            result = commands.wait_for_status_update(
                name,
                initial_last_update="2026-05-11T10:00:00Z",
                initial_current_task="Investigating capture errors.",
                timeout_seconds=1,
            )
            self.assertFalse(result["ok"])
            events = [
                json.loads(line)
                for line in (worker_dir(name) / "events.jsonl").read_text().splitlines()
                if line.strip()
            ]
            capture_failed_events = [e for e in events if e.get("type") == "capture_failed"]
            self.assertTrue(
                capture_failed_events,
                f"expected at least one capture_failed event; got {[e.get('type') for e in events]}",
            )
            self.assertIn("error", capture_failed_events[0])
            self.assertIn("tmux capture-pane failed", capture_failed_events[0]["error"])
        finally:
            commands.session_exists = original_session_exists
            commands.capture_output = original_capture_output
            commands.time.sleep = original_sleep


class StartWorkerTests(unittest.TestCase):
    """Tests for `workerctl start-worker` — the spawn-and-register convenience."""

    def _build_fake_rollout(self, tmpdir, name="rollout"):
        rollout = Path(tmpdir) / f"{name}.jsonl"
        rollout.write_text(
            json.dumps({
                "type": "session_meta",
                "payload": {
                    "id": f"cuid-{name}",
                    "cwd": "/repo",
                    "originator": "codex-tui",
                },
            }) + "\n"
        )
        return rollout

    def test_start_worker_spawns_tmux_and_registers(self):
        """Happy path: tmux spawn succeeds, pid + rollout are discovered,
        a session row is created."""
        from workerctl import commands as worker_commands
        from workerctl import tmux as worker_tmux

        with tempfile.TemporaryDirectory() as tmpdir:
            state_dir = Path(tmpdir) / "state"
            state_dir.mkdir()
            os.environ["WORKERCTL_STATE_ROOT"] = str(state_dir)
            try:
                rollout = self._build_fake_rollout(tmpdir, "fake")

                spawned: list[list[str]] = []

                def fake_run(cmd, check=True, input_text=None):
                    spawned.append(list(cmd))
                    class R:
                        returncode = 0
                        stdout = ""
                        stderr = ""
                    return R()

                def fake_session_exists(name):
                    return False

                def fake_discover(tmux_session, *, timeout_seconds=15, poll_interval=0.5):
                    return {
                        "native_pid": 99999,
                        "codex_session_path": str(rollout),
                        "codex_session_id": "cuid-fake",
                        "cwd": "/repo",
                        "originator": "codex-tui",
                        "cli_version": "",
                    }

                orig_run = worker_tmux.run
                orig_session_exists = worker_tmux.session_exists
                orig_discover = worker_commands._discover_codex_session_in_tmux
                worker_tmux.run = fake_run
                worker_tmux.session_exists = fake_session_exists
                worker_commands._discover_codex_session_in_tmux = fake_discover
                try:
                    args = argparse.Namespace(
                        name="auto-foo", cwd="/repo", task=None,
                        sandbox="danger-full-access", ask_for_approval="never",
                        timeout_seconds=15,
                    )
                    captured_stdout = io.StringIO()
                    with contextlib.redirect_stdout(captured_stdout):
                        exit_code = worker_commands.command_start_worker(args)
                    self.assertEqual(exit_code, 0)

                    # Confirm tmux was spawned.
                    tmux_cmds = [c for c in spawned if len(c) > 1 and c[1] == "new-session"]
                    self.assertEqual(len(tmux_cmds), 1)
                    self.assertIn("codex-auto-foo", tmux_cmds[0])

                    # Confirm a session was registered.
                    conn = worker_db.connect(state_dir / "workerctl.db")
                    self.addCleanup(conn.close)
                    row = conn.execute(
                        "select * from sessions where name='auto-foo'"
                    ).fetchone()
                    self.assertIsNotNone(row)
                    self.assertEqual(row["role"], "worker")
                    self.assertEqual(row["pid"], 99999)
                    self.assertEqual(row["codex_session_id"], "cuid-fake")
                    self.assertEqual(row["tmux_session"], "codex-auto-foo")
                finally:
                    worker_tmux.run = orig_run
                    worker_tmux.session_exists = orig_session_exists
                    worker_commands._discover_codex_session_in_tmux = orig_discover
            finally:
                os.environ.pop("WORKERCTL_STATE_ROOT", None)

    def test_start_worker_refuses_if_session_name_already_registered(self):
        """If a session with the given name already exists in the DB, refuse cleanly."""
        from workerctl import commands as worker_commands

        with tempfile.TemporaryDirectory() as tmpdir:
            state_dir = Path(tmpdir) / "state"
            state_dir.mkdir()
            os.environ["WORKERCTL_STATE_ROOT"] = str(state_dir)
            try:
                conn = worker_db.connect()
                worker_db.initialize_database(conn)
                worker_db.register_session(
                    conn, name="taken", role="worker",
                    codex_session_path="/a", codex_session_id="u",
                    pid=1, cwd="/repo",
                )
                conn.commit()
                conn.close()

                args = argparse.Namespace(
                    name="taken", cwd="/repo", task=None,
                    sandbox="danger-full-access", ask_for_approval="never",
                    timeout_seconds=15,
                )
                with self.assertRaises(WorkerError):
                    worker_commands.command_start_worker(args)
            finally:
                os.environ.pop("WORKERCTL_STATE_ROOT", None)

    def test_start_worker_timeout_when_codex_doesnt_write_session_meta(self):
        """If the codex never writes a rollout (e.g. spawn failed), the discovery
        loop raises a WorkerError."""
        from workerctl import commands as worker_commands
        from workerctl import tmux as worker_tmux

        with tempfile.TemporaryDirectory() as tmpdir:
            state_dir = Path(tmpdir) / "state"
            state_dir.mkdir()
            os.environ["WORKERCTL_STATE_ROOT"] = str(state_dir)
            try:
                def fake_run(cmd, check=True, input_text=None):
                    class R:
                        returncode = 0
                        stdout = ""
                        stderr = ""
                    return R()

                def fake_session_exists(name):
                    return False

                def timeout_discover(tmux_session, *, timeout_seconds=15, poll_interval=0.5):
                    raise WorkerError(
                        f"codex did not write session_meta within {timeout_seconds}s"
                    )

                orig_run = worker_tmux.run
                orig_session_exists = worker_tmux.session_exists
                orig_discover = worker_commands._discover_codex_session_in_tmux
                worker_tmux.run = fake_run
                worker_tmux.session_exists = fake_session_exists
                worker_commands._discover_codex_session_in_tmux = timeout_discover
                try:
                    args = argparse.Namespace(
                        name="timeout-test", cwd="/repo", task=None,
                        sandbox="danger-full-access", ask_for_approval="never",
                        timeout_seconds=1,
                    )
                    with self.assertRaises(WorkerError):
                        worker_commands.command_start_worker(args)
                finally:
                    worker_tmux.run = orig_run
                    worker_tmux.session_exists = orig_session_exists
                    worker_commands._discover_codex_session_in_tmux = orig_discover
            finally:
                os.environ.pop("WORKERCTL_STATE_ROOT", None)

    def test_start_worker_subparser_describes_name_flag(self):
        proc = subprocess.run(
            [sys.executable, "-m", "workerctl", "start-worker", "--help"],
            capture_output=True,
            text=True,
            cwd=str(ROOT),
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("--name", proc.stdout)
        self.assertIn("Worker session name.", proc.stdout)


class ManagerBootstrapPromptTests(unittest.TestCase):
    def test_prompt_includes_living_criteria_guidance_and_runnable_examples(self):
        prompt = commands.manager_bootstrap_prompt(
            manager_name="docs-mgr",
            cwd="/repo",
            task_name="docs-task",
            task_goal="Update documentation",
            worker_name="docs-worker",
        )

        self.assertIn("Treat acceptance criteria as living supervision state", prompt)
        self.assertIn("manager_context.acceptance_criteria", prompt)
        self.assertIn("manager_context.criteria_negotiation", prompt)
        self.assertIn("use its prompt when needed is true", prompt)
        self.assertIn("must-have vs follow-up criteria", prompt)
        self.assertIn("Record useful criteria with `scripts/workerctl criteria`", prompt)
        self.assertIn("compare worker receipts/verification against accepted open criteria", prompt)
        self.assertIn(
            'scripts/workerctl criteria docs-task --add --criterion "..." --source worker_proposed --status proposed',
            prompt,
        )
        self.assertIn(
            """criterion_id=$(scripts/workerctl criteria docs-task --add --criterion "..." --source worker_proposed --status proposed | python3 -c 'import json,sys; print(json.load(sys.stdin)["affected_criterion"]["id"])')""",
            prompt,
        )
        self.assertIn(
            """scripts/workerctl criteria docs-task --satisfy "$criterion_id" --evidence-json '{"command":"...","status":"pass"}'""",
            prompt,
        )
        self.assertIn("affected_criterion", prompt)
        self.assertNotIn('["criteria"][0]["id"]', prompt)

    def test_docs_include_criteria_context_and_capture_id_examples(self):
        readme = (ROOT / "README.md").read_text()
        skill = (ROOT / "skills/manage-codex-workers/SKILL.md").read_text()

        for document in (readme, skill):
            self.assertIn("manager_context.acceptance_criteria", document)
            self.assertIn("manager_context.criteria_negotiation", document)
            self.assertIn('"criteria_negotiation"', document)
            self.assertIn("criterion_id=$(scripts/workerctl criteria", document)
            self.assertIn('["affected_criterion"]["id"]', document)
            self.assertIn('--satisfy "$criterion_id"', document)
            self.assertNotIn('["criteria"][0]["id"]', document)
            self.assertIn('"open": [...]', document)
            self.assertIn('"proposed": [...]', document)
            self.assertIn('"satisfied": [...]', document)
            self.assertIn('"deferred": [...]', document)
            self.assertIn('"rejected": [...]', document)


class StartManagerTests(unittest.TestCase):
    """Tests for `workerctl start-manager` — the spawn-and-register convenience for managers."""

    def _build_fake_rollout(self, tmpdir, name="rollout"):
        rollout = Path(tmpdir) / f"{name}.jsonl"
        rollout.write_text(
            json.dumps({
                "type": "session_meta",
                "payload": {
                    "id": f"cuid-{name}",
                    "cwd": "/repo",
                    "originator": "codex-tui",
                },
            }) + "\n"
        )
        return rollout

    def test_start_manager_spawns_tmux_and_registers(self):
        """Happy path: tmux spawn succeeds, pid + rollout are discovered,
        a session row is created with role="manager"."""
        from workerctl import commands as worker_commands
        from workerctl import tmux as worker_tmux

        with tempfile.TemporaryDirectory() as tmpdir:
            state_dir = Path(tmpdir) / "state"
            state_dir.mkdir()
            os.environ["WORKERCTL_STATE_ROOT"] = str(state_dir)
            try:
                rollout = self._build_fake_rollout(tmpdir, "fake")

                spawned: list[list[str]] = []

                def fake_run(cmd, check=True, input_text=None):
                    spawned.append(list(cmd))
                    class R:
                        returncode = 0
                        stdout = ""
                        stderr = ""
                    return R()

                def fake_session_exists(name):
                    return False

                def fake_discover(tmux_session, *, timeout_seconds=15, poll_interval=0.5):
                    return {
                        "native_pid": 88888,
                        "codex_session_path": str(rollout),
                        "codex_session_id": "cuid-fake",
                        "cwd": "/repo",
                        "originator": "codex-tui",
                        "cli_version": "",
                    }

                orig_run = worker_tmux.run
                orig_session_exists = worker_tmux.session_exists
                orig_discover = worker_commands._discover_codex_session_in_tmux
                worker_tmux.run = fake_run
                worker_tmux.session_exists = fake_session_exists
                worker_commands._discover_codex_session_in_tmux = fake_discover
                try:
                    args = argparse.Namespace(
                        name="auto-mgr", cwd="/repo",
                        sandbox="danger-full-access", ask_for_approval="never",
                        timeout_seconds=15,
                    )
                    captured_stdout = io.StringIO()
                    with contextlib.redirect_stdout(captured_stdout):
                        exit_code = worker_commands.command_start_manager(args)
                    self.assertEqual(exit_code, 0)

                    # Confirm tmux was spawned.
                    tmux_cmds = [c for c in spawned if len(c) > 1 and c[1] == "new-session"]
                    self.assertEqual(len(tmux_cmds), 1)
                    self.assertIn("codex-auto-mgr", tmux_cmds[0])
                    codex_cmd = tmux_cmds[0][-1]
                    self.assertIn("manager-config <task> --questions", codex_cmd)
                    self.assertIn("You are a Codex manager session", codex_cmd)
                    self.assertIn("acceptance criteria as living supervision state", codex_cmd)
                    self.assertIn("manager_context.acceptance_criteria", codex_cmd)
                    self.assertIn("must-have vs follow-up criteria", codex_cmd)
                    self.assertIn("scripts/workerctl criteria", codex_cmd)
                    self.assertIn("compare worker receipts/verification against accepted open criteria", codex_cmd)
                    self.assertNotIn("Do not edit files. Wait for manager instruction.", codex_cmd)

                    # Confirm a session was registered with role="manager".
                    conn = worker_db.connect(state_dir / "workerctl.db")
                    self.addCleanup(conn.close)
                    row = conn.execute(
                        "select * from sessions where name='auto-mgr'"
                    ).fetchone()
                    self.assertIsNotNone(row)
                    self.assertEqual(row["role"], "manager")
                    self.assertEqual(row["pid"], 88888)
                    self.assertEqual(row["codex_session_id"], "cuid-fake")
                    self.assertEqual(row["tmux_session"], "codex-auto-mgr")
                finally:
                    worker_tmux.run = orig_run
                    worker_tmux.session_exists = orig_session_exists
                    worker_commands._discover_codex_session_in_tmux = orig_discover
            finally:
                os.environ.pop("WORKERCTL_STATE_ROOT", None)

    def test_start_manager_refuses_if_session_name_already_registered(self):
        """If a session with the given name already exists in the DB, refuse cleanly."""
        from workerctl import commands as worker_commands

        with tempfile.TemporaryDirectory() as tmpdir:
            state_dir = Path(tmpdir) / "state"
            state_dir.mkdir()
            os.environ["WORKERCTL_STATE_ROOT"] = str(state_dir)
            try:
                conn = worker_db.connect()
                worker_db.initialize_database(conn)
                worker_db.register_session(
                    conn, name="taken", role="manager",
                    codex_session_path="/a", codex_session_id="u",
                    pid=1, cwd="/repo",
                )
                conn.commit()
                conn.close()

                args = argparse.Namespace(
                    name="taken", cwd="/repo",
                    sandbox="danger-full-access", ask_for_approval="never",
                    timeout_seconds=15,
                )
                with self.assertRaises(WorkerError):
                    worker_commands.command_start_manager(args)
            finally:
                os.environ.pop("WORKERCTL_STATE_ROOT", None)

    def test_start_manager_subparser_exists(self):
        """Verify the start-manager subparser exists and has the right flags."""
        import subprocess
        proc = subprocess.run(
            [sys.executable, "-m", "workerctl", "start-manager", "--help"],
            capture_output=True, text=True, cwd=str(ROOT),
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("--name", proc.stdout)
        self.assertIn("Manager session name.", proc.stdout)
        self.assertNotIn("--task", proc.stdout)  # managers don't take a task prompt


class SessionLookupFallbackTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.old_state_root = os.environ.get("WORKERCTL_STATE_ROOT")
        self.state_dir = Path(self.tmp.name) / "state"
        self.state_dir.mkdir()
        os.environ["WORKERCTL_STATE_ROOT"] = str(self.state_dir)
        self.addCleanup(self._restore_state_root)

        conn = worker_db.connect()
        worker_db.initialize_database(conn)
        worker_db.register_session(
            conn,
            name="session-worker",
            role="worker",
            codex_session_path="/tmp/rollout.jsonl",
            codex_session_id="codex-session-id",
            pid=12345,
            cwd=str(ROOT),
            tmux_session="custom-tmux",
            tmux_pane_id="%7",
        )
        conn.commit()
        conn.close()

    def _restore_state_root(self):
        if self.old_state_root is None:
            os.environ.pop("WORKERCTL_STATE_ROOT", None)
        else:
            os.environ["WORKERCTL_STATE_ROOT"] = self.old_state_root

    def _patch_tmux(self, output="terminal output"):
        calls = {"has_session_targets": [], "capture_targets": []}
        original_run = commands.run
        original_capture_tmux_target = commands.capture_tmux_target

        def fake_run(cmd, *args, **kwargs):
            if cmd[:2] == ["tmux", "has-session"]:
                calls["has_session_targets"].append(cmd[-1])
                return subprocess.CompletedProcess(cmd, 0, "", "")
            raise AssertionError(f"unexpected command: {cmd!r}")

        def fake_capture_tmux_target(target, history_lines):
            calls["capture_targets"].append((target, history_lines))
            return output

        commands.run = fake_run
        commands.capture_tmux_target = fake_capture_tmux_target
        self.addCleanup(setattr, commands, "run", original_run)
        self.addCleanup(setattr, commands, "capture_tmux_target", original_capture_tmux_target)
        return calls

    def test_capture_uses_sessions_table_tmux_session_when_legacy_worker_missing(self):
        calls = self._patch_tmux("session fallback output")
        args = argparse.Namespace(name="session-worker", lines=42)

        with contextlib.redirect_stdout(io.StringIO()) as stdout:
            result = commands.command_capture(args)

        self.assertEqual(result, 0)
        self.assertEqual(stdout.getvalue().strip(), "session fallback output")
        self.assertEqual(calls["has_session_targets"], ["custom-tmux"])
        self.assertEqual(calls["capture_targets"], [("custom-tmux", 42)])
        self.assertEqual(transcript_path("session-worker").read_text(), "session fallback output\n")

    def test_status_resolves_sessions_table_tmux_session(self):
        calls = self._patch_tmux()
        args = argparse.Namespace(name="session-worker", refresh=False, lines=80)

        with contextlib.redirect_stdout(io.StringIO()) as stdout:
            result = commands.command_status(args)

        self.assertEqual(result, 0)
        payload = json.loads(stdout.getvalue())
        self.assertEqual(payload["name"], "session-worker")
        self.assertEqual(payload["tmux_session"], "custom-tmux")
        self.assertTrue(payload["running"])
        self.assertEqual(calls["has_session_targets"], ["custom-tmux"])

    def test_idle_check_resolves_sessions_table_tmux_session(self):
        calls = self._patch_tmux("idle terminal output")
        args = argparse.Namespace(
            name="session-worker",
            status_stale_seconds=300,
            terminal_stale_seconds=300,
            busy_wait_seconds=90,
            refresh=False,
            lines=33,
        )

        with contextlib.redirect_stdout(io.StringIO()) as stdout:
            result = commands.command_idle_check(args)

        self.assertEqual(result, 0)
        payload = json.loads(stdout.getvalue())
        self.assertEqual(payload["name"], "session-worker")
        self.assertEqual(payload["tmux_session"], "custom-tmux")
        self.assertTrue(payload["running"])
        self.assertEqual(calls["capture_targets"], [("custom-tmux", 33)])

    def test_events_accepts_sessions_table_name_when_legacy_worker_missing(self):
        append_event("session-worker", "note", {"message": "from sessions fallback"})
        args = argparse.Namespace(name="session-worker", type=None, limit=None)

        with contextlib.redirect_stdout(io.StringIO()) as stdout:
            result = commands.command_events(args)

        self.assertEqual(result, 0)
        events = [json.loads(line) for line in stdout.getvalue().splitlines()]
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["type"], "note")
        self.assertEqual(events[0]["message"], "from sessions fallback")


class SessionsLegacyFilterTests(unittest.TestCase):
    def open_db(self, tmpdir):
        path = Path(tmpdir) / "workerctl.db"
        conn = worker_db.connect(path)
        worker_db.initialize_database(conn)
        self.addCleanup(conn.close)
        return conn

    def _seed_real_and_legacy(self, conn):
        worker_db.register_session(
            conn, name="real", role="worker",
            codex_session_path="/a", codex_session_id="u-r",
            pid=12345, cwd="/r",
        )
        now = "2026-05-12T00:00:00Z"
        conn.execute(
            """
            insert into sessions(id, name, role, identity_token, cwd,
                                 registered_at, state, pid)
            values ('legacy-s', 'legacy', 'worker', 'tok-legacy', '/r',
                    ?, 'active', NULL)
            """,
            (now,),
        )
        conn.execute(
            """
            insert into sessions(id, name, role, identity_token, cwd,
                                 registered_at, state, pid)
            values ('gone-s', 'gone', 'worker', 'tok-gone', '/r',
                    ?, 'gone', 34567)
            """,
            (now,),
        )
        conn.commit()

    def test_list_sessions_excludes_legacy_and_gone_by_default(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)
            self._seed_real_and_legacy(conn)
            sessions = worker_db.list_sessions(conn)
            names = {s["name"] for s in sessions}
            self.assertIn("real", names)
            self.assertNotIn("legacy", names)
            self.assertNotIn("gone", names)

    def test_list_sessions_include_legacy_still_excludes_gone(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)
            self._seed_real_and_legacy(conn)
            sessions = worker_db.list_sessions(conn, include_legacy=True)
            names = {s["name"] for s in sessions}
            self.assertIn("real", names)
            self.assertIn("legacy", names)
            self.assertNotIn("gone", names)

    def test_list_sessions_state_active_matches_default(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)
            self._seed_real_and_legacy(conn)
            default_sessions = worker_db.list_sessions(conn)
            active_sessions = worker_db.list_sessions(conn, state="active")
            self.assertEqual(
                [s["name"] for s in active_sessions],
                [s["name"] for s in default_sessions],
            )

    def test_list_sessions_state_gone_returns_only_gone(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)
            self._seed_real_and_legacy(conn)
            sessions = worker_db.list_sessions(conn, state="gone")
            self.assertEqual({s["name"] for s in sessions}, {"gone"})

    def test_list_sessions_state_all_bypasses_default_filters(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)
            self._seed_real_and_legacy(conn)
            sessions = worker_db.list_sessions(conn, state="all")
            self.assertEqual({s["name"] for s in sessions}, {"real", "legacy", "gone"})

    def test_list_sessions_role_filter_combined_with_legacy_filter(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            conn = self.open_db(tmpdir)
            self._seed_real_and_legacy(conn)
            # Add a manager too.
            worker_db.register_session(
                conn, name="real-mgr", role="manager",
                codex_session_path="/a", codex_session_id="u-m",
                pid=23456, cwd="/r",
            )
            conn.commit()
            workers = worker_db.list_sessions(conn, role="worker")
            self.assertEqual({s["name"] for s in workers}, {"real"})

    def test_cli_sessions_default_excludes_legacy_and_gone(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            state_dir = Path(tmpdir) / "state"
            state_dir.mkdir()
            env = os.environ.copy()
            env["WORKERCTL_STATE_ROOT"] = str(state_dir)
            db_path = state_dir / "workerctl.db"
            # Seed via direct DB.
            conn = worker_db.connect(db_path)
            worker_db.initialize_database(conn)
            self._seed_real_and_legacy(conn)
            conn.close()

            proc = subprocess.run(
                [sys.executable, "-m", "workerctl", "sessions"],
                env=env, capture_output=True, text=True, cwd=str(ROOT),
            )
            self.assertEqual(proc.returncode, 0, proc.stderr)
            rows = json.loads(proc.stdout)
            names = {r["name"] for r in rows}
            self.assertIn("real", names)
            self.assertNotIn("legacy", names)
            self.assertNotIn("gone", names)

            proc = subprocess.run(
                [sys.executable, "-m", "workerctl", "sessions", "--include-legacy"],
                env=env, capture_output=True, text=True, cwd=str(ROOT),
            )
            self.assertEqual(proc.returncode, 0, proc.stderr)
            rows = json.loads(proc.stdout)
            names = {r["name"] for r in rows}
            self.assertIn("real", names)
            self.assertIn("legacy", names)
            self.assertNotIn("gone", names)

            proc = subprocess.run(
                [sys.executable, "-m", "workerctl", "sessions", "--state", "active"],
                env=env, capture_output=True, text=True, cwd=str(ROOT),
            )
            self.assertEqual(proc.returncode, 0, proc.stderr)
            rows = json.loads(proc.stdout)
            self.assertEqual({r["name"] for r in rows}, {"real"})

            proc = subprocess.run(
                [sys.executable, "-m", "workerctl", "sessions", "--state", "gone"],
                env=env, capture_output=True, text=True, cwd=str(ROOT),
            )
            self.assertEqual(proc.returncode, 0, proc.stderr)
            rows = json.loads(proc.stdout)
            self.assertEqual({r["name"] for r in rows}, {"gone"})

            proc = subprocess.run(
                [sys.executable, "-m", "workerctl", "sessions", "--state", "all"],
                env=env, capture_output=True, text=True, cwd=str(ROOT),
            )
            self.assertEqual(proc.returncode, 0, proc.stderr)
            rows = json.loads(proc.stdout)
            self.assertEqual({r["name"] for r in rows}, {"real", "legacy", "gone"})


class RegisterManagerLsofTests(unittest.TestCase):
    def _fake_lsof_output_with_rollout(self, path: str) -> str:
        return (
            "codex 28975 user  10u  REG  1,17  100  401  /private/var/something\n"
            f"codex 28975 user  34w  REG  1,17  4560872  41566360 {path}\n"
            "codex 28975 user  21u  KQUEUE                       count=0\n"
        )

    def _fake_lsof_output_without_rollout(self) -> str:
        return (
            "codex 28975 user  10u  REG  1,17  100  401  /private/var/something\n"
            "codex 28975 user  21u  KQUEUE                       count=0\n"
        )

    def test_register_manager_uses_lsof_to_find_rollout(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "workerctl.db"
            conn = worker_db.connect(db_path)
            worker_db.initialize_database(conn)
            conn.close()

            # Create a real rollout file in a path that matches the pattern (.codex/sessions/...)
            rollout_dir = Path(tmpdir) / ".codex" / "sessions" / "2026" / "05" / "13"
            rollout_dir.mkdir(parents=True, exist_ok=True)
            rollout_path = rollout_dir / "rollout-test.jsonl"
            rollout_path.write_text(json.dumps({"type": "session_meta", "payload": {"id": "test-id"}}) + "\n")

            fake_proc = subprocess.CompletedProcess(
                args=[], returncode=0,
                stdout=self._fake_lsof_output_with_rollout(str(rollout_path)),
                stderr="",
            )
            # Patch subprocess.run directly in the commands module
            with mock.patch("subprocess.run", return_value=fake_proc):
                args = argparse.Namespace(
                    name="lsof-mgr", pid=28975,
                    codex_session=None, cwd=tmpdir, tmux_session=None,
                    path=str(db_path),
                )
                # Capture stdout since the function prints the result
                stdout_capture = io.StringIO()
                with contextlib.redirect_stdout(stdout_capture):
                    rc = commands.command_register_manager(args)
                self.assertEqual(rc, 0)
                result = json.loads(stdout_capture.getvalue())
                self.assertEqual(result["role"], "manager")
                self.assertEqual(result["codex_session_path"], str(rollout_path))
                self.assertEqual(result["pid"], 28975)

    def test_register_manager_fails_with_hint_when_no_jsonl_found(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "workerctl.db"
            conn = worker_db.connect(db_path)
            worker_db.initialize_database(conn)
            conn.close()

            fake_proc = subprocess.CompletedProcess(
                args=[], returncode=0,
                stdout=self._fake_lsof_output_without_rollout(),
                stderr="",
            )
            with mock.patch("subprocess.run", return_value=fake_proc):
                args = argparse.Namespace(
                    name="lsof-mgr", pid=28975,
                    codex_session=None, cwd=tmpdir, tmux_session=None,
                    path=str(db_path),
                )
                with self.assertRaises(WorkerError) as ctx:
                    commands.command_register_manager(args)
            # The error message should hint at the warm-up dance.
            self.assertIn("rollout", str(ctx.exception).lower())

    def test_register_manager_still_works_with_explicit_codex_session(self):
        # When --codex-session is passed, lsof is bypassed.
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "workerctl.db"
            conn = worker_db.connect(db_path)
            worker_db.initialize_database(conn)
            conn.close()

            rollout = Path(tmpdir) / "explicit.jsonl"
            rollout.write_text(json.dumps({"type": "session_meta", "payload": {"id": "x"}}) + "\n")

            args = argparse.Namespace(
                name="explicit-mgr", pid=28975,
                codex_session=str(rollout), cwd=tmpdir, tmux_session=None,
                path=str(db_path),
            )
            # Should not call lsof at all.
            with mock.patch("subprocess.run") as mocked:
                stdout_capture = io.StringIO()
                with contextlib.redirect_stdout(stdout_capture):
                    rc = commands.command_register_manager(args)
                mocked.assert_not_called()
            self.assertEqual(rc, 0)
            result = json.loads(stdout_capture.getvalue())
            self.assertEqual(result["codex_session_path"], str(rollout))

    def test_register_manager_respects_path_override(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            default_path = Path(tmpdir) / "default.db"
            override_path = Path(tmpdir) / "override.db"
            original_default_db_path = worker_db.default_db_path
            try:
                worker_db.default_db_path = lambda: default_path
                with worker_db.connect(default_path) as conn:
                    worker_db.initialize_database(conn)
                    conn.commit()

                rollout = Path(tmpdir) / "explicit.jsonl"
                rollout.write_text(json.dumps({"type": "session_meta", "payload": {"id": "x"}}) + "\n")

                args = argparse.Namespace(
                    name="override-mgr", pid=28975,
                    codex_session=str(rollout), cwd=tmpdir, tmux_session=None,
                    path=str(override_path),
                )
                stdout_capture = io.StringIO()
                with contextlib.redirect_stdout(stdout_capture):
                    rc = commands.command_register_manager(args)
                self.assertEqual(rc, 0)

                with worker_db.connect(default_path) as conn:
                    worker_db.initialize_database(conn)
                    default_row = conn.execute("select id from sessions where name = 'override-mgr'").fetchone()
                with worker_db.connect(override_path) as conn:
                    worker_db.initialize_database(conn)
                    override_row = conn.execute("select id from sessions where name = 'override-mgr'").fetchone()

                self.assertIsNone(default_row)
                self.assertIsNotNone(override_row)
            finally:
                worker_db.default_db_path = original_default_db_path


class AcceptanceCriteriaCliTests(unittest.TestCase):
    def _setup_db(self, tmpdir):
        db_path = Path(tmpdir) / "workerctl.db"
        conn = worker_db.connect(db_path)
        worker_db.initialize_database(conn)
        conn.close()
        return db_path

    def _create_task(self, db_path, name="criteria-cli-task"):
        conn = worker_db.connect(db_path)
        try:
            task_id = worker_db.create_task(conn, name=name, goal="Track emergent criteria.")
            conn.commit()
            return task_id
        finally:
            conn.close()

    def _run_workerctl(self, *args):
        return subprocess.run(
            [sys.executable, "-m", "workerctl", *args],
            capture_output=True,
            text=True,
            cwd=str(ROOT),
        )

    def test_mutation_response_snapshot_is_built_under_write_lock(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = self._setup_db(tmpdir)
            task_id = self._create_task(db_path)
            conn = worker_db.connect(db_path)
            try:
                first_id = worker_db.insert_acceptance_criterion(
                    conn,
                    task_id=task_id,
                    criterion="First criterion",
                    status="accepted",
                    source="manager_inferred",
                )
                second_id = worker_db.insert_acceptance_criterion(
                    conn,
                    task_id=task_id,
                    criterion="Second criterion",
                    status="accepted",
                    source="manager_inferred",
                )
                conn.commit()
            finally:
                conn.close()

            from workerctl import commands as worker_commands

            original_response = worker_commands._acceptance_criteria_response
            lock_probe = {"attempted": False, "locked": False}

            def response_with_lock_probe(conn, *, task, statuses=None, affected_criterion=None):
                lock_probe["attempted"] = True
                probe = sqlite3.connect(db_path, timeout=0)
                try:
                    with self.assertRaises(sqlite3.OperationalError) as raised:
                        probe.execute(
                            "update acceptance_criteria set status = 'deferred' where id = ?",
                            (second_id,),
                        )
                    self.assertIn("locked", str(raised.exception).lower())
                    lock_probe["locked"] = True
                finally:
                    probe.close()
                return original_response(
                    conn,
                    task=task,
                    statuses=statuses,
                    affected_criterion=affected_criterion,
                )

            args = argparse.Namespace(
                accept=None,
                add=False,
                criterion=None,
                defer=first_id,
                evidence_json=None,
                list=False,
                path=str(db_path),
                proof=None,
                rationale="Defer first criterion",
                reject=None,
                satisfy=None,
                source=None,
                status=[],
                task="criteria-cli-task",
            )

            try:
                worker_commands._acceptance_criteria_response = response_with_lock_probe
                with contextlib.redirect_stdout(io.StringIO()) as stdout:
                    result = worker_commands.command_criteria(args)
            finally:
                worker_commands._acceptance_criteria_response = original_response

            payload = json.loads(stdout.getvalue())
            self.assertEqual(result, 0)
            self.assertTrue(lock_probe["attempted"])
            self.assertTrue(lock_probe["locked"])
            self.assertEqual(payload["affected_criterion"]["id"], first_id)
            self.assertEqual(payload["affected_criterion"]["status"], "deferred")
            self.assertEqual(payload["summary"]["accepted"], 1)
            self.assertEqual(payload["summary"]["deferred"], 1)

    def test_add_and_list_outputs_task_criteria_summary_and_event(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = self._setup_db(tmpdir)
            task_id = self._create_task(db_path)

            add = self._run_workerctl(
                "criteria",
                "criteria-cli-task",
                "--add",
                "--criterion",
                "Targeted CLI tests pass",
                "--source",
                "worker_proposed",
                "--status",
                "proposed",
                "--proof",
                "python3 -m unittest tests.test_workerctl.AcceptanceCriteriaCliTests -v",
                "--rationale",
                "The command needs CLI coverage.",
                "--evidence-json",
                '{"phase":"red"}',
                "--path",
                str(db_path),
            )
            self.assertEqual(add.returncode, 0, add.stderr)
            added = json.loads(add.stdout)
            self.assertEqual(added["task"], {"id": task_id, "name": "criteria-cli-task"})
            self.assertEqual(added["summary"]["proposed"], 1)
            self.assertEqual(added["summary"]["accepted"], 0)
            self.assertEqual(len(added["criteria"]), 1)
            self.assertEqual(added["criteria"][0]["criterion"], "Targeted CLI tests pass")
            self.assertEqual(added["criteria"][0]["status"], "proposed")
            self.assertEqual(added["criteria"][0]["source"], "worker_proposed")
            self.assertEqual(added["criteria"][0]["proof"], "python3 -m unittest tests.test_workerctl.AcceptanceCriteriaCliTests -v")
            self.assertEqual(added["criteria"][0]["rationale"], "The command needs CLI coverage.")
            self.assertEqual(added["criteria"][0]["evidence"], {"phase": "red"})
            self.assertEqual(added["affected_criterion"], added["criteria"][0])
            self.assertEqual(added["affected_criterion"]["id"], added["criteria"][0]["id"])

            listed = self._run_workerctl(
                "criteria",
                "criteria-cli-task",
                "--list",
                "--path",
                str(db_path),
            )
            self.assertEqual(listed.returncode, 0, listed.stderr)
            payload = json.loads(listed.stdout)
            self.assertEqual(payload["criteria"], added["criteria"])
            self.assertNotIn("affected_criterion", payload)
            self.assertEqual(
                payload["summary"],
                {"proposed": 1, "accepted": 0, "satisfied": 0, "deferred": 0, "rejected": 0},
            )

            conn = worker_db.connect(db_path)
            try:
                event = conn.execute(
                    "select type, payload_json from events where task_id = ? order by id desc limit 1",
                    (task_id,),
                ).fetchone()
            finally:
                conn.close()
            self.assertEqual(event["type"], "acceptance_criterion_added")
            event_payload = json.loads(event["payload_json"])
            self.assertEqual(event_payload["criterion_id"], added["criteria"][0]["id"])
            self.assertEqual(event_payload["criterion"], "Targeted CLI tests pass")
            self.assertEqual(event_payload["status"], "proposed")
            self.assertEqual(event_payload["source"], "worker_proposed")
            self.assertEqual(event_payload["proof"], "python3 -m unittest tests.test_workerctl.AcceptanceCriteriaCliTests -v")
            self.assertEqual(event_payload["rationale"], "The command needs CLI coverage.")
            self.assertEqual(event_payload["evidence"], {"phase": "red"})
            self.assertTrue(event_payload["created"])

    def test_duplicate_add_preserves_one_row_and_does_not_emit_second_added_event(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = self._setup_db(tmpdir)
            task_id = self._create_task(db_path)

            add_args = [
                "criteria",
                "criteria-cli-task",
                "--add",
                "--criterion",
                "No duplicate audit mutation",
                "--source",
                "manager_inferred",
                "--status",
                "proposed",
                "--path",
                str(db_path),
            ]
            first = self._run_workerctl(*add_args)
            second = self._run_workerctl(*add_args)

            self.assertEqual(first.returncode, 0, first.stderr)
            self.assertEqual(second.returncode, 0, second.stderr)
            first_payload = json.loads(first.stdout)
            second_payload = json.loads(second.stdout)
            self.assertEqual(len(first_payload["criteria"]), 1)
            self.assertEqual(len(second_payload["criteria"]), 1)
            self.assertEqual(first_payload["criteria"][0]["id"], second_payload["criteria"][0]["id"])
            self.assertEqual(first_payload["affected_criterion"]["id"], first_payload["criteria"][0]["id"])
            self.assertEqual(second_payload["affected_criterion"]["id"], first_payload["criteria"][0]["id"])
            self.assertEqual(second_payload["affected_criterion"], first_payload["criteria"][0])

            conn = worker_db.connect(db_path)
            try:
                row_count = conn.execute(
                    "select count(*) from acceptance_criteria where task_id = ?",
                    (task_id,),
                ).fetchone()[0]
                added_event_count = conn.execute(
                    "select count(*) from events where task_id = ? and type = 'acceptance_criterion_added'",
                    (task_id,),
                ).fetchone()[0]
            finally:
                conn.close()
            self.assertEqual(row_count, 1)
            self.assertEqual(added_event_count, 1)

    def test_list_filters_by_repeated_status(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = self._setup_db(tmpdir)
            task_id = self._create_task(db_path)
            conn = worker_db.connect(db_path)
            try:
                worker_db.insert_acceptance_criterion(
                    conn,
                    task_id=task_id,
                    criterion="Manager proposed",
                    status="proposed",
                    source="manager_inferred",
                )
                worker_db.insert_acceptance_criterion(
                    conn,
                    task_id=task_id,
                    criterion="User accepted",
                    status="accepted",
                    source="user_requested",
                )
                worker_db.insert_acceptance_criterion(
                    conn,
                    task_id=task_id,
                    criterion="Audit rejected",
                    status="rejected",
                    source="final_audit",
                )
                conn.commit()
            finally:
                conn.close()

            proc = self._run_workerctl(
                "criteria",
                "criteria-cli-task",
                "--list",
                "--status",
                "accepted",
                "--status",
                "rejected",
                "--path",
                str(db_path),
            )

            self.assertEqual(proc.returncode, 0, proc.stderr)
            payload = json.loads(proc.stdout)
            self.assertEqual([row["status"] for row in payload["criteria"]], ["accepted", "rejected"])
            self.assertNotIn("affected_criterion", payload)
            self.assertEqual(payload["summary"]["proposed"], 1)
            self.assertEqual(payload["summary"]["accepted"], 1)
            self.assertEqual(payload["summary"]["rejected"], 1)

    def test_update_actions_set_status_and_record_events(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = self._setup_db(tmpdir)
            task_id = self._create_task(db_path)
            conn = worker_db.connect(db_path)
            try:
                ids = {
                    action: worker_db.insert_acceptance_criterion(
                        conn,
                        task_id=task_id,
                        criterion=f"{action} criterion",
                        status="proposed",
                        source="manager_inferred",
                    )
                    for action in ("accept", "satisfy", "defer", "reject")
                }
                conn.commit()
            finally:
                conn.close()

            actions = [
                ("--accept", ids["accept"], "accepted", []),
                (
                    "--satisfy",
                    ids["satisfy"],
                    "satisfied",
                    ["--evidence-json", '{"command":"python3 -m unittest"}', "--proof", "tests passed"],
                ),
                ("--defer", ids["defer"], "deferred", ["--rationale", "Out of scope"]),
                ("--reject", ids["reject"], "rejected", ["--evidence-json", '{"reason":"duplicate"}']),
            ]
            for flag, criterion_id, expected_status, extra_args in actions:
                proc = self._run_workerctl(
                    "criteria",
                    "criteria-cli-task",
                    flag,
                    str(criterion_id),
                    *extra_args,
                    "--path",
                    str(db_path),
                )
                self.assertEqual(proc.returncode, 0, proc.stderr)
                payload = json.loads(proc.stdout)
                row = next(row for row in payload["criteria"] if row["id"] == criterion_id)
                self.assertEqual(row["status"], expected_status)
                self.assertEqual(payload["affected_criterion"], row)
                self.assertEqual(payload["affected_criterion"]["id"], criterion_id)

            conn = worker_db.connect(db_path)
            try:
                rows = conn.execute(
                    "select type, payload_json from events where task_id = ? and type = 'acceptance_criterion_updated' order by id",
                    (task_id,),
                ).fetchall()
            finally:
                conn.close()
            self.assertEqual(len(rows), 4)
            event_payloads = [json.loads(row["payload_json"]) for row in rows]
            event_statuses = [payload["status"] for payload in event_payloads]
            self.assertEqual(event_statuses, ["accepted", "satisfied", "deferred", "rejected"])
            by_status = {payload["status"]: payload for payload in event_payloads}
            self.assertEqual(by_status["satisfied"]["criterion"], "satisfy criterion")
            self.assertEqual(by_status["satisfied"]["previous_status"], "proposed")
            self.assertEqual(by_status["satisfied"]["proof"], "tests passed")
            self.assertIsNone(by_status["satisfied"]["rationale"])
            self.assertEqual(by_status["satisfied"]["evidence"], {"command": "python3 -m unittest"})
            self.assertIsNone(by_status["satisfied"]["previous_proof"])
            self.assertIsNone(by_status["satisfied"]["previous_rationale"])
            self.assertEqual(by_status["satisfied"]["previous_evidence"], {})
            self.assertEqual(by_status["deferred"]["rationale"], "Out of scope")
            self.assertEqual(by_status["deferred"]["evidence"], {})
            self.assertEqual(by_status["rejected"]["evidence"], {"reason": "duplicate"})

    def test_invalid_status_source_and_evidence_json_fail(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = self._setup_db(tmpdir)
            self._create_task(db_path)

            invalid_status = self._run_workerctl(
                "criteria",
                "criteria-cli-task",
                "--add",
                "--criterion",
                "Bad status",
                "--source",
                "worker_proposed",
                "--status",
                "done",
                "--path",
                str(db_path),
            )
            self.assertNotEqual(invalid_status.returncode, 0)
            self.assertIn("invalid acceptance criterion status", invalid_status.stderr)

            invalid_source = self._run_workerctl(
                "criteria",
                "criteria-cli-task",
                "--add",
                "--criterion",
                "Bad source",
                "--source",
                "worker",
                "--path",
                str(db_path),
            )
            self.assertNotEqual(invalid_source.returncode, 0)
            self.assertIn("invalid acceptance criterion source", invalid_source.stderr)

            invalid_evidence = self._run_workerctl(
                "criteria",
                "criteria-cli-task",
                "--add",
                "--criterion",
                "Bad evidence",
                "--source",
                "worker_proposed",
                "--evidence-json",
                '["not-an-object"]',
                "--path",
                str(db_path),
            )
            self.assertNotEqual(invalid_evidence.returncode, 0)
            self.assertIn("--evidence-json must be a JSON object", invalid_evidence.stderr)


class AcceptanceCriteriaReplayExportTests(unittest.TestCase):
    def _setup_db(self, tmpdir):
        db_path = Path(tmpdir) / "workerctl.db"
        conn = worker_db.connect(db_path)
        worker_db.initialize_database(conn)
        conn.close()
        return db_path

    def _run_workerctl(self, *args):
        return subprocess.run(
            [sys.executable, str(WORKERCTL_PATH), *args],
            capture_output=True,
            text=True,
            cwd=str(ROOT),
        )

    def _event_payload(self, criterion, task_id, previous=None, created=None):
        payload = {
            "criterion_id": criterion["id"],
            "criterion": criterion["criterion"],
            "status": criterion["status"],
            "source": criterion["source"],
            "proof": criterion["proof"],
            "rationale": criterion["rationale"],
            "evidence": criterion["evidence"],
            "task_id": task_id,
        }
        if created is not None:
            payload["created"] = created
        if previous is not None:
            payload.update(
                {
                    "previous_status": previous["status"],
                    "previous_proof": previous["proof"],
                    "previous_rationale": previous["rationale"],
                    "previous_evidence": previous["evidence"],
                }
            )
        return payload

    def _create_task_with_criteria_events(self, db_path):
        with worker_db.connect(db_path) as conn:
            worker_db.initialize_database(conn)
            task_id = worker_db.create_task(conn, name="criteria-replay-task", goal="Track emergent criteria.")
            proposed_id = worker_db.insert_acceptance_criterion(
                conn,
                task_id=task_id,
                criterion="Run targeted acceptance criteria replay tests",
                status="proposed",
                source="worker_proposed",
                rationale="Worker noticed replay/export should preserve emergent criteria.",
                evidence={"phase": "proposed"},
            )
            criteria = worker_db.acceptance_criteria_for_task(conn, task_id=task_id)
            proposed = next(row for row in criteria if row["id"] == proposed_id)
            worker_db.insert_event(
                conn,
                "acceptance_criterion_added",
                actor="workerctl",
                task_id=task_id,
                payload=self._event_payload(proposed, task_id, created=True),
            )

            accepted = worker_db.update_acceptance_criterion(
                conn,
                criterion_id=proposed_id,
                status="accepted",
                rationale="Manager accepted the emergent replay/export requirement.",
            )
            worker_db.insert_event(
                conn,
                "acceptance_criterion_updated",
                actor="workerctl",
                task_id=task_id,
                payload=self._event_payload(accepted, task_id, previous=proposed),
            )

            satisfied_previous = accepted
            satisfied = worker_db.update_acceptance_criterion(
                conn,
                criterion_id=proposed_id,
                status="satisfied",
                proof="python3 -m unittest tests.test_workerctl.AcceptanceCriteriaReplayExportTests -v",
                evidence={"command": "python3 -m unittest", "status": "pass"},
            )
            worker_db.insert_event(
                conn,
                "acceptance_criterion_updated",
                actor="workerctl",
                task_id=task_id,
                payload=self._event_payload(satisfied, task_id, previous=satisfied_previous),
            )

            deferred_id = worker_db.insert_acceptance_criterion(
                conn,
                task_id=task_id,
                criterion="Ship unrelated dashboard polish",
                status="deferred",
                source="manager_inferred",
                rationale="Out of scope for this audit change.",
            )
            deferred = next(row for row in worker_db.acceptance_criteria_for_task(conn, task_id=task_id) if row["id"] == deferred_id)
            worker_db.insert_event(
                conn,
                "acceptance_criterion_added",
                actor="workerctl",
                task_id=task_id,
                payload=self._event_payload(deferred, task_id, created=True),
            )
            conn.commit()
            return {"task_id": task_id, "proposed_id": proposed_id, "deferred_id": deferred_id}

    def test_task_audit_includes_acceptance_criteria(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = self._setup_db(tmpdir)
            ids = self._create_task_with_criteria_events(db_path)

            with worker_db.connect(db_path) as conn:
                audit = worker_db.task_audit(conn, task="criteria-replay-task")

            self.assertIn("acceptance_criteria", audit)
            by_id = {row["id"]: row for row in audit["acceptance_criteria"]}
            self.assertEqual(by_id[ids["proposed_id"]]["status"], "satisfied")
            self.assertEqual(by_id[ids["proposed_id"]]["evidence"], {"command": "python3 -m unittest", "status": "pass"})
            self.assertEqual(by_id[ids["deferred_id"]]["rationale"], "Out of scope for this audit change.")

    def test_replay_timeline_includes_added_and_updated_criteria_summaries(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = self._setup_db(tmpdir)
            ids = self._create_task_with_criteria_events(db_path)

            proc = self._run_workerctl("replay", "criteria-replay-task", "--path", str(db_path))

            self.assertEqual(proc.returncode, 0, proc.stderr)
            self.assertIn(f"proposed criterion #{ids['proposed_id']}: Run targeted acceptance criteria replay tests", proc.stdout)
            self.assertIn(
                f"accepted criterion #{ids['proposed_id']} (proposed -> accepted): "
                "Run targeted acceptance criteria replay tests",
                proc.stdout,
            )
            self.assertIn(
                f"satisfied criterion #{ids['proposed_id']} (accepted -> satisfied): proof recorded",
                proc.stdout,
            )
            self.assertIn(f"deferred criterion #{ids['deferred_id']}: Out of scope for this audit change.", proc.stdout)

    def test_replay_compact_includes_criteria_transitions(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = self._setup_db(tmpdir)
            ids = self._create_task_with_criteria_events(db_path)

            compact = self._run_workerctl("replay", "criteria-replay-task", "--format", "compact", "--path", str(db_path))
            worker_only = self._run_workerctl(
                "replay",
                "criteria-replay-task",
                "--format",
                "compact",
                "--role",
                "worker",
                "--path",
                str(db_path),
            )

            self.assertEqual(compact.returncode, 0, compact.stderr)
            self.assertIn(f"accepted criterion #{ids['proposed_id']} (proposed -> accepted)", compact.stdout)
            self.assertIn(f"satisfied criterion #{ids['proposed_id']} (accepted -> satisfied)", compact.stdout)
            self.assertEqual(worker_only.returncode, 0, worker_only.stderr)
            self.assertNotIn("criterion #", worker_only.stdout)

    def test_replay_preserves_numeric_event_order_for_same_timestamp_criteria(self):
        from workerctl import replay as worker_replay

        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = self._setup_db(tmpdir)
            with worker_db.connect(db_path) as conn:
                task_id = worker_db.create_task(conn, name="criteria-order-task", goal="Track event ordering.")
                timestamp = "2026-05-15T12:00:00Z"
                for number in range(1, 12):
                    conn.execute(
                        """
                        insert into events(
                          created_at, actor, command_id, correlation_id, task_id,
                          worker_id, manager_id, type, payload_json
                        )
                        values (?, 'workerctl', null, null, ?, null, null, ?, ?)
                        """,
                        (
                            timestamp,
                            task_id,
                            "acceptance_criterion_updated",
                            json.dumps(
                                {
                                    "criterion": f"Criterion {number}",
                                    "criterion_id": number,
                                    "previous_status": "accepted",
                                    "status": "satisfied",
                                    "task_id": task_id,
                                },
                                sort_keys=True,
                            ),
                        ),
                    )
                conn.commit()
                audit = worker_db.task_audit(conn, task="criteria-order-task")

            entries = [
                entry
                for entry in worker_replay.replay_entries(audit, role="all", mode="compact")
                if entry["kind"] == "acceptance_criterion"
            ]

            source_ids = [entry["source_id"] for entry in entries]
            self.assertEqual(source_ids, sorted(source_ids))
            self.assertIn("criterion #2", entries[1]["summary"])
            self.assertIn("criterion #10", entries[9]["summary"])

    def test_export_writes_acceptance_criteria_file_manifest_and_zip(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = self._setup_db(tmpdir)
            output = Path(tmpdir) / "export"
            ids = self._create_task_with_criteria_events(db_path)

            proc = self._run_workerctl(
                "export-task",
                "criteria-replay-task",
                "--output",
                str(output),
                "--zip",
                "--path",
                str(db_path),
            )

            self.assertEqual(proc.returncode, 0, proc.stderr)
            criteria_path = output / "acceptance-criteria.json"
            self.assertTrue(criteria_path.exists())
            criteria = json.loads(criteria_path.read_text())
            self.assertEqual({row["id"] for row in criteria}, {ids["proposed_id"], ids["deferred_id"]})
            manifest = json.loads((output / "manifest.json").read_text())
            self.assertIn("acceptance-criteria.json", manifest["files"])
            with zipfile.ZipFile(output.with_suffix(".zip")) as archive:
                self.assertIn("acceptance-criteria.json", archive.namelist())


class PairCommandTests(unittest.TestCase):
    def _setup_db(self, tmpdir):
        db_path = Path(tmpdir) / "workerctl.db"
        conn = worker_db.connect(db_path)
        worker_db.initialize_database(conn)
        conn.close()
        return db_path

    def test_pair_creates_task_when_goal_provided_and_task_missing(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = self._setup_db(tmpdir)
            args = argparse.Namespace(
                task="new-pair-task",
                worker_name="w1",
                manager_name="m1",
                cwd=tmpdir,
                task_prompt=None,
                task_goal="Build a thing",
                task_summary=None,
                sandbox="danger-full-access",
                ask_for_approval="never",
                timeout_seconds=30,
                path=str(db_path),
            )

            def fake_spawn(*, name, role, **kwargs):
                # Register the session in the DB so bind_sessions can find it later
                conn = worker_db.connect(db_path)
                worker_db.initialize_database(conn)
                try:
                    session_id = worker_db.register_session(
                        conn,
                        name=name,
                        role=role,
                        codex_session_path=f"/tmp/{name}.jsonl",
                        codex_session_id=f"codex-id-{name}",
                        pid=10000 + hash(name) % 1000,
                        cwd=kwargs.get("cwd", "/tmp"),
                        tmux_session=f"codex-{name}",
                    )
                    conn.commit()
                finally:
                    conn.close()

                return {
                    "name": name,
                    "role": role,
                    "session_id": session_id,
                    "pid": 10000 + hash(name) % 1000,
                    "tmux_session": f"codex-{name}",
                    "codex_session_path": f"/tmp/{name}.jsonl",
                    "codex_session_id": f"codex-id-{name}",
                    "cwd": kwargs.get("cwd", "/tmp"),
                }

            with mock.patch.object(
                commands,
                "_spawn_codex_and_register",
                side_effect=fake_spawn,
            ):
                stdout_capture = io.StringIO()
                with contextlib.redirect_stdout(stdout_capture):
                    result = commands.command_pair(args)
            self.assertEqual(result, 0)

            # Verify task was created
            conn = worker_db.connect(db_path)
            try:
                task_row = worker_db.task_row(conn, task="new-pair-task")
                self.assertEqual(task_row["name"], "new-pair-task")
                self.assertEqual(task_row["goal"], "Build a thing")
            finally:
                conn.close()

    def test_pair_uses_existing_task(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = self._setup_db(tmpdir)
            conn = worker_db.connect(db_path)
            task_id = worker_db.create_task(
                conn, name="existing-task", goal="Do x", summary=None
            )
            conn.commit()
            conn.close()

            args = argparse.Namespace(
                task="existing-task",
                worker_name="w1",
                manager_name="m1",
                cwd=tmpdir,
                task_prompt=None,
                task_goal=None,
                task_summary=None,
                sandbox="danger-full-access",
                ask_for_approval="never",
                timeout_seconds=30,
                path=str(db_path),
            )

            def fake_spawn(*, name, role, **kwargs):
                conn = worker_db.connect(db_path)
                worker_db.initialize_database(conn)
                try:
                    session_id = worker_db.register_session(
                        conn,
                        name=name,
                        role=role,
                        codex_session_path=f"/tmp/{name}.jsonl",
                        codex_session_id=f"codex-id-{name}",
                        pid=10000 + hash(name) % 1000,
                        cwd=kwargs.get("cwd", "/tmp"),
                        tmux_session=f"codex-{name}",
                    )
                    conn.commit()
                finally:
                    conn.close()

                return {
                    "name": name,
                    "role": role,
                    "session_id": session_id,
                    "pid": 10000 + hash(name) % 1000,
                    "tmux_session": f"codex-{name}",
                    "codex_session_path": f"/tmp/{name}.jsonl",
                    "codex_session_id": f"codex-id-{name}",
                    "cwd": kwargs.get("cwd", "/tmp"),
                }

            with mock.patch.object(
                commands,
                "_spawn_codex_and_register",
                side_effect=fake_spawn,
            ):
                stdout_capture = io.StringIO()
                with contextlib.redirect_stdout(stdout_capture):
                    result = commands.command_pair(args)
            self.assertEqual(result, 0)

    def test_pair_fails_when_task_missing_and_no_goal_provided(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = self._setup_db(tmpdir)
            args = argparse.Namespace(
                task="missing-task",
                worker_name="w1",
                manager_name="m1",
                cwd=tmpdir,
                task_prompt=None,
                task_goal=None,
                task_summary=None,
                sandbox="danger-full-access",
                ask_for_approval="never",
                timeout_seconds=30,
                path=str(db_path),
            )
            with self.assertRaises(WorkerError) as ctx:
                commands.command_pair(args)
            self.assertIn("--task-goal", str(ctx.exception))

    def test_pair_passes_task_prompt_to_worker_only(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = self._setup_db(tmpdir)
            recorded = []

            def recorder(*, name, role, task=None, initial_prompt=None, **kwargs):
                recorded.append({"name": name, "role": role, "task": task, "initial_prompt": initial_prompt})
                # Still need to register the session
                conn = worker_db.connect(db_path)
                worker_db.initialize_database(conn)
                try:
                    session_id = worker_db.register_session(
                        conn,
                        name=name,
                        role=role,
                        codex_session_path=f"/tmp/{name}.jsonl",
                        codex_session_id=f"codex-id-{name}",
                        pid=10000 + hash(name) % 1000,
                        cwd=kwargs.get("cwd", "/tmp"),
                        tmux_session=f"codex-{name}",
                    )
                    conn.commit()
                finally:
                    conn.close()

                return {
                    "name": name,
                    "role": role,
                    "session_id": session_id,
                    "pid": 10000 + hash(name) % 1000,
                    "tmux_session": f"codex-{name}",
                    "codex_session_path": f"/tmp/{name}.jsonl",
                    "codex_session_id": f"codex-id-{name}",
                    "cwd": kwargs.get("cwd", "/tmp"),
                }

            args = argparse.Namespace(
                task="prompt-task",
                worker_name="w1",
                manager_name="m1",
                cwd=tmpdir,
                task_prompt="Do the thing",
                task_goal="Build a thing",
                task_summary=None,
                sandbox="danger-full-access",
                ask_for_approval="never",
                timeout_seconds=30,
                path=str(db_path),
            )
            with mock.patch.object(commands, "_spawn_codex_and_register", side_effect=recorder):
                stdout_capture = io.StringIO()
                with contextlib.redirect_stdout(stdout_capture):
                    commands.command_pair(args)
            worker_spawn = next(r for r in recorded if r["role"] == "worker")
            manager_spawn = next(r for r in recorded if r["role"] == "manager")
            self.assertEqual(worker_spawn["task"], "Do the thing")
            self.assertIsNone(manager_spawn["task"])
            self.assertIn("manager-config prompt-task --questions", manager_spawn["initial_prompt"])
            self.assertIn("Task goal: Build a thing", manager_spawn["initial_prompt"])
            self.assertIn("Worker session: w1", manager_spawn["initial_prompt"])
            self.assertIn("acceptance criteria as living supervision state", manager_spawn["initial_prompt"])
            self.assertIn("manager_context.acceptance_criteria", manager_spawn["initial_prompt"])
            self.assertIn("must-have vs follow-up criteria", manager_spawn["initial_prompt"])
            self.assertIn("scripts/workerctl criteria", manager_spawn["initial_prompt"])
            self.assertIn(
                "compare worker receipts/verification against accepted open criteria",
                manager_spawn["initial_prompt"],
            )
            self.assertNotIn("Do the thing", manager_spawn["initial_prompt"])

    def test_pair_subparser_exists(self):
        proc = subprocess.run(
            [sys.executable, "-m", "workerctl", "pair", "--help"],
            capture_output=True,
            text=True,
            cwd=str(ROOT),
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)
        for flag in (
            "--task",
            "--worker-name",
            "--manager-name",
            "--task-prompt",
            "--task-goal",
        ):
            self.assertIn(flag, proc.stdout)

    def test_handoff_command_records_summary(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = self._setup_db(tmpdir)
            conn = worker_db.connect(db_path)
            try:
                worker_db.create_task(conn, name="handoff-task", goal="Do handoff.")
                conn.commit()
            finally:
                conn.close()

            proc = subprocess.run(
                [
                    sys.executable,
                    "-m",
                    "workerctl",
                    "handoff",
                    "handoff-task",
                    "--summary",
                    "Worker finished discovery.",
                    "--next-step",
                    "Implement command",
                    "--payload-json",
                    '{"branch":"feature"}',
                    "--path",
                    str(db_path),
                ],
                capture_output=True,
                text=True,
                cwd=str(ROOT),
            )

            self.assertEqual(proc.returncode, 0, proc.stderr)
            payload = json.loads(proc.stdout)
            self.assertEqual(payload["summary"], "Worker finished discovery.")
            self.assertEqual(payload["next_steps"], ["Implement command"])
            self.assertEqual(payload["payload"], {"branch": "feature"})

    def test_manager_config_command_records_policy(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = self._setup_db(tmpdir)
            conn = worker_db.connect(db_path)
            try:
                worker_db.create_task(conn, name="config-task", goal="Do config.")
                conn.commit()
            finally:
                conn.close()

            proc = subprocess.run(
                [
                    sys.executable,
                    "-m",
                    "workerctl",
                    "manager-config",
                    "config-task",
                    "--mode",
                    "strict",
                    "--objective",
                    "Check against docs/plan.md",
                    "--guideline",
                    "Nudge only when stale",
                    "--acceptance",
                    "Tests pass",
                    "--reference",
                    "docs/plan.md",
                    "--allow-pr",
                    "--allow-worker-compact-clear",
                    "--path",
                    str(db_path),
                ],
                capture_output=True,
                text=True,
                cwd=str(ROOT),
            )

            self.assertEqual(proc.returncode, 0, proc.stderr)
            payload = json.loads(proc.stdout)
            self.assertEqual(payload["supervision_mode"], "strict")
            self.assertEqual(payload["objective"], "Check against docs/plan.md")
            self.assertEqual(payload["guidelines"], ["Nudge only when stale"])
            self.assertEqual(payload["acceptance_criteria"], ["Tests pass"])
            self.assertEqual(payload["reference_paths"], ["docs/plan.md"])
            self.assertTrue(payload["permissions"]["create_pr"])
            self.assertTrue(payload["permissions"]["worker_compact_clear"])

    def test_manager_config_questions_prints_setup_schema(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = self._setup_db(tmpdir)
            conn = worker_db.connect(db_path)
            try:
                worker_db.create_task(conn, name="question-task", goal="Do config.")
                conn.commit()
            finally:
                conn.close()

            proc = subprocess.run(
                [
                    sys.executable,
                    "-m",
                    "workerctl",
                    "manager-config",
                    "question-task",
                    "--questions",
                    "--path",
                    str(db_path),
                ],
                capture_output=True,
                text=True,
                cwd=str(ROOT),
            )

            self.assertEqual(proc.returncode, 0, proc.stderr)
            payload = json.loads(proc.stdout)
            self.assertEqual(payload["recommended_collection"], "manager_codex_chat")
            question_ids = {question["id"] for question in payload["questions"]}
            self.assertIn("supervision_mode", question_ids)
            self.assertIn("permissions", question_ids)

            conn = worker_db.connect(db_path)
            try:
                task = worker_db.task_row(conn, task="question-task")
                self.assertIsNone(worker_db.manager_config(conn, task_id=task["id"]))
            finally:
                conn.close()

    def test_manager_config_interactive_records_answers_from_stdin(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = self._setup_db(tmpdir)
            conn = worker_db.connect(db_path)
            try:
                worker_db.create_task(conn, name="interactive-config-task", goal="Do config.")
                conn.commit()
            finally:
                conn.close()

            answers = "\n".join(
                [
                    "strict",
                    "Check against docs/plan.md",
                    "Nudge only when stale, Keep scope fixed",
                    "Tests pass, PR opened",
                    "docs/plan.md, https://example.test/mockup",
                    "yes",
                    "no",
                    "yes",
                    "",
                ]
            )
            proc = subprocess.run(
                [
                    sys.executable,
                    "-m",
                    "workerctl",
                    "manager-config",
                    "interactive-config-task",
                    "--interactive",
                    "--path",
                    str(db_path),
                ],
                input=answers,
                capture_output=True,
                text=True,
                cwd=str(ROOT),
            )

            self.assertEqual(proc.returncode, 0, proc.stderr)
            payload = json.loads(proc.stdout[proc.stdout.index("{"):])
            self.assertEqual(payload["supervision_mode"], "strict")
            self.assertEqual(payload["objective"], "Check against docs/plan.md")
            self.assertEqual(payload["guidelines"], ["Nudge only when stale", "Keep scope fixed"])
            self.assertEqual(payload["acceptance_criteria"], ["Tests pass", "PR opened"])
            self.assertEqual(payload["reference_paths"], ["docs/plan.md", "https://example.test/mockup"])
            self.assertTrue(payload["permissions"]["create_pr"])
            self.assertFalse(payload["permissions"]["merge_green_pr"])
            self.assertTrue(payload["permissions"]["worker_compact_clear"])

    def test_manager_config_interactive_can_clear_existing_permissions(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = self._setup_db(tmpdir)
            conn = worker_db.connect(db_path)
            try:
                task_id = worker_db.create_task(conn, name="interactive-clear-task", goal="Do config.")
                worker_db.upsert_manager_config(
                    conn,
                    task_id=task_id,
                    supervision_mode="strict",
                    permissions={
                        "create_pr": True,
                        "merge_green_pr": True,
                        "worker_compact_clear": True,
                    },
                )
                conn.commit()
            finally:
                conn.close()

            answers = "\n".join(
                [
                    "",
                    "",
                    "",
                    "",
                    "",
                    "no",
                    "no",
                    "no",
                    "",
                ]
            )
            proc = subprocess.run(
                [
                    sys.executable,
                    "-m",
                    "workerctl",
                    "manager-config",
                    "interactive-clear-task",
                    "--interactive",
                    "--path",
                    str(db_path),
                ],
                input=answers,
                capture_output=True,
                text=True,
                cwd=str(ROOT),
            )

            self.assertEqual(proc.returncode, 0, proc.stderr)
            payload = json.loads(proc.stdout[proc.stdout.index("{"):])
            self.assertFalse(payload["permissions"]["create_pr"])
            self.assertFalse(payload["permissions"]["merge_green_pr"])
            self.assertFalse(payload["permissions"]["worker_compact_clear"])

    def test_manager_permission_checks_saved_policy(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = self._setup_db(tmpdir)
            conn = worker_db.connect(db_path)
            try:
                task_id = worker_db.create_task(conn, name="permission-task", goal="Do config.")
                worker_db.upsert_manager_config(
                    conn,
                    task_id=task_id,
                    supervision_mode="guided",
                    permissions={"create_pr": False, "worker_compact_clear": True},
                )
                conn.commit()
            finally:
                conn.close()

            allowed = subprocess.run(
                [
                    sys.executable,
                    "-m",
                    "workerctl",
                    "manager-permission",
                    "permission-task",
                    "worker_compact_clear",
                    "--path",
                    str(db_path),
                ],
                capture_output=True,
                text=True,
                cwd=str(ROOT),
            )
            self.assertEqual(allowed.returncode, 0, allowed.stderr)
            allowed_payload = json.loads(allowed.stdout)
            self.assertTrue(allowed_payload["allowed"])
            self.assertEqual(allowed_payload["reasons"], [])

            denied = subprocess.run(
                [
                    sys.executable,
                    "-m",
                    "workerctl",
                    "manager-permission",
                    "permission-task",
                    "create_pr",
                    "--require",
                    "--path",
                    str(db_path),
                ],
                capture_output=True,
                text=True,
                cwd=str(ROOT),
            )
            self.assertEqual(denied.returncode, 1)
            denied_payload = json.loads(denied.stdout)
            self.assertFalse(denied_payload["allowed"])
            self.assertIn("permission_not_enabled", denied_payload["reasons"])

    def test_manager_permission_can_require_handoff(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = self._setup_db(tmpdir)
            conn = worker_db.connect(db_path)
            try:
                task_id = worker_db.create_task(conn, name="handoff-permission-task", goal="Do config.")
                worker_db.upsert_manager_config(
                    conn,
                    task_id=task_id,
                    supervision_mode="guided",
                    permissions={"worker_compact_clear": True},
                )
                conn.commit()
            finally:
                conn.close()

            missing = subprocess.run(
                [
                    sys.executable,
                    "-m",
                    "workerctl",
                    "manager-permission",
                    "handoff-permission-task",
                    "worker_compact_clear",
                    "--require-handoff",
                    "--require",
                    "--path",
                    str(db_path),
                ],
                capture_output=True,
                text=True,
                cwd=str(ROOT),
            )
            self.assertEqual(missing.returncode, 1)
            self.assertIn("missing_worker_handoff", json.loads(missing.stdout)["reasons"])

            conn = worker_db.connect(db_path)
            try:
                task = worker_db.task_row(conn, task="handoff-permission-task")
                worker_db.insert_worker_handoff(
                    conn,
                    task_id=task["id"],
                    summary="Ready to compact.",
                )
                conn.commit()
            finally:
                conn.close()

            present = subprocess.run(
                [
                    sys.executable,
                    "-m",
                    "workerctl",
                    "manager-permission",
                    "handoff-permission-task",
                    "worker_compact_clear",
                    "--require-handoff",
                    "--require",
                    "--path",
                    str(db_path),
                ],
                capture_output=True,
                text=True,
                cwd=str(ROOT),
            )
            self.assertEqual(present.returncode, 0, present.stderr)
            payload = json.loads(present.stdout)
            self.assertTrue(payload["allowed"])
            self.assertIsNotNone(payload["handoff_id"])

    def test_record_decision_persists_decision_and_payload(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = self._setup_db(tmpdir)
            conn = worker_db.connect(db_path)
            try:
                worker_db.create_task(conn, name="decision-task", goal="Do config.")
                worker_db.register_session(
                    conn,
                    name="decision-worker",
                    role="worker",
                    codex_session_path="/tmp/worker.jsonl",
                    codex_session_id="worker-session",
                    pid=123,
                    cwd=tmpdir,
                    tmux_session="codex-decision-worker",
                )
                worker_db.register_session(
                    conn,
                    name="decision-manager",
                    role="manager",
                    codex_session_path="/tmp/manager.jsonl",
                    codex_session_id="manager-session",
                    pid=124,
                    cwd=tmpdir,
                    tmux_session="codex-decision-manager",
                )
                worker_db.bind_sessions(
                    conn,
                    task_name="decision-task",
                    worker_session_name="decision-worker",
                    manager_session_name="decision-manager",
                )
                conn.commit()
            finally:
                conn.close()

            proc = subprocess.run(
                [
                    sys.executable,
                    "-m",
                    "workerctl",
                    "record-decision",
                    "decision-task",
                    "nudge",
                    "--reason",
                    "Worker is idle and needs the next step.",
                    "--payload-json",
                    '{"source":"test"}',
                    "--path",
                    str(db_path),
                ],
                capture_output=True,
                text=True,
                cwd=str(ROOT),
            )

            self.assertEqual(proc.returncode, 0, proc.stderr)
            payload = json.loads(proc.stdout)
            self.assertEqual(payload["decision"], "nudge")
            self.assertIsNone(payload["manager_id"])
            self.assertEqual(payload["payload"], {"source": "test"})
            self.assertEqual(payload["reason"], "Worker is idle and needs the next step.")

            conn = worker_db.connect(db_path)
            try:
                audit = worker_db.task_audit(conn, task="decision-task")
                decisions = audit["manager_decisions"]
                self.assertEqual(len(decisions), 1)
                self.assertEqual(decisions[0]["id"], payload["id"])
                self.assertEqual(decisions[0]["payload"], {"source": "test"})
                events = [row for row in audit["events"] if row["type"] == "manager_decision_recorded"]
                self.assertEqual(len(events), 1)
                self.assertEqual(events[0]["payload"]["decision_id"], payload["id"])
            finally:
                conn.close()

    def test_record_decision_rejects_non_object_payload(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = self._setup_db(tmpdir)
            conn = worker_db.connect(db_path)
            try:
                worker_db.create_task(conn, name="decision-bad-payload", goal="Do config.")
                conn.commit()
            finally:
                conn.close()

            proc = subprocess.run(
                [
                    sys.executable,
                    "-m",
                    "workerctl",
                    "record-decision",
                    "decision-bad-payload",
                    "nudge",
                    "--reason",
                    "Need a nudge.",
                    "--payload-json",
                    '["not-object"]',
                    "--path",
                    str(db_path),
                ],
                capture_output=True,
                text=True,
                cwd=str(ROOT),
            )

            self.assertNotEqual(proc.returncode, 0)
            self.assertIn("--payload-json must be a JSON object", proc.stderr)

    def test_request_worker_compact_dry_run_requires_policy_handoff_and_decision(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = self._setup_db(tmpdir)
            conn = worker_db.connect(db_path)
            try:
                task_id = worker_db.create_task(conn, name="compact-task", goal="Do config.")
                worker_db.register_session(
                    conn,
                    name="compact-worker",
                    role="worker",
                    codex_session_path="/tmp/worker.jsonl",
                    codex_session_id="worker-session",
                    pid=123,
                    cwd=tmpdir,
                    tmux_session="codex-compact-worker",
                )
                worker_db.register_session(
                    conn,
                    name="compact-manager",
                    role="manager",
                    codex_session_path="/tmp/manager.jsonl",
                    codex_session_id="manager-session",
                    pid=124,
                    cwd=tmpdir,
                    tmux_session="codex-compact-manager",
                )
                worker_db.bind_sessions(
                    conn,
                    task_name="compact-task",
                    worker_session_name="compact-worker",
                    manager_session_name="compact-manager",
                )
                worker_db.upsert_manager_config(
                    conn,
                    task_id=task_id,
                    supervision_mode="guided",
                    permissions={"worker_compact_clear": True},
                )
                handoff_id = worker_db.insert_worker_handoff(
                    conn,
                    task_id=task_id,
                    summary="Ready to compact.",
                )
                decision_id = worker_db.insert_manager_decision(
                    conn,
                    task_id=task_id,
                    manager_id=None,
                    decision="nudge",
                    reason="Request worker compaction after handoff.",
                )
                conn.commit()
            finally:
                conn.close()

            proc = subprocess.run(
                [
                    sys.executable,
                    "-m",
                    "workerctl",
                    "request-worker-compact",
                    "compact-task",
                    "--decision-id",
                    str(decision_id),
                    "--strict-decisions",
                    "--dry-run",
                    "--path",
                    str(db_path),
                ],
                capture_output=True,
                text=True,
                cwd=str(ROOT),
            )

            self.assertEqual(proc.returncode, 0, proc.stderr)
            payload = json.loads(proc.stdout)
            self.assertEqual(payload["permission_check"]["handoff_id"], handoff_id)
            self.assertTrue(payload["permission_check"]["allowed"])
            self.assertEqual(payload["send_result"]["session"], "compact-worker")
            self.assertTrue(payload["send_result"]["dry_run"])
            self.assertEqual(payload["slash_command"], "/compact")
            self.assertEqual(payload["send_text"], "/compact")
            self.assertEqual(payload["send_result"]["text"], "/compact")
            self.assertIn("verify the saved handoff", payload["message"])

            conn = worker_db.connect(db_path)
            try:
                audit = worker_db.task_audit(conn, task="compact-task")
                command = [row for row in audit["commands"] if row["type"] == "request_worker_compact"][0]
                self.assertEqual(command["state"], "succeeded")
                events = [row["type"] for row in audit["events"]]
                self.assertIn("worker_compact_requested", events)
                self.assertIn("worker_compact_request_succeeded", events)
            finally:
                conn.close()

    def test_request_worker_compact_strict_decision_failure_records_failed_command(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = self._setup_db(tmpdir)
            conn = worker_db.connect(db_path)
            try:
                task_id = worker_db.create_task(conn, name="compact-missing-decision", goal="Do config.")
                worker_db.register_session(
                    conn,
                    name="compact-worker",
                    role="worker",
                    codex_session_path="/tmp/worker.jsonl",
                    codex_session_id="worker-session",
                    pid=123,
                    cwd=tmpdir,
                    tmux_session="codex-compact-worker",
                )
                worker_db.register_session(
                    conn,
                    name="compact-manager",
                    role="manager",
                    codex_session_path="/tmp/manager.jsonl",
                    codex_session_id="manager-session",
                    pid=124,
                    cwd=tmpdir,
                    tmux_session="codex-compact-manager",
                )
                worker_db.bind_sessions(
                    conn,
                    task_name="compact-missing-decision",
                    worker_session_name="compact-worker",
                    manager_session_name="compact-manager",
                )
                worker_db.upsert_manager_config(
                    conn,
                    task_id=task_id,
                    supervision_mode="guided",
                    permissions={"worker_compact_clear": True},
                )
                worker_db.insert_worker_handoff(
                    conn,
                    task_id=task_id,
                    summary="Ready to compact.",
                )
                conn.commit()
            finally:
                conn.close()

            proc = subprocess.run(
                [
                    sys.executable,
                    "-m",
                    "workerctl",
                    "request-worker-compact",
                    "compact-missing-decision",
                    "--strict-decisions",
                    "--dry-run",
                    "--path",
                    str(db_path),
                ],
                capture_output=True,
                text=True,
                cwd=str(ROOT),
            )

            self.assertNotEqual(proc.returncode, 0)
            self.assertIn("manager_decision_validation_failed", proc.stderr)
            conn = worker_db.connect(db_path)
            try:
                audit = worker_db.task_audit(conn, task="compact-missing-decision")
                command = [row for row in audit["commands"] if row["type"] == "request_worker_compact"][0]
                self.assertEqual(command["state"], "failed")
                self.assertTrue(command["result"]["expected_failure"])
                self.assertEqual(command["result"]["failure_stage"], "preflight")
                self.assertIn("missing_decision_id", command["result"]["manager_decision"]["warnings"])
                events = [row["type"] for row in audit["events"]]
                self.assertIn("worker_compact_request_failed", events)
            finally:
                conn.close()

    def test_compact_worker_records_decision_and_requests_compact(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = self._setup_db(tmpdir)
            conn = worker_db.connect(db_path)
            try:
                task_id = worker_db.create_task(conn, name="compact-one-shot", goal="Do config.")
                worker_db.register_session(
                    conn,
                    name="compact-one-shot-worker",
                    role="worker",
                    codex_session_path="/tmp/worker.jsonl",
                    codex_session_id="worker-session",
                    pid=123,
                    cwd=tmpdir,
                    tmux_session="codex-compact-one-shot-worker",
                )
                worker_db.register_session(
                    conn,
                    name="compact-one-shot-manager",
                    role="manager",
                    codex_session_path="/tmp/manager.jsonl",
                    codex_session_id="manager-session",
                    pid=124,
                    cwd=tmpdir,
                    tmux_session="codex-compact-one-shot-manager",
                )
                worker_db.bind_sessions(
                    conn,
                    task_name="compact-one-shot",
                    worker_session_name="compact-one-shot-worker",
                    manager_session_name="compact-one-shot-manager",
                )
                worker_db.upsert_manager_config(
                    conn,
                    task_id=task_id,
                    supervision_mode="guided",
                    permissions={"worker_compact_clear": True},
                )
                handoff_id = worker_db.insert_worker_handoff(
                    conn,
                    task_id=task_id,
                    summary="Ready to compact.",
                )
                conn.commit()
            finally:
                conn.close()

            proc = subprocess.run(
                [
                    sys.executable,
                    "-m",
                    "workerctl",
                    "compact-worker",
                    "compact-one-shot",
                    "--reason",
                    "Compact after saved handoff.",
                    "--dry-run",
                    "--path",
                    str(db_path),
                ],
                capture_output=True,
                text=True,
                cwd=str(ROOT),
            )

            self.assertEqual(proc.returncode, 0, proc.stderr)
            payload = json.loads(proc.stdout)
            self.assertEqual(payload["permission_check"]["handoff_id"], handoff_id)
            self.assertEqual(payload["slash_command"], "/compact")
            self.assertEqual(payload["send_text"], "/compact")
            self.assertEqual(payload["send_result"]["text"], "/compact")
            self.assertTrue(payload["manager_decision"]["ok"])
            decision_id = payload["manager_decision"]["decision_id"]

            conn = worker_db.connect(db_path)
            try:
                audit = worker_db.task_audit(conn, task="compact-one-shot")
                decisions = audit["manager_decisions"]
                self.assertEqual(len(decisions), 1)
                self.assertEqual(decisions[0]["id"], decision_id)
                self.assertEqual(decisions[0]["decision"], "nudge")
                self.assertEqual(decisions[0]["payload"]["source"], "compact-worker")
                command = [row for row in audit["commands"] if row["type"] == "request_worker_compact"][0]
                self.assertEqual(command["state"], "succeeded")
                self.assertEqual(command["payload"]["manager_decision"]["decision_id"], decision_id)
                events = [row["type"] for row in audit["events"]]
                self.assertIn("manager_decision_recorded", events)
                self.assertIn("worker_compact_request_succeeded", events)
            finally:
                conn.close()

    def test_compact_worker_clear_sends_clear(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = self._setup_db(tmpdir)
            conn = worker_db.connect(db_path)
            try:
                task_id = worker_db.create_task(conn, name="clear-one-shot", goal="Do config.")
                worker_db.register_session(
                    conn,
                    name="clear-one-shot-worker",
                    role="worker",
                    codex_session_path="/tmp/worker.jsonl",
                    codex_session_id="worker-session",
                    pid=123,
                    cwd=tmpdir,
                    tmux_session="codex-clear-one-shot-worker",
                )
                worker_db.register_session(
                    conn,
                    name="clear-one-shot-manager",
                    role="manager",
                    codex_session_path="/tmp/manager.jsonl",
                    codex_session_id="manager-session",
                    pid=124,
                    cwd=tmpdir,
                    tmux_session="codex-clear-one-shot-manager",
                )
                worker_db.bind_sessions(
                    conn,
                    task_name="clear-one-shot",
                    worker_session_name="clear-one-shot-worker",
                    manager_session_name="clear-one-shot-manager",
                )
                worker_db.upsert_manager_config(
                    conn,
                    task_id=task_id,
                    supervision_mode="guided",
                    permissions={"worker_compact_clear": True},
                )
                worker_db.insert_worker_handoff(
                    conn,
                    task_id=task_id,
                    summary="Ready to clear.",
                )
                conn.commit()
            finally:
                conn.close()

            proc = subprocess.run(
                [
                    sys.executable,
                    "-m",
                    "workerctl",
                    "compact-worker",
                    "clear-one-shot",
                    "--reason",
                    "Clear throwaway worker after saved handoff.",
                    "--clear",
                    "--dry-run",
                    "--path",
                    str(db_path),
                ],
                capture_output=True,
                text=True,
                cwd=str(ROOT),
            )

            self.assertEqual(proc.returncode, 0, proc.stderr)
            payload = json.loads(proc.stdout)
            self.assertEqual(payload["slash_command"], "/clear")
            self.assertEqual(payload["send_text"], "/clear")
            self.assertEqual(payload["send_result"]["text"], "/clear")

    def test_request_worker_compact_can_send_clear_or_prompt_only(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = self._setup_db(tmpdir)
            conn = worker_db.connect(db_path)
            try:
                task_id = worker_db.create_task(conn, name="compact-action-task", goal="Do config.")
                worker_db.register_session(
                    conn,
                    name="compact-action-worker",
                    role="worker",
                    codex_session_path="/tmp/worker.jsonl",
                    codex_session_id="worker-session",
                    pid=123,
                    cwd=tmpdir,
                    tmux_session="codex-compact-action-worker",
                )
                worker_db.register_session(
                    conn,
                    name="compact-action-manager",
                    role="manager",
                    codex_session_path="/tmp/manager.jsonl",
                    codex_session_id="manager-session",
                    pid=124,
                    cwd=tmpdir,
                    tmux_session="codex-compact-action-manager",
                )
                worker_db.bind_sessions(
                    conn,
                    task_name="compact-action-task",
                    worker_session_name="compact-action-worker",
                    manager_session_name="compact-action-manager",
                )
                worker_db.upsert_manager_config(
                    conn,
                    task_id=task_id,
                    supervision_mode="guided",
                    permissions={"worker_compact_clear": True},
                )
                worker_db.insert_worker_handoff(
                    conn,
                    task_id=task_id,
                    summary="Ready to compact.",
                )
                clear_decision_id = worker_db.insert_manager_decision(
                    conn,
                    task_id=task_id,
                    manager_id=None,
                    decision="nudge",
                    reason="Request worker clear after handoff.",
                )
                prompt_decision_id = worker_db.insert_manager_decision(
                    conn,
                    task_id=task_id,
                    manager_id=None,
                    decision="nudge",
                    reason="Request worker prompt after handoff.",
                )
                conn.commit()
            finally:
                conn.close()

            clear_proc = subprocess.run(
                [
                    sys.executable,
                    "-m",
                    "workerctl",
                    "request-worker-compact",
                    "compact-action-task",
                    "--decision-id",
                    str(clear_decision_id),
                    "--strict-decisions",
                    "--clear",
                    "--dry-run",
                    "--path",
                    str(db_path),
                ],
                capture_output=True,
                text=True,
                cwd=str(ROOT),
            )

            self.assertEqual(clear_proc.returncode, 0, clear_proc.stderr)
            clear_payload = json.loads(clear_proc.stdout)
            self.assertEqual(clear_payload["slash_command"], "/clear")
            self.assertEqual(clear_payload["send_text"], "/clear")
            self.assertEqual(clear_payload["send_result"]["text"], "/clear")

            prompt_proc = subprocess.run(
                [
                    sys.executable,
                    "-m",
                    "workerctl",
                    "request-worker-compact",
                    "compact-action-task",
                    "--decision-id",
                    str(prompt_decision_id),
                    "--strict-decisions",
                    "--prompt-only",
                    "--dry-run",
                    "--path",
                    str(db_path),
                ],
                capture_output=True,
                text=True,
                cwd=str(ROOT),
            )

            self.assertEqual(prompt_proc.returncode, 0, prompt_proc.stderr)
            prompt_payload = json.loads(prompt_proc.stdout)
            self.assertIsNone(prompt_payload["slash_command"])
            self.assertIn("verify the saved handoff", prompt_payload["send_text"])
            self.assertEqual(prompt_payload["send_result"]["text"], prompt_payload["send_text"])

    def test_request_worker_compact_fails_closed_without_handoff(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = self._setup_db(tmpdir)
            conn = worker_db.connect(db_path)
            try:
                task_id = worker_db.create_task(conn, name="compact-no-handoff", goal="Do config.")
                worker_db.register_session(
                    conn,
                    name="compact-worker",
                    role="worker",
                    codex_session_path="/tmp/worker.jsonl",
                    codex_session_id="worker-session",
                    pid=123,
                    cwd=tmpdir,
                    tmux_session="codex-compact-worker",
                )
                worker_db.register_session(
                    conn,
                    name="compact-manager",
                    role="manager",
                    codex_session_path="/tmp/manager.jsonl",
                    codex_session_id="manager-session",
                    pid=124,
                    cwd=tmpdir,
                    tmux_session="codex-compact-manager",
                )
                worker_db.bind_sessions(
                    conn,
                    task_name="compact-no-handoff",
                    worker_session_name="compact-worker",
                    manager_session_name="compact-manager",
                )
                worker_db.upsert_manager_config(
                    conn,
                    task_id=task_id,
                    supervision_mode="guided",
                    permissions={"worker_compact_clear": True},
                )
                decision_id = worker_db.insert_manager_decision(
                    conn,
                    task_id=task_id,
                    manager_id=None,
                    decision="nudge",
                    reason="Request worker compaction.",
                )
                conn.commit()
            finally:
                conn.close()

            proc = subprocess.run(
                [
                    sys.executable,
                    "-m",
                    "workerctl",
                    "request-worker-compact",
                    "compact-no-handoff",
                    "--decision-id",
                    str(decision_id),
                    "--strict-decisions",
                    "--dry-run",
                    "--path",
                    str(db_path),
                ],
                capture_output=True,
                text=True,
                cwd=str(ROOT),
            )

            self.assertNotEqual(proc.returncode, 0)
            self.assertIn("missing_worker_handoff", proc.stderr)


if __name__ == "__main__":
    unittest.main()
