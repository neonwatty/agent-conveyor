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
from pathlib import Path

from workerctl import classify
from workerctl import commands
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

    def test_list_json_outputs_json_array(self):
        proc = self.run_workerctl("list", "--json")

        self.assertEqual(proc.returncode, 0, proc.stderr)
        data = json.loads(proc.stdout)
        self.assertIsInstance(data, list)

    def test_manager_prompt_includes_task_health(self):
        prompt = lifecycle.build_manager_prompt(
            task_name="task-a",
            goal="Do task A.",
            summary="Worker is waiting.",
            manager_instructions=None,
            worker_name="worker-a",
            budget={"expires_at": "2026-05-10T00:00:00Z", "max_nudges": 3},
            source_snapshot={},
        )

        self.assertIn("workerctl task-health task-a --json", prompt)
        self.assertIn("workerctl manager-observe task-a --compact --json", prompt)
        self.assertIn("Run task-health first", prompt)
        self.assertIn("Do not run mutating commands merely because they are listed.", prompt)
        self.assertIn("Use task-interrupt only when manager-observe or task-idle-check shows a clear busy_wait", prompt)
        self.assertIn("workerctl finish-task task-a --reason", prompt)
        self.assertIn("After finish-task succeeds, stop all supervision loops.", prompt)
        self.assertIn("replay command", prompt)

    def test_doctor_outputs_expected_structure(self):
        proc = self.run_workerctl("doctor")

        data = json.loads(proc.stdout)
        self.assertIn("checks", data)
        self.assertIn("workers", data)
        self.assertTrue(any(check["name"] == "tmux" for check in data["checks"]))
        self.assertTrue(any(check["name"] == "codex" for check in data["checks"]))

    def test_doctor_self_reports_manage_template_inside_tmux(self):
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
                self.assertTrue(payload["can_promote_in_place"])
                self.assertEqual(payload["recommended_action"], "run_become_managed")
                self.assertIn("workerctl become-managed --session plain-codex", payload["become_managed_command_template"])
                self.assertEqual(payload["become_managed_command_template"], payload["become_managed_recommended_command_template"])
                self.assertIn("workerctl manage --session plain-codex", payload["manage_command_template"])
                self.assertEqual(payload["manage_command_template"], payload["manage_recommended_command_template"])
                self.assertIn("--open-manager", payload["manage_command_template"])
                self.assertFalse(payload["manager_codex_args_required"])
                self.assertEqual(payload["manager_codex_args_recommendation"], "--sandbox danger-full-access --ask-for-approval never")
                self.assertEqual(payload["manager_codex_args_default"], ["--sandbox", "danger-full-access", "--ask-for-approval", "never"])
                self.assertEqual(payload["warnings"], [])
                self.assertIn("worker_name", [value["name"] for value in payload["required_values"]])
                self.assertIn("task_name", [value["name"] for value in payload["required_values"]])
                self.assertIn("goal", [value["name"] for value in payload["required_values"]])
                self.assertIn("Please become managed", payload["example_natural_language_prompt"])
                self.assertIn("workerctl become-managed --session plain-codex", payload["recommended_command"])
                self.assertIn("live tmux session", payload["why_or_why_not"])
                self.assertTrue(any("manage yourself" in mapping["phrases"] for mapping in payload["phrase_mappings"]))
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
            self.assertFalse(payload["can_promote_in_place"])
            self.assertEqual(payload["recommended_action"], "cannot_promote_in_place")
            self.assertIsNone(payload["become_managed_command_template"])
            self.assertIsNone(payload["become_managed_recommended_command_template"])
            self.assertIsNone(payload["manage_command_template"])
            self.assertIsNone(payload["manage_recommended_command_template"])
            self.assertFalse(payload["manager_codex_args_required"])
            self.assertEqual(payload["warnings"], [])
            self.assertIn("workerctl start", payload["recommended_command"])
            self.assertIn("cannot be promoted in place", payload["why_or_why_not"])
        finally:
            commands.current_session_name = original_current_session_name

    def test_explain_managed_flow_outputs_agent_command_mappings(self):
        proc = self.run_workerctl("explain-managed-flow", "--session", "plain-codex", "--json")

        self.assertEqual(proc.returncode, 0, proc.stderr)
        payload = json.loads(proc.stdout)
        self.assertIn("workerctl doctor-self", payload["commands"]["preflight"])
        self.assertIn("workerctl become-managed --session plain-codex", payload["commands"]["become_managed_template"])
        self.assertEqual(payload["commands"]["become_managed_template"], payload["commands"]["become_managed_recommended_template"])
        self.assertIn("worker_name", [value["name"] for value in payload["required_values"]])
        self.assertTrue(any("manage yourself" in mapping["phrases"] and "recommended workerctl become-managed" in mapping["command"] for mapping in payload["phrase_mappings"]))
        self.assertTrue(any("stop supervising me" in mapping["phrases"] and "workerctl unmanage" in mapping["command"] for mapping in payload["phrase_mappings"]))
        self.assertTrue(any("finish this managed task" in mapping["phrases"] and "finish-task" in mapping["command"] for mapping in payload["phrase_mappings"]))
        self.assertIn("Ask for worker_name, task_name, and goal", payload["ask_questions_rule"])

    def test_qa_plan_self_management_outputs_repeatable_steps(self):
        proc = self.run_workerctl("qa-plan", "self-management", "--json")

        self.assertEqual(proc.returncode, 0, proc.stderr)
        payload = json.loads(proc.stdout)
        self.assertEqual(payload["scenario"], "self-management")
        self.assertTrue(any("workerctl start" in step for step in payload["steps"]))
        self.assertTrue(any("extend-nudge-budget" in step for step in payload["steps"]))
        self.assertTrue(any("finish-task" in step for step in payload["steps"]))
        self.assertTrue(any("manager-observe <task> --compact --json" in observation for observation in payload["expected_observations"]))
        self.assertTrue(any("nudge_budget_exhausted" in observation for observation in payload["expected_observations"]))

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

    def test_name_session_registers_current_tmux_session_as_worker(self):
        name = "unit-self-worker"
        worker_path = worker_dir(name)
        if worker_path.exists():
            shutil.rmtree(worker_path)
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "workerctl.db"
            renamed = []
            original_current_session_name = commands.current_session_name
            original_current_pane_id = commands.current_pane_id
            original_session_exists = commands.session_exists
            original_run = commands.run
            original_ensure_tool = commands.ensure_tool
            try:
                commands.ensure_tool = lambda tool: tool
                commands.current_session_name = lambda: "raw-session"
                commands.current_pane_id = lambda target: "%7"
                commands.session_exists = lambda worker_name: False

                def fake_run(argv, **kwargs):
                    if argv[:2] == ["tmux", "rename-session"]:
                        renamed.append(argv)
                    return subprocess.CompletedProcess(argv, 0, "", "")

                commands.run = fake_run
                args = argparse.Namespace(
                    cwd=str(ROOT),
                    force=False,
                    name=name,
                    path=str(db_path),
                    session=None,
                    task="Self-register for manager supervision.",
                )

                with contextlib.redirect_stdout(io.StringIO()) as stdout:
                    result = commands.command_name_session(args)

                payload = json.loads(stdout.getvalue())
                self.assertEqual(result, 0)
                self.assertEqual(payload["name"], name)
                self.assertTrue(payload["renamed"])
                self.assertEqual(payload["tmux_session"], "codex-unit-self-worker")
                self.assertEqual(renamed, [["tmux", "rename-session", "-t", "raw-session", "codex-unit-self-worker"]])
                config = json.loads(config_path(name).read_text())
                self.assertEqual(config["tmux_session"], "codex-unit-self-worker")
                self.assertEqual(config["tmux_pane_id"], "%7")
                self.assertIn(config["identity_token"], (worker_path / "contract.txt").read_text())
                with worker_db.connect(db_path) as conn:
                    worker_db.initialize_database(conn)
                    worker = conn.execute("select * from workers where name = ?", (name,)).fetchone()
                    event = conn.execute("select * from events where worker_id = ? and type = 'worker_session_named'", (worker["id"],)).fetchone()
                    status = conn.execute("select * from statuses where worker_id = ?", (worker["id"],)).fetchone()
                self.assertEqual(worker["state"], "active")
                self.assertNotEqual(worker["id"], name)
                self.assertEqual(worker["id"], config["worker_id"])
                self.assertEqual(worker["tmux_session"], "codex-unit-self-worker")
                self.assertEqual(event["type"], "worker_session_named")
                self.assertEqual(status["current_task"], "Self-register for manager supervision.")
            finally:
                commands.current_session_name = original_current_session_name
                commands.current_pane_id = original_current_pane_id
                commands.session_exists = original_session_exists
                commands.run = original_run
                commands.ensure_tool = original_ensure_tool
                if worker_path.exists():
                    shutil.rmtree(worker_path)

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
                self.assertEqual(payload["become_managed_command_template"], 'workerctl become-managed --session qa-raw --worker <worker-name> --task <task-name> --goal "<goal>" --summary "<summary>" -- \'--model\' \'gpt-5.4-mini\'')
                self.assertEqual(payload["manage_command_template"], 'workerctl manage --session qa-raw --worker <worker-name> --task <task-name> --goal "<goal>" --summary "<summary>" --open-manager -- \'--model\' \'gpt-5.4-mini\'')
                self.assertTrue(payload["start_prompt_sent"])
                self.assertTrue(Path(payload["start_prompt_path"]).exists())
                prompt = Path(payload["start_prompt_path"]).read_text()
                self.assertIn("workerctl tmux session qa-raw", prompt)
                self.assertIn("workerctl become-managed --session qa-raw", prompt)
                self.assertIn("-- '--model' 'gpt-5.4-mini'", prompt)
                self.assertIn("Preserve any arguments after `--`", prompt)
                self.assertIn("workerctl unmanage", prompt)
                self.assertIn("workerctl my-status", prompt)
                self.assertIn("workerctl remanage --open-manager", prompt)
                self.assertIn("workerctl open-manager <task-name>", prompt)
                self.assertIn("If any required field is missing, ask the user", prompt)
                self.assertIn("Do not invent worker name, task name, or goal values", prompt)
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

    def test_name_session_denies_existing_worker_name_from_different_session(self):
        name = "unit-claimed-worker"
        worker_path = worker_dir(name)
        if worker_path.exists():
            shutil.rmtree(worker_path)
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "workerctl.db"
            with worker_db.connect(db_path) as conn:
                worker_db.initialize_database(conn)
                worker_id = worker_db.upsert_worker(
                    conn,
                    name=name,
                    cwd=str(ROOT),
                    tmux_session="codex-existing-worker",
                    state="active",
                )
                conn.commit()
            original_current_session_name = commands.current_session_name
            original_session_exists = commands.session_exists
            original_ensure_tool = commands.ensure_tool
            try:
                commands.ensure_tool = lambda tool: tool
                commands.current_session_name = lambda: "raw-session"
                commands.session_exists = lambda worker_name: False
                args = argparse.Namespace(
                    cwd=str(ROOT),
                    force=False,
                    name=name,
                    path=str(db_path),
                    session=None,
                    task="Attempt duplicate claim.",
                )

                with self.assertRaisesRegex(WorkerError, worker_id):
                    commands.command_name_session(args)
            finally:
                commands.current_session_name = original_current_session_name
                commands.session_exists = original_session_exists
                commands.ensure_tool = original_ensure_tool
                if worker_path.exists():
                    shutil.rmtree(worker_path)

    def test_name_session_force_records_reclaim_event(self):
        name = "unit-reclaimed-worker"
        worker_path = worker_dir(name)
        if worker_path.exists():
            shutil.rmtree(worker_path)
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "workerctl.db"
            with worker_db.connect(db_path) as conn:
                worker_db.initialize_database(conn)
                previous_worker_id = worker_db.upsert_worker(
                    conn,
                    name=name,
                    cwd=str(ROOT),
                    tmux_session="codex-existing-worker",
                    state="active",
                )
                conn.commit()
            original_current_session_name = commands.current_session_name
            original_current_pane_id = commands.current_pane_id
            original_session_exists = commands.session_exists
            original_run = commands.run
            original_ensure_tool = commands.ensure_tool
            try:
                commands.ensure_tool = lambda tool: tool
                commands.current_session_name = lambda: "raw-session"
                commands.current_pane_id = lambda target: "%8"
                commands.session_exists = lambda worker_name: False
                commands.run = lambda argv, **kwargs: subprocess.CompletedProcess(argv, 0, "", "")
                args = argparse.Namespace(
                    cwd=str(ROOT),
                    force=True,
                    name=name,
                    path=str(db_path),
                    session=None,
                    task="Force duplicate claim.",
                )

                with contextlib.redirect_stdout(io.StringIO()) as stdout:
                    result = commands.command_name_session(args)

                payload = json.loads(stdout.getvalue())
                with worker_db.connect(db_path) as conn:
                    worker_db.initialize_database(conn)
                    worker = conn.execute("select * from workers where name = ?", (name,)).fetchone()
                    previous_worker = conn.execute("select * from workers where id = ?", (previous_worker_id,)).fetchone()
                    event = conn.execute("select * from events where worker_id = ? and type = 'worker_name_reclaimed'", (worker["id"],)).fetchone()
                self.assertEqual(result, 0)
                self.assertNotEqual(payload["worker_id"], previous_worker_id)
                self.assertEqual(worker["tmux_session"], f"codex-{name}")
                event_payload = json.loads(event["payload_json"])
                self.assertEqual(event_payload["previous_tmux_session"], "codex-existing-worker")
                self.assertEqual(event_payload["previous_worker_id"], previous_worker_id)
                self.assertTrue(event_payload["replaced_name"].startswith(f"{name}-replaced-"))
                self.assertEqual(previous_worker["name"], event_payload["replaced_name"])
                self.assertEqual(previous_worker["state"], "missing")
            finally:
                commands.current_session_name = original_current_session_name
                commands.current_pane_id = original_current_pane_id
                commands.session_exists = original_session_exists
                commands.run = original_run
                commands.ensure_tool = original_ensure_tool
                if worker_path.exists():
                    shutil.rmtree(worker_path)

    def test_self_promote_infers_worker_from_current_named_session(self):
        original_current_session_name = lifecycle.current_session_name
        original_command_promote = lifecycle.command_promote
        captured = []
        try:
            lifecycle.current_session_name = lambda: "codex-unit-self-worker"

            def fake_promote(args):
                captured.append(args)
                return 0

            lifecycle.command_promote = fake_promote
            args = argparse.Namespace(
                budget_expires_at=None,
                budget_hours=24,
                codex_args=["--model", "gpt-5.4-mini"],
                goal="Let a worker create its own manager.",
                manager_instructions=None,
                max_nudges=2,
                path=None,
                session=None,
                summary="Self promotion test",
                task="unit-self-task",
                worker=None,
            )

            result = lifecycle.command_self_promote(args)

            self.assertEqual(result, 0)
            self.assertEqual(captured[0].worker, "unit-self-worker")
            self.assertEqual(captured[0].task, "unit-self-task")
            self.assertEqual(captured[0].codex_args, ["--model", "gpt-5.4-mini"])
        finally:
            lifecycle.current_session_name = original_current_session_name
            lifecycle.command_promote = original_command_promote

    def test_manage_names_current_session_then_promotes(self):
        original_current_session_name = lifecycle.current_session_name
        original_command_name_session = commands.command_name_session
        original_command_promote = lifecycle.command_promote
        named = []
        promoted = []
        try:
            lifecycle.current_session_name = lambda: "raw-worker-session"

            def fake_name_session(args):
                named.append(args)
                return 0

            def fake_promote(args):
                promoted.append(args)
                return 0

            commands.command_name_session = fake_name_session
            lifecycle.command_promote = fake_promote
            args = argparse.Namespace(
                budget_expires_at=None,
                budget_hours=24,
                codex_args=["--model", "gpt-5.4-mini"],
                cwd=str(ROOT),
                force_name=False,
                goal="Spawn a manager from inside the worker.",
                manager_instructions="Audit before nudging.",
                max_nudges=2,
                path=None,
                session=None,
                summary="Worker is ready.",
                task="unit-managed-task",
                worker="unit-managed-worker",
                worker_task=None,
            )

            result = lifecycle.command_manage(args)

            self.assertEqual(result, 0)
            self.assertEqual(named[0].name, "unit-managed-worker")
            self.assertEqual(named[0].session, "raw-worker-session")
            self.assertEqual(named[0].task, "Worker is ready.")
            self.assertEqual(promoted[0].worker, "unit-managed-worker")
            self.assertEqual(promoted[0].task, "unit-managed-task")
            self.assertEqual(promoted[0].codex_args, ["--model", "gpt-5.4-mini"])
        finally:
            lifecycle.current_session_name = original_current_session_name
            commands.command_name_session = original_command_name_session
            lifecycle.command_promote = original_command_promote

    def test_manage_infers_worker_from_named_current_session(self):
        original_current_session_name = lifecycle.current_session_name
        original_command_name_session = commands.command_name_session
        original_command_promote = lifecycle.command_promote
        named = []
        promoted = []
        try:
            lifecycle.current_session_name = lambda: "codex-unit-managed-worker"
            commands.command_name_session = lambda args: named.append(args) or 0
            lifecycle.command_promote = lambda args: promoted.append(args) or 0
            args = argparse.Namespace(
                budget_expires_at=None,
                budget_hours=24,
                codex_args=[],
                cwd=str(ROOT),
                force_name=False,
                goal="Spawn a manager from inside the worker.",
                manager_instructions=None,
                max_nudges=3,
                path=None,
                session=None,
                summary=None,
                task="unit-managed-task",
                worker=None,
                worker_task="Continue managed work.",
            )

            result = lifecycle.command_manage(args)

            self.assertEqual(result, 0)
            self.assertEqual(named[0].name, "unit-managed-worker")
            self.assertEqual(named[0].session, "codex-unit-managed-worker")
            self.assertEqual(named[0].task, "Continue managed work.")
            self.assertEqual(promoted[0].worker, "unit-managed-worker")
        finally:
            lifecycle.current_session_name = original_current_session_name
            commands.command_name_session = original_command_name_session
            lifecycle.command_promote = original_command_promote

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

    def test_become_managed_delegates_to_manage_with_visible_manager_default(self):
        original_command_manage = lifecycle.command_manage
        managed = []
        try:
            lifecycle.command_manage = lambda args: managed.append(args) or 0
            args = argparse.Namespace(open_manager=True, task="task-a")

            result = lifecycle.command_become_managed(args)

            self.assertEqual(result, 0)
            self.assertEqual(managed[0].task, "task-a")
            self.assertTrue(managed[0].open_manager)
        finally:
            lifecycle.command_manage = original_command_manage

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

    def test_task_events_cli_filters_events(self):
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
                worker_db.insert_event(
                    conn,
                    "task_nudge_intent",
                    actor="test",
                    command_id=command_id,
                    task_id=task_id,
                    payload={"message": "status"},
                )
                worker_db.insert_event(
                    conn,
                    "task_nudge_intent",
                    actor="test",
                    command_id=command_id,
                    task_id=task_id,
                    payload={"message": "continue"},
                )
                conn.commit()

            proc = self.run_workerctl(
                "task-events",
                "task-a",
                "--type",
                "task_nudge_intent",
                "--limit",
                "1",
                "--json",
                "--path",
                str(db_path),
            )

            self.assertEqual(proc.returncode, 0, proc.stderr)
            events = json.loads(proc.stdout)
            self.assertEqual(len(events), 1)
            self.assertEqual(events[0]["type"], "task_nudge_intent")
            self.assertEqual(events[0]["command_id"], command_id)
            self.assertEqual(events[0]["payload"], {"message": "continue"})

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

    def test_promote_parses_worker_options_and_codex_passthrough(self):
        proc = self.run_workerctl(
            "promote",
            "missing-worker",
            "--task",
            "task-a",
            "--goal",
            "Do task A.",
            "--",
            "--model",
            "test",
        )

        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("Unknown worker: missing-worker", proc.stderr)

    def test_bind_task_cli(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "workerctl.db"
            with worker_db.connect(db_path) as conn:
                worker_db.initialize_database(conn)
                worker_id = worker_db.upsert_worker(
                    conn,
                    name="worker-a",
                    cwd=str(ROOT),
                    tmux_session="codex-worker-a",
                    identity_token="token-worker-a",
                    tmux_pane_id="%1",
                    state="active",
                    timestamp="2026-05-08T10:00:00Z",
                )
                worker_db.create_task(
                    conn,
                    name="task-a",
                    goal="Do task A.",
                    task_id="task-a-id",
                    timestamp="2026-05-08T10:00:00Z",
                )
                conn.commit()

            proc = self.run_workerctl("bind-task", "task-a", "--worker", "worker-a", "--path", str(db_path))

            self.assertEqual(proc.returncode, 0, proc.stderr)
            result = json.loads(proc.stdout)
            self.assertEqual(result["task"], "task-a")
            self.assertEqual(result["worker"], "worker-a")
            self.assertTrue(result["binding_id"].startswith("binding-"))

    def test_task_status_cli_json(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "workerctl.db"
            with worker_db.connect(db_path) as conn:
                worker_db.initialize_database(conn)
                worker_id = worker_db.upsert_worker(
                    conn,
                    name="worker-a",
                    cwd=str(ROOT),
                    tmux_session="codex-worker-a",
                    tmux_pane_id="%1",
                    state="active",
                    timestamp="2026-05-08T10:00:00Z",
                )
                worker_db.create_task(
                    conn,
                    name="task-a",
                    goal="Do task A.",
                    task_id="task-a-id",
                    timestamp="2026-05-08T10:00:00Z",
                )
                worker_db.bind_task_worker(conn, task="task-a", worker="worker-a")
                worker_db.insert_status(
                    conn,
                    worker_id=worker_id,
                    status={
                        "blocker": None,
                        "current_task": "Task A.",
                        "next_action": "Continue.",
                        "state": "planning",
                    },
                    timestamp="2026-05-08T10:01:00Z",
                )
                conn.commit()

            proc = self.run_workerctl("task-status", "task-a", "--json", "--path", str(db_path))

            self.assertEqual(proc.returncode, 0, proc.stderr)
            snapshot = json.loads(proc.stdout)
            self.assertEqual(snapshot["name"], "task-a")
            self.assertEqual(snapshot["worker"]["name"], "worker-a")
            self.assertEqual(snapshot["worker"]["tmux_pane_id"], "%1")
            self.assertEqual(snapshot["worker_status"]["state"], "planning")

    def test_task_health_reports_ok_task(self):
        original_session_snapshot = worker_identity.session_snapshot
        try:
            worker_identity.session_snapshot = lambda session: {
                "live": True,
                "pane_id": "%2" if session == "codex-manager-task-a" else "%1",
                "session": session,
            }
            with tempfile.TemporaryDirectory() as tmpdir:
                db_path = Path(tmpdir) / "workerctl.db"
                with worker_db.connect(db_path) as conn:
                    worker_db.initialize_database(conn)
                    worker_id = worker_db.upsert_worker(
                        conn,
                        name="worker-a",
                        cwd=str(ROOT),
                        tmux_session="codex-worker-a",
                        tmux_pane_id="%1",
                        state="active",
                    )
                    task_id = worker_db.create_task(conn, name="task-a", goal="Do task A.")
                    worker_db.bind_task_worker(conn, task="task-a", worker="worker-a")
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
                    worker_db.set_task_state(conn, task_id=task_id, state="managed")
                    worker_db.mark_manager_seen(conn, manager_id=manager_id)
                    conn.commit()

                args = argparse.Namespace(json=True, manager_stale_seconds=60, path=str(db_path), task="task-a")
                with contextlib.redirect_stdout(io.StringIO()) as stdout:
                    result = commands.command_task_health(args)

                self.assertEqual(result, 0)
                payload = json.loads(stdout.getvalue())
                self.assertTrue(payload["ok"])
                self.assertEqual(payload["issues"], [])
                self.assertEqual(payload["task"]["id"], task_id)
                self.assertEqual(payload["live_reconcile"]["worker"]["id"], worker_id)
        finally:
            worker_identity.session_snapshot = original_session_snapshot

    def test_task_health_reports_integrity_and_reconcile_issues(self):
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

            proc = self.run_workerctl("task-health", "task-a", "--json", "--path", str(db_path))

            self.assertEqual(proc.returncode, 1, proc.stderr)
            payload = json.loads(proc.stdout)
            codes = {issue["code"] for issue in payload["issues"]}
            self.assertFalse(payload["ok"])
            self.assertIn("managed_without_active_worker_binding", codes)
            self.assertTrue(any("close-stale" in action for action in payload["recommended_actions"]))

    def test_task_health_reports_manager_rate_limit_prompt_explicitly(self):
        original_session_snapshot = worker_identity.session_snapshot
        try:
            worker_identity.session_snapshot = lambda session: {
                "live": True,
                "pane_id": "%2" if session == "codex-manager-task-a" else "%1",
                "session": session,
            }
            with tempfile.TemporaryDirectory() as tmpdir:
                db_path = Path(tmpdir) / "workerctl.db"
                with worker_db.connect(db_path) as conn:
                    worker_db.initialize_database(conn)
                    worker_db.upsert_worker(
                        conn,
                        name="worker-a",
                        cwd=str(ROOT),
                        tmux_session="codex-worker-a",
                        tmux_pane_id="%1",
                        state="active",
                    )
                    task_id = worker_db.create_task(conn, name="task-a", goal="Do task A.")
                    worker_db.bind_task_worker(conn, task="task-a", worker="worker-a")
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
                    worker_db.set_task_state(conn, task_id=task_id, state="managed")
                    conn.execute("update managers set last_seen_at = '2000-01-01T00:00:00Z' where id = ?", (manager_id,))
                    worker_db.insert_terminal_capture(
                        conn,
                        task_id=task_id,
                        manager_id=manager_id,
                        role="manager",
                        tmux_session="codex-manager-task-a",
                        tmux_pane_id="%2",
                        content_sha256="sha-rate",
                        content="Approaching rate limits\nSwitch to gpt-5.4-mini?\nPress enter to confirm",
                        history_lines=20,
                        source="test",
                        classifier={"busy_wait": {"pattern": "rate_limit_prompt"}},
                    )
                    conn.commit()

                result = commands.task_health_result(db_path, "task-a", manager_stale_seconds=60)

                codes = {issue["code"] for issue in result["issues"]}
                self.assertFalse(result["ok"])
                self.assertIn("manager_waiting_for_user_choice", codes)
                self.assertNotIn("manager_seen_stale", codes)
                self.assertTrue(any("close-manager" in action for action in result["recommended_actions"]))
        finally:
            worker_identity.session_snapshot = original_session_snapshot

    def test_task_health_treats_done_review_manager_stale_as_idle_metadata(self):
        original_session_snapshot = worker_identity.session_snapshot
        try:
            worker_identity.session_snapshot = lambda session: {"live": True, "pane_id": "%2", "session": session}
            with tempfile.TemporaryDirectory() as tmpdir:
                db_path = Path(tmpdir) / "workerctl.db"
                with worker_db.connect(db_path) as conn:
                    worker_db.initialize_database(conn)
                    task_id = worker_db.create_task(conn, name="task-a", goal="Do task A.")
                    manager_id = worker_db.create_manager(
                        conn,
                        task_id=task_id,
                        name="manager-a",
                        tmux_session="codex-manager-task-a",
                        tmux_pane_id="%2",
                        codex_args=[],
                        state="ready",
                    )
                    conn.execute("update tasks set state = 'done' where id = ?", (task_id,))
                    conn.execute("update managers set last_seen_at = '2000-01-01T00:00:00Z' where id = ?", (manager_id,))
                    conn.commit()

                result = commands.task_health_result(db_path, "task-a", manager_stale_seconds=60)

                self.assertTrue(result["ok"])
                self.assertEqual(result["issues"], [])
                self.assertEqual(result["recommended_actions"], ["No action required."])
                self.assertEqual(result["review_manager_idle"][0]["code"], "review_manager_idle")
                self.assertEqual(result["review_manager_idle"][0]["manager"], "manager-a")
        finally:
            worker_identity.session_snapshot = original_session_snapshot

    def test_task_capture_command_uses_bound_worker(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "workerctl.db"
            with worker_db.connect(db_path) as conn:
                worker_db.initialize_database(conn)
                worker_id = worker_db.upsert_worker(
                    conn,
                    name="worker-a",
                    cwd=str(ROOT),
                    tmux_session="codex-worker-a",
                    identity_token="token-worker-a",
                    tmux_pane_id="%1",
                    state="active",
                    timestamp="2026-05-08T10:00:00Z",
                )
                worker_db.create_task(conn, name="task-a", goal="Do task A.")
                worker_db.bind_task_worker(conn, task="task-a", worker="worker-a", binding_id="binding-1")
                conn.commit()

            captured = []
            original_capture_output = commands.capture_output
            original_verify_worker = worker_identity.verify_worker_binding_identity
            try:
                commands.capture_output = lambda name, lines: captured.append((name, lines)) or "terminal output"
                worker_identity.verify_worker_binding_identity = lambda binding: {"live": True, "live_pane_id": "%1", "mismatches": []}
                args = argparse.Namespace(task="task-a", role="worker", lines=120, json=True, path=str(db_path))

                with contextlib.redirect_stdout(io.StringIO()) as stdout:
                    result = commands.command_task_capture(args)

                payload = json.loads(stdout.getvalue())
                self.assertEqual(result, 0)
                self.assertEqual(captured, [("worker-a", 120)])
                self.assertEqual(payload["binding_id"], "binding-1")
                self.assertEqual(payload["capture"]["output"], "terminal output")
                self.assertEqual(payload["worker"]["name"], "worker-a")
                with worker_db.connect(db_path) as conn:
                    captures = conn.execute("select role, content_sha256, content from terminal_captures").fetchall()
                self.assertEqual(captures[0]["role"], "worker")
                self.assertEqual(captures[0]["content"], "terminal output")
            finally:
                commands.capture_output = original_capture_output
                worker_identity.verify_worker_binding_identity = original_verify_worker

    def test_task_capture_can_record_manager_terminal(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "workerctl.db"
            with worker_db.connect(db_path) as conn:
                worker_db.initialize_database(conn)
                worker_db.upsert_worker(conn, name="worker-a", cwd=str(ROOT), tmux_session="codex-worker-a", state="active")
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

            original_verify_manager = worker_identity.verify_manager_identity
            original_run = commands.run
            try:
                worker_identity.verify_manager_identity = lambda manager: {"live": True, "live_pane_id": "%2", "mismatches": []}
                commands.run = lambda argv, **kwargs: subprocess.CompletedProcess(argv, 0, "manager output", "")
                args = argparse.Namespace(task="task-a", role="manager", lines=80, json=True, path=str(db_path))

                with contextlib.redirect_stdout(io.StringIO()) as stdout:
                    result = commands.command_task_capture(args)

                payload = json.loads(stdout.getvalue())
                self.assertEqual(result, 0)
                self.assertEqual(payload["manager"]["id"], manager_id)
                self.assertEqual(payload["capture"]["output"], "manager output")
                with worker_db.connect(db_path) as conn:
                    capture = conn.execute("select role, manager_id, content from terminal_captures").fetchone()
                    manager = conn.execute("select last_capture_sha256 from managers where id = ?", (manager_id,)).fetchone()
                self.assertEqual(capture["role"], "manager")
                self.assertEqual(capture["manager_id"], manager_id)
                self.assertEqual(capture["content"], "manager output")
                self.assertEqual(manager["last_capture_sha256"], payload["capture"]["content_sha256"])
            finally:
                worker_identity.verify_manager_identity = original_verify_manager
                commands.run = original_run

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

    def test_manager_decision_records_observation_and_event(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "workerctl.db"
            with worker_db.connect(db_path) as conn:
                worker_db.initialize_database(conn)
                worker_db.upsert_worker(conn, name="worker-a", cwd=str(ROOT), tmux_session="codex-worker-a", state="active")
                task_id = worker_db.create_task(conn, name="task-a", goal="Do task A.")
                worker_db.bind_task_worker(conn, task="task-a", worker="worker-a", binding_id="binding-1")
                manager_id = worker_db.create_manager(conn, task_id=task_id, name="manager-a", tmux_session="codex-manager-task-a", codex_args=[], state="ready")
                worker_db.attach_manager_to_binding(conn, task_id=task_id, manager_id=manager_id)
                conn.commit()

            args = argparse.Namespace(cycle_id=None, decision="nudge", path=str(db_path), reason="worker is stale", task="task-a")
            with contextlib.redirect_stdout(io.StringIO()) as stdout:
                result = commands.command_manager_decision(args)

            payload = json.loads(stdout.getvalue())
            self.assertEqual(result, 0)
            self.assertEqual(payload["decision"], "nudge")
            with worker_db.connect(db_path) as conn:
                decision = conn.execute("select decision, reason from manager_decisions").fetchone()
                observation = conn.execute("select observation_type, message from agent_observations").fetchone()
                event = conn.execute("select type from events where type = 'manager_decision_recorded'").fetchone()
            self.assertEqual(decision["decision"], "nudge")
            self.assertEqual(decision["reason"], "worker is stale")
            self.assertEqual(observation["observation_type"], "decision")
            self.assertEqual(event["type"], "manager_decision_recorded")

    def test_manager_decision_rejects_done_task_without_review_override(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "workerctl.db"
            with worker_db.connect(db_path) as conn:
                worker_db.initialize_database(conn)
                task_id = worker_db.create_task(conn, name="task-a", goal="Do task A.")
                worker_db.create_manager(conn, task_id=task_id, name="manager-a", tmux_session="codex-manager-task-a", codex_args=[], state="ready")
                conn.execute("update tasks set state = 'done' where id = ?", (task_id,))
                conn.commit()

            args = argparse.Namespace(
                allow_post_terminal=False,
                cycle_id=None,
                decision="stop",
                path=str(db_path),
                reason="late stop",
                task="task-a",
            )

            with self.assertRaisesRegex(WorkerError, "refusing post-terminal manager decision"):
                commands.command_manager_decision(args)

            args.allow_post_terminal = True
            with contextlib.redirect_stdout(io.StringIO()) as stdout:
                result = commands.command_manager_decision(args)

            self.assertEqual(result, 0)
            payload = json.loads(stdout.getvalue())
            self.assertEqual(payload["decision"], "stop")
            with worker_db.connect(db_path) as conn:
                decision = conn.execute("select payload_json from manager_decisions").fetchone()
            self.assertTrue(json.loads(decision["payload_json"])["post_terminal"])

    def test_manager_observe_records_cycle_and_captures(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "workerctl.db"
            with worker_db.connect(db_path) as conn:
                worker_db.initialize_database(conn)
                worker_id = worker_db.upsert_worker(
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
                worker_db.mark_manager_seen(conn, manager_id=manager_id)
                worker_db.insert_status(
                    conn,
                    worker_id=worker_id,
                    status={"state": "waiting", "current_task": "Task A.", "next_action": "Wait.", "blocker": None},
                )
                conn.commit()

            original_verify_worker = worker_identity.verify_worker_binding_identity
            original_verify_manager = worker_identity.verify_manager_identity
            original_session_snapshot = worker_identity.session_snapshot
            original_capture_output = commands.capture_output
            original_run = commands.run
            original_idle_summary = commands.idle_summary
            try:
                worker_identity.verify_worker_binding_identity = lambda binding: {"live": True, "live_pane_id": "%1", "mismatches": []}
                worker_identity.verify_manager_identity = lambda manager: {"live": True, "live_pane_id": "%2", "mismatches": []}
                worker_identity.session_snapshot = lambda session: {
                    "live": True,
                    "pane_id": "%2" if session == "codex-manager-task-a" else "%1",
                    "session": session,
                }
                commands.capture_output = lambda name, lines: "worker output"
                commands.run = lambda argv, **kwargs: subprocess.CompletedProcess(argv, 0, "manager output", "")
                commands.idle_summary = lambda name, **kwargs: {"health": "active", "name": name}
                args = argparse.Namespace(
                    busy_wait_seconds=60,
                    lines=40,
                    manager_stale_seconds=600,
                    path=str(db_path),
                    refresh=False,
                    status_stale_seconds=300,
                    task="task-a",
                    terminal_stale_seconds=300,
                )

                with contextlib.redirect_stdout(io.StringIO()) as stdout:
                    result = commands.command_manager_observe(args)

                payload = json.loads(stdout.getvalue())
                self.assertEqual(result, 0)
                self.assertTrue(payload["health"]["ok"])
                self.assertEqual(payload["worker_capture"]["capture"]["output"], "worker output")
                self.assertEqual(payload["manager_capture"]["capture"]["output"], "manager output")
                with worker_db.connect(db_path) as conn:
                    cycle = conn.execute("select state, worker_capture_id, manager_capture_id from manager_cycles").fetchone()
                    captures = conn.execute("select role from terminal_captures order by id").fetchall()
                    segments = conn.execute("select role, segment_text from transcript_segments order by id").fetchall()
                    observation = conn.execute("select observation_type from agent_observations where observation_type = 'health'").fetchone()
                self.assertEqual(cycle["state"], "succeeded")
                self.assertIsNotNone(cycle["worker_capture_id"])
                self.assertIsNotNone(cycle["manager_capture_id"])
                self.assertEqual([row["role"] for row in captures], ["worker", "manager"])
                self.assertEqual([row["role"] for row in segments], ["worker", "manager"])
                self.assertEqual([row["segment_text"] for row in segments], ["worker output", "manager output"])
                self.assertEqual(observation["observation_type"], "health")
            finally:
                worker_identity.verify_worker_binding_identity = original_verify_worker
                worker_identity.verify_manager_identity = original_verify_manager
                worker_identity.session_snapshot = original_session_snapshot
                commands.capture_output = original_capture_output
                commands.run = original_run
                commands.idle_summary = original_idle_summary

    def test_manager_observe_compact_omits_output_but_persists_full_capture(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "workerctl.db"
            with worker_db.connect(db_path) as conn:
                worker_db.initialize_database(conn)
                worker_id = worker_db.upsert_worker(
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
                worker_db.mark_manager_seen(conn, manager_id=manager_id)
                worker_db.insert_status(
                    conn,
                    worker_id=worker_id,
                    status={"state": "waiting", "current_task": "Task A.", "next_action": "Wait.", "blocker": None},
                )
                conn.commit()

            original_verify_worker = worker_identity.verify_worker_binding_identity
            original_verify_manager = worker_identity.verify_manager_identity
            original_session_snapshot = worker_identity.session_snapshot
            original_capture_output = commands.capture_output
            original_run = commands.run
            original_idle_summary = commands.idle_summary
            try:
                worker_identity.verify_worker_binding_identity = lambda binding: {"live": True, "live_pane_id": "%1", "mismatches": []}
                worker_identity.verify_manager_identity = lambda manager: {"live": True, "live_pane_id": "%2", "mismatches": []}
                worker_identity.session_snapshot = lambda session: {
                    "live": True,
                    "pane_id": "%2" if session == "codex-manager-task-a" else "%1",
                    "session": session,
                }
                commands.capture_output = lambda name, lines: "worker line 1\nworker line 2"
                commands.run = lambda argv, **kwargs: subprocess.CompletedProcess(argv, 0, "manager line 1\nmanager line 2", "")
                commands.idle_summary = lambda name, **kwargs: {"health": "active", "name": name}
                args = argparse.Namespace(
                    busy_wait_seconds=60,
                    compact=True,
                    lines=40,
                    manager_stale_seconds=600,
                    path=str(db_path),
                    refresh=False,
                    status_stale_seconds=300,
                    task="task-a",
                    terminal_stale_seconds=300,
                )

                with contextlib.redirect_stdout(io.StringIO()) as stdout:
                    result = commands.command_manager_observe(args)

                payload = json.loads(stdout.getvalue())
                self.assertEqual(result, 0)
                self.assertTrue(payload["compact"])
                self.assertNotIn("output", payload["worker_capture"]["capture"])
                self.assertNotIn("output", payload["manager_capture"]["capture"])
                self.assertEqual(payload["worker_capture"]["capture"]["excerpt"], "worker line 1\nworker line 2")
                with worker_db.connect(db_path) as conn:
                    captures = conn.execute("select role, content from terminal_captures order by id").fetchall()
                self.assertEqual([(row["role"], row["content"]) for row in captures], [
                    ("worker", "worker line 1\nworker line 2"),
                    ("manager", "manager line 1\nmanager line 2"),
                ])
            finally:
                worker_identity.verify_worker_binding_identity = original_verify_worker
                worker_identity.verify_manager_identity = original_verify_manager
                worker_identity.session_snapshot = original_session_snapshot
                commands.capture_output = original_capture_output
                commands.run = original_run
                commands.idle_summary = original_idle_summary

    def test_task_idle_check_command_uses_bound_worker(self):
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
                    timestamp="2026-05-08T10:00:00Z",
                )
                worker_db.create_task(conn, name="task-a", goal="Do task A.")
                worker_db.bind_task_worker(conn, task="task-a", worker="worker-a", binding_id="binding-1")
                conn.commit()

            checked = []
            original_idle_summary = commands.idle_summary
            try:
                def fake_idle_summary(name, **kwargs):
                    checked.append((name, kwargs))
                    return {"health": "active", "name": name}

                commands.idle_summary = fake_idle_summary
                args = argparse.Namespace(
                    busy_wait_seconds=60,
                    lines=80,
                    path=str(db_path),
                    refresh=False,
                    status_stale_seconds=300,
                    task="task-a",
                    terminal_stale_seconds=300,
                )

                with contextlib.redirect_stdout(io.StringIO()) as stdout:
                    result = commands.command_task_idle_check(args)

                payload = json.loads(stdout.getvalue())
                self.assertEqual(result, 0)
                self.assertEqual(checked[0][0], "worker-a")
                self.assertFalse(checked[0][1]["refresh"])
                self.assertEqual(payload["binding_id"], "binding-1")
                self.assertEqual(payload["task_name"], "task-a")
            finally:
                commands.idle_summary = original_idle_summary

    def test_task_nudge_dry_run_records_durable_command(self):
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
                    timestamp="2026-05-08T10:00:00Z",
                )
                worker_db.create_task(conn, name="task-a", goal="Do task A.")
                worker_db.bind_task_worker(conn, task="task-a", worker="worker-a", binding_id="binding-1")
                conn.commit()

            args = argparse.Namespace(task="task-a", message="status please", dry_run=True, path=str(db_path))

            with contextlib.redirect_stdout(io.StringIO()) as stdout:
                result = commands.command_task_nudge(args)

            payload = json.loads(stdout.getvalue())
            self.assertEqual(result, 0)
            self.assertEqual(payload["worker"], "worker-a")
            self.assertTrue(payload["dry_run"])
            with worker_db.connect(db_path) as conn:
                command_row = conn.execute("select * from commands where id = ?", (payload["command_id"],)).fetchone()
                event_types = [row["type"] for row in conn.execute("select type from events order by id")]
            self.assertEqual(command_row["state"], "succeeded")
            self.assertEqual(json.loads(command_row["payload_json"])["message"], "status please")
            self.assertIn("task_nudge_intent", event_types)
            self.assertIn("task_nudge_succeeded", event_types)

    def test_task_nudge_links_manager_decision(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "workerctl.db"
            with worker_db.connect(db_path) as conn:
                worker_db.initialize_database(conn)
                worker_db.upsert_worker(conn, name="worker-a", cwd=str(ROOT), tmux_session="codex-worker-a", state="active")
                task_id = worker_db.create_task(conn, name="task-a", goal="Do task A.")
                worker_db.bind_task_worker(conn, task="task-a", worker="worker-a", binding_id="binding-1")
                decision_id = worker_db.insert_manager_decision(
                    conn,
                    task_id=task_id,
                    manager_id=None,
                    decision="nudge",
                    reason="worker is waiting",
                )
                conn.commit()

            args = argparse.Namespace(task="task-a", message="status please", decision_id=decision_id, dry_run=True, path=str(db_path))

            with contextlib.redirect_stdout(io.StringIO()) as stdout:
                result = commands.command_task_nudge(args)

            payload = json.loads(stdout.getvalue())
            self.assertEqual(result, 0)
            self.assertTrue(payload["manager_decision"]["ok"])
            self.assertEqual(payload["manager_decision"]["decision"]["id"], decision_id)
            with worker_db.connect(db_path) as conn:
                command_row = conn.execute("select payload_json from commands where id = ?", (payload["command_id"],)).fetchone()
            command_payload = json.loads(command_row["payload_json"])
            self.assertTrue(command_payload["manager_decision"]["ok"])

    def test_task_nudge_records_missing_decision_warning(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "workerctl.db"
            with worker_db.connect(db_path) as conn:
                worker_db.initialize_database(conn)
                worker_db.upsert_worker(conn, name="worker-a", cwd=str(ROOT), tmux_session="codex-worker-a", state="active")
                worker_db.create_task(conn, name="task-a", goal="Do task A.")
                worker_db.bind_task_worker(conn, task="task-a", worker="worker-a", binding_id="binding-1")
                conn.commit()

            args = argparse.Namespace(task="task-a", message="status please", decision_id=None, dry_run=True, path=str(db_path))

            with contextlib.redirect_stdout(io.StringIO()) as stdout:
                result = commands.command_task_nudge(args)

            payload = json.loads(stdout.getvalue())
            self.assertEqual(result, 0)
            self.assertFalse(payload["manager_decision"]["ok"])
            self.assertEqual(payload["manager_decision"]["warnings"], ["missing_decision_id"])

    def test_task_nudge_strict_decisions_rejects_missing_decision(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "workerctl.db"
            with worker_db.connect(db_path) as conn:
                worker_db.initialize_database(conn)
                worker_db.upsert_worker(conn, name="worker-a", cwd=str(ROOT), tmux_session="codex-worker-a", state="active")
                worker_db.create_task(conn, name="task-a", goal="Do task A.")
                worker_db.bind_task_worker(conn, task="task-a", worker="worker-a", binding_id="binding-1")
                conn.commit()

            args = argparse.Namespace(
                task="task-a",
                message="status please",
                decision_id=None,
                strict_decisions=True,
                dry_run=True,
                path=str(db_path),
            )

            with self.assertRaisesRegex(WorkerError, "manager_decision_validation_failed"):
                commands.command_task_nudge(args)

            with worker_db.connect(db_path) as conn:
                command_count = conn.execute("select count(*) as count from commands").fetchone()["count"]
            self.assertEqual(command_count, 0)

    def test_mutation_audit_flags_missing_and_accepts_linked_decisions(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "workerctl.db"
            with worker_db.connect(db_path) as conn:
                worker_db.initialize_database(conn)
                worker_db.upsert_worker(conn, name="worker-a", cwd=str(ROOT), tmux_session="codex-worker-a", state="active")
                task_id = worker_db.create_task(conn, name="task-a", goal="Do task A.")
                worker_db.bind_task_worker(conn, task="task-a", worker="worker-a", binding_id="binding-1")
                decision_id = worker_db.insert_manager_decision(
                    conn,
                    task_id=task_id,
                    manager_id=None,
                    decision="nudge",
                    reason="worker is waiting",
                )
                conn.commit()

            linked_args = argparse.Namespace(task="task-a", message="status please", decision_id=decision_id, dry_run=True, path=str(db_path))
            missing_args = argparse.Namespace(task="task-a", message="second status please", decision_id=None, dry_run=True, path=str(db_path))
            with contextlib.redirect_stdout(io.StringIO()):
                commands.command_task_nudge(linked_args)
            with contextlib.redirect_stdout(io.StringIO()):
                commands.command_task_nudge(missing_args)

            proc = self.run_workerctl("mutation-audit", "task-a", "--json", "--path", str(db_path))

            self.assertEqual(proc.returncode, 1, proc.stdout)
            payload = json.loads(proc.stdout)
            self.assertFalse(payload["ok"])
            self.assertEqual(payload["summary"]["mutations"], 2)
            self.assertEqual(payload["summary"]["with_warnings"], 1)
            self.assertEqual(sum(1 for record in payload["records"] if record["ok"]), 1)
            self.assertTrue(any("missing_decision_id" in record["warnings"] for record in payload["records"]))

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

    def test_task_health_audit_decisions_reports_mutation_warnings(self):
        original_session_snapshot = worker_identity.session_snapshot
        try:
            worker_identity.session_snapshot = lambda session: {
                "live": True,
                "pane_id": "%2" if session == "codex-manager-task-a" else "%1",
                "session": session,
            }
            with tempfile.TemporaryDirectory() as tmpdir:
                db_path = Path(tmpdir) / "workerctl.db"
                with worker_db.connect(db_path) as conn:
                    worker_db.initialize_database(conn)
                    worker_db.upsert_worker(
                        conn,
                        name="worker-a",
                        cwd=str(ROOT),
                        tmux_session="codex-worker-a",
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
                    worker_db.set_task_state(conn, task_id=task_id, state="managed")
                    worker_db.mark_manager_seen(conn, manager_id=manager_id)
                    conn.commit()

                nudge_args = argparse.Namespace(
                    task="task-a",
                    message="status please",
                    decision_id=None,
                    strict_decisions=False,
                    dry_run=True,
                    path=str(db_path),
                )
                with contextlib.redirect_stdout(io.StringIO()):
                    commands.command_task_nudge(nudge_args)

                health_args = argparse.Namespace(
                    audit_decisions=True,
                    json=True,
                    manager_stale_seconds=60,
                    path=str(db_path),
                    record=False,
                    task="task-a",
                )
                with contextlib.redirect_stdout(io.StringIO()) as stdout:
                    result = commands.command_task_health(health_args)

                self.assertEqual(result, 1)
                payload = json.loads(stdout.getvalue())
                self.assertFalse(payload["ok"])
                self.assertFalse(payload["decision_audit"]["ok"])
                self.assertTrue(any(issue["source"] == "manager_decision_audit" for issue in payload["issues"]))
        finally:
            worker_identity.session_snapshot = original_session_snapshot

    def test_task_nudge_records_failure_when_send_fails(self):
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
                    timestamp="2026-05-08T10:00:00Z",
                )
                worker_db.create_task(conn, name="task-a", goal="Do task A.")
                worker_db.bind_task_worker(conn, task="task-a", worker="worker-a", binding_id="binding-1")
                conn.commit()

            original_send_text = commands.send_text
            original_require_worker = worker_identity.require_worker
            original_session_snapshot = worker_identity.session_snapshot
            try:
                worker_identity.require_worker = lambda name: {
                    "identity_token": "token-worker-a",
                    "tmux_pane_id": "%1",
                    "tmux_session": "codex-worker-a",
                }
                worker_identity.session_snapshot = lambda target: {"live": True, "pane_id": "%1", "session": target}
                commands.send_text = lambda name, message: (_ for _ in ()).throw(WorkerError("tmux missing"))
                args = argparse.Namespace(task="task-a", message="status please", dry_run=False, path=str(db_path))

                with self.assertRaises(WorkerError):
                    commands.command_task_nudge(args)

                with worker_db.connect(db_path) as conn:
                    command_row = conn.execute("select * from commands order by created_at desc limit 1").fetchone()
                    event_types = [row["type"] for row in conn.execute("select type from events order by id")]
                self.assertEqual(command_row["state"], "failed")
                self.assertEqual(command_row["error"], "tmux missing")
                self.assertIn("task_nudge_failed", event_types)
            finally:
                commands.send_text = original_send_text
                worker_identity.require_worker = original_require_worker
                worker_identity.session_snapshot = original_session_snapshot

    def test_task_nudge_reserves_budget_before_send(self):
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
                    timestamp="2026-05-08T10:00:00Z",
                )
                task_id = worker_db.create_task(conn, name="task-a", goal="Do task A.")
                worker_db.bind_task_worker(conn, task="task-a", worker="worker-a", binding_id="binding-1")
                worker_db.set_budget(conn, task_id=task_id, max_nudges=1, expires_at="9999-01-01T00:00:00Z")
                conn.commit()

            sent = []
            original_send_text = commands.send_text
            original_require_worker = worker_identity.require_worker
            original_session_snapshot = worker_identity.session_snapshot
            try:
                worker_identity.require_worker = lambda name: {
                    "identity_token": "token-worker-a",
                    "tmux_pane_id": "%1",
                    "tmux_session": "codex-worker-a",
                }
                worker_identity.session_snapshot = lambda target: {"live": True, "pane_id": "%1", "session": target}
                commands.send_text = lambda name, message: sent.append((name, message))
                args = argparse.Namespace(task="task-a", message="status please", dry_run=False, path=str(db_path))

                with contextlib.redirect_stdout(io.StringIO()) as stdout:
                    result = commands.command_task_nudge(args)

                payload = json.loads(stdout.getvalue())
                self.assertEqual(result, 0)
                self.assertEqual(sent, [("worker-a", "status please")])
                self.assertEqual(payload["budget"]["nudges_used"], 1)
                self.assertEqual(payload["budget"]["nudges_remaining"], 0)
                with worker_db.connect(db_path) as conn:
                    budget = conn.execute("select nudges_used from budgets where task_id = ?", (task_id,)).fetchone()
                self.assertEqual(budget["nudges_used"], 1)

                with self.assertRaises(WorkerError):
                    commands.command_task_nudge(args)
                self.assertEqual(sent, [("worker-a", "status please")])
            finally:
                commands.send_text = original_send_text
                worker_identity.require_worker = original_require_worker
                worker_identity.session_snapshot = original_session_snapshot

    def test_extend_nudge_budget_allows_next_strict_nudge_after_exhaustion(self):
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
                    timestamp="2026-05-08T10:00:00Z",
                )
                task_id = worker_db.create_task(conn, name="task-a", goal="Do task A.")
                worker_db.bind_task_worker(conn, task="task-a", worker="worker-a", binding_id="binding-1")
                worker_db.set_budget(conn, task_id=task_id, max_nudges=3, expires_at="9999-01-01T00:00:00Z")
                conn.execute("update budgets set nudges_used = 3 where task_id = ?", (task_id,))
                nudge_decision_id = worker_db.insert_manager_decision(
                    conn,
                    task_id=task_id,
                    manager_id=None,
                    decision="nudge",
                    reason="worker is waiting",
                )
                escalate_decision_id = worker_db.insert_manager_decision(
                    conn,
                    task_id=task_id,
                    manager_id=None,
                    decision="escalate",
                    reason="budget exhausted but more supervised work is required",
                )
                conn.commit()

            sent = []
            original_send_text = commands.send_text
            original_require_worker = worker_identity.require_worker
            original_session_snapshot = worker_identity.session_snapshot
            try:
                worker_identity.require_worker = lambda name: {
                    "identity_token": "token-worker-a",
                    "tmux_pane_id": "%1",
                    "tmux_session": "codex-worker-a",
                }
                worker_identity.session_snapshot = lambda target: {"live": True, "pane_id": "%1", "session": target}
                commands.send_text = lambda name, message: sent.append((name, message))
                exhausted_args = argparse.Namespace(
                    task="task-a",
                    message="status please",
                    decision_id=nudge_decision_id,
                    strict_decisions=True,
                    dry_run=False,
                    path=str(db_path),
                )

                with self.assertRaisesRegex(WorkerError, "Nudge budget exhausted"):
                    commands.command_task_nudge(exhausted_args)
                self.assertEqual(sent, [])

                extend_args = argparse.Namespace(
                    add_nudges=2,
                    budget_expires_at="9999-01-02T00:00:00Z",
                    budget_hours=24,
                    decision_id=escalate_decision_id,
                    path=str(db_path),
                    strict_decisions=True,
                    task="task-a",
                )
                with contextlib.redirect_stdout(io.StringIO()) as stdout:
                    result = commands.command_extend_nudge_budget(extend_args)

                payload = json.loads(stdout.getvalue())
                self.assertEqual(result, 0)
                self.assertEqual(payload["budget"]["max_nudges"], 5)
                self.assertEqual(payload["budget"]["nudges_used"], 3)
                self.assertEqual(payload["budget"]["nudges_remaining"], 2)
                self.assertTrue(payload["manager_decision"]["ok"])

                next_decision_id = None
                with worker_db.connect(db_path) as conn:
                    next_decision_id = worker_db.insert_manager_decision(
                        conn,
                        task_id=task_id,
                        manager_id=None,
                        decision="nudge",
                        reason="budget was extended and worker is waiting",
                    )
                    conn.commit()

                allowed_args = argparse.Namespace(
                    task="task-a",
                    message="continue please",
                    decision_id=next_decision_id,
                    strict_decisions=True,
                    dry_run=False,
                    path=str(db_path),
                )
                with contextlib.redirect_stdout(io.StringIO()) as stdout:
                    result = commands.command_task_nudge(allowed_args)

                payload = json.loads(stdout.getvalue())
                self.assertEqual(result, 0)
                self.assertEqual(sent, [("worker-a", "continue please")])
                self.assertEqual(payload["budget"]["nudges_used"], 4)
                self.assertEqual(payload["budget"]["nudges_remaining"], 1)

                proc = self.run_workerctl("mutation-audit", "task-a", "--json", "--path", str(db_path))
                audit = json.loads(proc.stdout)
                self.assertEqual(proc.returncode, 0, proc.stdout)
                self.assertEqual(audit["summary"]["with_warnings"], 0)
                self.assertIn("extend_nudge_budget", [record["command"]["type"] for record in audit["records"]])
            finally:
                commands.send_text = original_send_text
                worker_identity.require_worker = original_require_worker
                worker_identity.session_snapshot = original_session_snapshot

    def test_task_health_warns_when_managed_task_budget_is_exhausted(self):
        original_session_snapshot = worker_identity.session_snapshot
        try:
            worker_identity.session_snapshot = lambda session: {
                "live": True,
                "pane_id": "%2" if session == "codex-manager-task-a" else "%1",
                "session": session,
            }
            with tempfile.TemporaryDirectory() as tmpdir:
                db_path = Path(tmpdir) / "workerctl.db"
                with worker_db.connect(db_path) as conn:
                    worker_db.initialize_database(conn)
                    worker_db.upsert_worker(
                        conn,
                        name="worker-a",
                        cwd=str(ROOT),
                        tmux_session="codex-worker-a",
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
                    worker_db.set_task_state(conn, task_id=task_id, state="managed")
                    worker_db.mark_manager_seen(conn, manager_id=manager_id)
                    worker_db.set_budget(conn, task_id=task_id, max_nudges=3, expires_at="9999-01-01T00:00:00Z")
                    conn.execute("update budgets set nudges_used = 3 where task_id = ?", (task_id,))
                    conn.commit()

                health_args = argparse.Namespace(
                    audit_decisions=True,
                    json=True,
                    manager_stale_seconds=60,
                    path=str(db_path),
                    record=False,
                    task="task-a",
                )
                with contextlib.redirect_stdout(io.StringIO()) as stdout:
                    result = commands.command_task_health(health_args)

                payload = json.loads(stdout.getvalue())
                self.assertEqual(result, 1)
                self.assertFalse(payload["ok"])
                self.assertTrue(any(issue["code"] == "nudge_budget_exhausted" for issue in payload["issues"]))
                self.assertTrue(any("extend-nudge-budget" in action for action in payload["recommended_actions"]))
        finally:
            worker_identity.session_snapshot = original_session_snapshot

    def test_task_nudge_refuses_identity_mismatch_before_send(self):
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
                    timestamp="2026-05-08T10:00:00Z",
                )
                task_id = worker_db.create_task(conn, name="task-a", goal="Do task A.")
                worker_db.bind_task_worker(conn, task="task-a", worker="worker-a", binding_id="binding-1")
                worker_db.set_budget(conn, task_id=task_id, max_nudges=1, expires_at="9999-01-01T00:00:00Z")
                conn.commit()

            sent = []
            original_send_text = commands.send_text
            original_require_worker = worker_identity.require_worker
            original_session_snapshot = worker_identity.session_snapshot
            try:
                worker_identity.require_worker = lambda name: {
                    "identity_token": "wrong-token",
                    "tmux_pane_id": "%1",
                    "tmux_session": "codex-worker-a",
                }
                worker_identity.session_snapshot = lambda target: {"live": True, "pane_id": "%1", "session": target}
                commands.send_text = lambda name, message: sent.append((name, message))
                args = argparse.Namespace(task="task-a", message="status please", dry_run=False, path=str(db_path))

                with self.assertRaisesRegex(WorkerError, "identity_token_mismatch"):
                    commands.command_task_nudge(args)

                self.assertEqual(sent, [])
                with worker_db.connect(db_path) as conn:
                    command_row = conn.execute("select * from commands order by created_at desc limit 1").fetchone()
                    budget = conn.execute("select nudges_used from budgets where task_id = ?", (task_id,)).fetchone()
                self.assertEqual(command_row["state"], "failed")
                self.assertEqual(budget["nudges_used"], 0)
            finally:
                commands.send_text = original_send_text
                worker_identity.require_worker = original_require_worker
                worker_identity.session_snapshot = original_session_snapshot

    def test_task_interrupt_dry_run_records_durable_command(self):
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
                    timestamp="2026-05-08T10:00:00Z",
                )
                worker_db.create_task(conn, name="task-a", goal="Do task A.")
                worker_db.bind_task_worker(conn, task="task-a", worker="worker-a", binding_id="binding-1")
                conn.commit()

            args = argparse.Namespace(
                dry_run=True,
                followup="report status",
                key="C-c",
                no_followup=False,
                path=str(db_path),
                task="task-a",
            )

            with contextlib.redirect_stdout(io.StringIO()) as stdout:
                result = commands.command_task_interrupt(args)

            payload = json.loads(stdout.getvalue())
            self.assertEqual(result, 0)
            self.assertEqual(payload["worker"], "worker-a")
            self.assertEqual(payload["key"], "C-c")
            self.assertEqual(payload["followup"], "report status")
            with worker_db.connect(db_path) as conn:
                command_row = conn.execute("select * from commands where id = ?", (payload["command_id"],)).fetchone()
                event_types = [row["type"] for row in conn.execute("select type from events order by id")]
            self.assertEqual(command_row["state"], "succeeded")
            self.assertEqual(json.loads(command_row["payload_json"])["key"], "C-c")
            self.assertIn("task_interrupt_intent", event_types)
            self.assertIn("task_interrupt_succeeded", event_types)

    def test_task_interrupt_refuses_pane_mismatch_before_send(self):
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
                    timestamp="2026-05-08T10:00:00Z",
                )
                worker_db.create_task(conn, name="task-a", goal="Do task A.")
                worker_db.bind_task_worker(conn, task="task-a", worker="worker-a", binding_id="binding-1")
                conn.commit()

            interrupted = []
            original_interrupt_worker = commands.interrupt_worker
            original_require_worker = worker_identity.require_worker
            original_session_snapshot = worker_identity.session_snapshot
            try:
                worker_identity.require_worker = lambda name: {
                    "identity_token": "token-worker-a",
                    "tmux_pane_id": "%1",
                    "tmux_session": "codex-worker-a",
                }
                worker_identity.session_snapshot = lambda target: {"live": True, "pane_id": "%9", "session": target}
                commands.interrupt_worker = lambda *args, **kwargs: interrupted.append((args, kwargs))
                args = argparse.Namespace(
                    dry_run=False,
                    followup="report status",
                    key="C-c",
                    no_followup=False,
                    path=str(db_path),
                    task="task-a",
                )

                with self.assertRaisesRegex(WorkerError, "tmux_pane_mismatch"):
                    commands.command_task_interrupt(args)

                self.assertEqual(interrupted, [])
                with worker_db.connect(db_path) as conn:
                    command_row = conn.execute("select * from commands order by created_at desc limit 1").fetchone()
                self.assertEqual(command_row["state"], "failed")
            finally:
                commands.interrupt_worker = original_interrupt_worker
                worker_identity.require_worker = original_require_worker
                worker_identity.session_snapshot = original_session_snapshot

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

    def test_promote_creates_manager_and_budget(self):
        name = "promote-worker"
        worker_path = worker_dir(name)
        if worker_path.exists():
            shutil.rmtree(worker_path)
        worker_path.mkdir(parents=True)
        write_config = {
            "cwd": str(ROOT),
            "name": name,
            "tmux_session": f"codex-{name}",
        }
        config_path(name).write_text(json.dumps(write_config) + "\n")
        original_ensure_tool = lifecycle.ensure_tool
        original_session_exists = lifecycle.session_exists
        original_manager_session_exists = lifecycle.manager_session_exists
        original_run = lifecycle.run
        original_session_snapshot = worker_identity.session_snapshot
        original_state_root = lifecycle.state_root
        try:
            with tempfile.TemporaryDirectory() as tmpdir:
                db_path = Path(tmpdir) / "workerctl.db"
                artifact_root = Path(tmpdir) / "state"
                lifecycle.ensure_tool = lambda tool: tool
                lifecycle.session_exists = lambda worker: worker == name
                lifecycle.manager_session_exists = lambda session: False
                lifecycle.run = lambda *args, **kwargs: subprocess.CompletedProcess(args[0], 0, "", "")
                worker_identity.session_snapshot = lambda session: {
                    "live": True,
                    "pane_id": "%2" if session.startswith("codex-manager-") else "%1",
                    "session": session,
                }
                lifecycle.state_root = lambda: artifact_root
                args = argparse.Namespace(
                    budget_expires_at="2026-05-09T10:00:00Z",
                    budget_hours=24,
                    codex_args=["--", "--model", "test"],
                    goal="Do the task.",
                    manager_instructions="Watch carefully.",
                    max_nudges=2,
                    path=str(db_path),
                    summary="Started.",
                    task="task-a",
                    worker=name,
                )

                with contextlib.redirect_stdout(io.StringIO()) as stdout:
                    result = lifecycle.command_promote(args)

                payload = json.loads(stdout.getvalue())
                self.assertEqual(result, 0)
                self.assertEqual(payload["task"], "task-a")
                with worker_db.connect(db_path) as conn:
                    task = conn.execute("select * from tasks where name = 'task-a'").fetchone()
                    worker = conn.execute("select * from workers where name = ?", (name,)).fetchone()
                    manager = conn.execute("select * from managers where task_id = ?", (task["id"],)).fetchone()
                    budget = conn.execute("select * from budgets where task_id = ?", (task["id"],)).fetchone()
                    command = conn.execute("select * from commands where type = 'promote'").fetchone()
                    prompt = conn.execute("select * from prompts where task_id = ?", (task["id"],)).fetchone()
                self.assertEqual(task["state"], "managed")
                self.assertEqual(worker["tmux_pane_id"], "%1")
                self.assertEqual(manager["state"], "ready")
                self.assertEqual(manager["tmux_pane_id"], "%2")
                self.assertEqual(json.loads(manager["codex_args_json"]), ["--model", "test"])
                self.assertEqual(payload["warnings"], [])
                self.assertEqual(budget["max_nudges"], 2)
                self.assertEqual(command["state"], "succeeded")
                source_snapshot = json.loads(prompt["source_snapshot_json"])
                self.assertEqual(source_snapshot["worker"], name)
                self.assertIn("git", source_snapshot)
                self.assertIn("status", source_snapshot)
                self.assertIn("Source snapshot:", prompt["content"])
                self.assertTrue(Path(payload["prompt_path"]).exists())
        finally:
            lifecycle.ensure_tool = original_ensure_tool
            lifecycle.session_exists = original_session_exists
            lifecycle.manager_session_exists = original_manager_session_exists
            lifecycle.run = original_run
            worker_identity.session_snapshot = original_session_snapshot
            lifecycle.state_root = original_state_root
            if worker_path.exists():
                shutil.rmtree(worker_path)

    def test_promote_defaults_to_recommended_manager_codex_args(self):
        name = "promote-noargs-worker"
        worker_path = worker_dir(name)
        if worker_path.exists():
            shutil.rmtree(worker_path)
        worker_path.mkdir(parents=True)
        config_path(name).write_text(
            json.dumps(
                {
                    "cwd": str(ROOT),
                    "identity_token": "token-worker",
                    "name": name,
                    "tmux_session": f"codex-{name}",
                }
            )
            + "\n"
        )
        original_ensure_tool = lifecycle.ensure_tool
        original_session_exists = lifecycle.session_exists
        original_manager_session_exists = lifecycle.manager_session_exists
        original_run = lifecycle.run
        original_session_snapshot = worker_identity.session_snapshot
        original_state_root = lifecycle.state_root
        try:
            with tempfile.TemporaryDirectory() as tmpdir:
                db_path = Path(tmpdir) / "workerctl.db"
                artifact_root = Path(tmpdir) / "state"
                lifecycle.ensure_tool = lambda tool: tool
                lifecycle.session_exists = lambda worker: worker == name
                lifecycle.manager_session_exists = lambda session: False
                lifecycle.run = lambda *args, **kwargs: subprocess.CompletedProcess(args[0], 0, "", "")
                worker_identity.session_snapshot = lambda session: {
                    "live": True,
                    "pane_id": "%2" if session.startswith("codex-manager-") else "%1",
                    "session": session,
                }
                lifecycle.state_root = lambda: artifact_root
                args = argparse.Namespace(
                    budget_expires_at=None,
                    budget_hours=24,
                    codex_args=[],
                    goal="Do the task.",
                    manager_instructions=None,
                    max_nudges=3,
                    path=str(db_path),
                    summary="Started.",
                    task="task-a",
                    worker=name,
                )

                with contextlib.redirect_stdout(io.StringIO()) as stdout:
                    result = lifecycle.command_promote(args)

                payload = json.loads(stdout.getvalue())
                self.assertEqual(result, 0)
                self.assertEqual(payload["warnings"], [])
                self.assertEqual(payload["recommended_manager_codex_args"], ["--sandbox", "danger-full-access", "--ask-for-approval", "never"])
                with worker_db.connect(db_path) as conn:
                    command = conn.execute("select payload_json, result_json from commands where type = 'promote'").fetchone()
                    manager = conn.execute("select codex_args_json from managers").fetchone()
                command_payload = json.loads(command["payload_json"])
                command_result = json.loads(command["result_json"])
                self.assertEqual(json.loads(manager["codex_args_json"]), ["--sandbox", "danger-full-access", "--ask-for-approval", "never"])
                self.assertEqual(command_payload["warnings"], [])
                self.assertEqual(command_result["warnings"], [])
        finally:
            lifecycle.ensure_tool = original_ensure_tool
            lifecycle.session_exists = original_session_exists
            lifecycle.manager_session_exists = original_manager_session_exists
            lifecycle.run = original_run
            worker_identity.session_snapshot = original_session_snapshot
            lifecycle.state_root = original_state_root
            if worker_path.exists():
                shutil.rmtree(worker_path)

    def test_promote_warns_when_manager_codex_args_are_explicitly_disabled(self):
        name = "promote-disabled-args-worker"
        worker_path = worker_dir(name)
        if worker_path.exists():
            shutil.rmtree(worker_path)
        worker_path.mkdir(parents=True)
        config_path(name).write_text(
            json.dumps(
                {
                    "cwd": str(ROOT),
                    "identity_token": "token-worker",
                    "name": name,
                    "tmux_session": f"codex-{name}",
                }
            )
            + "\n"
        )
        original_ensure_tool = lifecycle.ensure_tool
        original_session_exists = lifecycle.session_exists
        original_manager_session_exists = lifecycle.manager_session_exists
        original_run = lifecycle.run
        original_session_snapshot = worker_identity.session_snapshot
        original_state_root = lifecycle.state_root
        try:
            with tempfile.TemporaryDirectory() as tmpdir:
                db_path = Path(tmpdir) / "workerctl.db"
                artifact_root = Path(tmpdir) / "state"
                lifecycle.ensure_tool = lambda tool: tool
                lifecycle.session_exists = lambda worker: worker == name
                lifecycle.manager_session_exists = lambda session: False
                lifecycle.run = lambda *args, **kwargs: subprocess.CompletedProcess(args[0], 0, "", "")
                worker_identity.session_snapshot = lambda session: {
                    "live": True,
                    "pane_id": "%2" if session.startswith("codex-manager-") else "%1",
                    "session": session,
                }
                lifecycle.state_root = lambda: artifact_root
                args = argparse.Namespace(
                    budget_expires_at=None,
                    budget_hours=24,
                    codex_args=[],
                    goal="Do the task.",
                    manager_instructions=None,
                    max_nudges=3,
                    no_manager_codex_args=True,
                    open_manager=False,
                    path=str(db_path),
                    summary="Started.",
                    task="task-a",
                    terminal="auto",
                    worker=name,
                )

                with contextlib.redirect_stdout(io.StringIO()) as stdout:
                    result = lifecycle.command_promote(args)

                payload = json.loads(stdout.getvalue())
                self.assertEqual(result, 0)
                self.assertEqual(payload["warnings"][0]["code"], "manager_started_without_codex_args")
                with worker_db.connect(db_path) as conn:
                    manager = conn.execute("select codex_args_json from managers").fetchone()
                self.assertEqual(json.loads(manager["codex_args_json"]), [])
        finally:
            lifecycle.ensure_tool = original_ensure_tool
            lifecycle.session_exists = original_session_exists
            lifecycle.manager_session_exists = original_manager_session_exists
            lifecycle.run = original_run
            worker_identity.session_snapshot = original_session_snapshot
            lifecycle.state_root = original_state_root
            if worker_path.exists():
                shutil.rmtree(worker_path)

    def test_pause_and_resume_manager_lifecycle(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "workerctl.db"
            prompt_path = Path(tmpdir) / "manager-prompt.md"
            prompt_path.write_text("manager prompt")
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
                    codex_args=[],
                    state="ready",
                )
                worker_db.attach_manager_to_binding(conn, task_id=task_id, manager_id=manager_id)
                worker_db.insert_prompt(
                    conn,
                    task_id=task_id,
                    manager_id=manager_id,
                    kind="manager",
                    content="manager prompt",
                    content_sha256="hash",
                    generator_version="test",
                    source_snapshot={},
                    policy={},
                    artifact_path=str(prompt_path),
                )
                conn.commit()

            original_ensure_tool = commands.ensure_tool
            original_manager_session_exists = lifecycle.manager_session_exists
            original_run = lifecycle.run
            original_session_snapshot = worker_identity.session_snapshot
            try:
                lifecycle.ensure_tool = lambda tool: tool
                live_sessions = {"codex-manager-task-a": True}
                lifecycle.manager_session_exists = lambda session: live_sessions.get(session, False)
                lifecycle.run = lambda *args, **kwargs: subprocess.CompletedProcess(args[0], 0, "", "")
                worker_identity.session_snapshot = lambda session: {
                    "live": True,
                    "pane_id": "%3" if session.startswith("codex-manager-") else "%1",
                    "session": session,
                }

                pause_args = argparse.Namespace(path=str(db_path), task="task-a")
                with contextlib.redirect_stdout(io.StringIO()):
                    lifecycle.command_pause_manager(pause_args)

                with worker_db.connect(db_path) as conn:
                    task = conn.execute("select state from tasks where id = ?", (task_id,)).fetchone()
                    old_manager = conn.execute("select state from managers where id = ?", (manager_id,)).fetchone()
                self.assertEqual(task["state"], "paused")
                self.assertEqual(old_manager["state"], "stopped")

                live_sessions["codex-manager-task-a"] = False
                resume_args = argparse.Namespace(codex_args=[], path=str(db_path), task="task-a")
                with contextlib.redirect_stdout(io.StringIO()):
                    lifecycle.command_resume_manager(resume_args)

                with worker_db.connect(db_path) as conn:
                    task = conn.execute("select state from tasks where id = ?", (task_id,)).fetchone()
                    managers = conn.execute("select state, tmux_pane_id from managers where task_id = ? order by started_at", (task_id,)).fetchall()
                self.assertEqual(task["state"], "managed")
                self.assertEqual([row["state"] for row in managers], ["stopped", "ready"])
                self.assertEqual(managers[-1]["tmux_pane_id"], "%3")
            finally:
                lifecycle.ensure_tool = original_ensure_tool
                lifecycle.manager_session_exists = original_manager_session_exists
                lifecycle.run = original_run
                worker_identity.session_snapshot = original_session_snapshot
                if worker_path.exists():
                    shutil.rmtree(worker_path)

    def test_unmanage_resolves_current_worker_and_pauses_manager(self):
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
        try:
            with tempfile.TemporaryDirectory() as tmpdir:
                db_path = Path(tmpdir) / "workerctl.db"
                with worker_db.connect(db_path) as conn:
                    worker_db.initialize_database(conn)
                    worker_id = worker_db.upsert_worker(
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

                original_current_session_name = lifecycle.current_session_name
                original_run = lifecycle.run
                original_session_snapshot = worker_identity.session_snapshot
                try:
                    lifecycle.current_session_name = lambda: "codex-worker-a"
                    lifecycle.run = lambda *args, **kwargs: subprocess.CompletedProcess(args[0], 0, "", "")
                    worker_identity.session_snapshot = lambda session: {
                        "live": True,
                        "pane_id": "%2" if session == "codex-manager-task-a" else "%1",
                        "session": session,
                    }
                    args = argparse.Namespace(dry_run=False, json=True, path=str(db_path), session=None, task=None)

                    with contextlib.redirect_stdout(io.StringIO()) as stdout:
                        result = lifecycle.command_unmanage(args)

                    payload = json.loads(stdout.getvalue())
                    self.assertEqual(result, 0)
                    self.assertEqual(payload["task"], "task-a")
                    self.assertEqual(payload["source"]["initiator"], "worker")
                    self.assertEqual(payload["source"]["source_command"], "unmanage")
                    self.assertTrue(payload["killed_session"])
                    with worker_db.connect(db_path) as conn:
                        task = conn.execute("select state from tasks where id = ?", (task_id,)).fetchone()
                        worker = conn.execute("select state from workers where name = 'worker-a'").fetchone()
                        manager = conn.execute("select state from managers where id = ?", (manager_id,)).fetchone()
                        command = conn.execute("select type, worker_id, state from commands").fetchone()
                        events = conn.execute("select actor, type, worker_id from events order by id").fetchall()
                    self.assertEqual(task["state"], "paused")
                    self.assertEqual(worker["state"], "active")
                    self.assertEqual(manager["state"], "stopped")
                    self.assertEqual(command["type"], "unmanage")
                    self.assertEqual(command["worker_id"], worker_id)
                    self.assertEqual(command["state"], "succeeded")
                    self.assertIn(("worker", "unmanage_intent", worker_id), [(row["actor"], row["type"], row["worker_id"]) for row in events])
                    self.assertIn(("worker", "unmanage_succeeded", worker_id), [(row["actor"], row["type"], row["worker_id"]) for row in events])
                finally:
                    lifecycle.current_session_name = original_current_session_name
                    lifecycle.run = original_run
                    worker_identity.session_snapshot = original_session_snapshot
        finally:
            if worker_path.exists():
                shutil.rmtree(worker_path)

    def test_unmanage_fails_without_session_or_task(self):
        original_current_session_name = lifecycle.current_session_name
        try:
            lifecycle.current_session_name = lambda: None
            with tempfile.TemporaryDirectory() as tmpdir:
                args = argparse.Namespace(dry_run=False, json=True, path=str(Path(tmpdir) / "workerctl.db"), session=None, task=None)
                with self.assertRaisesRegex(WorkerError, "Cannot infer current tmux session"):
                    lifecycle.command_unmanage(args)
        finally:
            lifecycle.current_session_name = original_current_session_name

    def test_resume_manager_rejects_paused_task_without_active_worker_binding(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "workerctl.db"
            prompt_path = Path(tmpdir) / "manager-prompt.md"
            prompt_path.write_text("manager prompt")
            with worker_db.connect(db_path) as conn:
                worker_db.initialize_database(conn)
                worker_db.upsert_worker(
                    conn,
                    name="worker-a",
                    cwd=str(ROOT),
                    tmux_session="codex-worker-a",
                    state="stopped",
                )
                task_id = worker_db.create_task(conn, name="task-a", goal="Do task A.")
                worker_db.bind_task_worker(conn, task="task-a", worker="worker-a", binding_id="binding-1")
                manager_id = worker_db.create_manager(
                    conn,
                    task_id=task_id,
                    name="manager-a",
                    tmux_session="codex-manager-task-a",
                    codex_args=[],
                    state="stopped",
                )
                worker_db.attach_manager_to_binding(conn, task_id=task_id, manager_id=manager_id)
                worker_db.insert_prompt(
                    conn,
                    task_id=task_id,
                    manager_id=manager_id,
                    kind="manager",
                    content="manager prompt",
                    content_sha256="hash",
                    generator_version="test",
                    source_snapshot={},
                    policy={},
                    artifact_path=str(prompt_path),
                )
                worker_db.end_active_binding(conn, task_id=task_id)
                worker_db.set_task_state(conn, task_id=task_id, state="paused")
                conn.commit()

            original_ensure_tool = lifecycle.ensure_tool
            try:
                lifecycle.ensure_tool = lambda tool: tool
                args = argparse.Namespace(codex_args=[], open_manager=False, path=str(db_path), task="task-a", terminal="auto")
                with self.assertRaisesRegex(WorkerError, "cannot resume manager without an active worker binding"):
                    lifecycle.command_resume_manager(args)
                with worker_db.connect(db_path) as conn:
                    managers = conn.execute("select count(*) as count from managers where task_id = ?", (task_id,)).fetchone()
                    task = conn.execute("select state from tasks where id = ?", (task_id,)).fetchone()
                self.assertEqual(managers["count"], 1)
                self.assertEqual(task["state"], "paused")
            finally:
                lifecycle.ensure_tool = original_ensure_tool

    def test_resume_manager_rejects_missing_live_worker_session(self):
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
        try:
            with tempfile.TemporaryDirectory() as tmpdir:
                db_path = Path(tmpdir) / "workerctl.db"
                prompt_path = Path(tmpdir) / "manager-prompt.md"
                prompt_path.write_text("manager prompt")
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
                        codex_args=[],
                        state="stopped",
                    )
                    worker_db.attach_manager_to_binding(conn, task_id=task_id, manager_id=manager_id)
                    worker_db.insert_prompt(
                        conn,
                        task_id=task_id,
                        manager_id=manager_id,
                        kind="manager",
                        content="manager prompt",
                        content_sha256="hash",
                        generator_version="test",
                        source_snapshot={},
                        policy={},
                        artifact_path=str(prompt_path),
                    )
                    worker_db.set_task_state(conn, task_id=task_id, state="paused")
                    conn.commit()

                original_ensure_tool = lifecycle.ensure_tool
                original_session_snapshot = worker_identity.session_snapshot
                try:
                    lifecycle.ensure_tool = lambda tool: tool
                    worker_identity.session_snapshot = lambda session: {
                        "live": False,
                        "pane_id": None,
                        "session": session,
                    }
                    args = argparse.Namespace(codex_args=[], open_manager=False, path=str(db_path), task="task-a", terminal="auto")

                    with self.assertRaisesRegex(WorkerError, "Worker identity verification failed"):
                        lifecycle.command_resume_manager(args)

                    with worker_db.connect(db_path) as conn:
                        managers = conn.execute("select count(*) as count from managers where task_id = ?", (task_id,)).fetchone()
                        task = conn.execute("select state from tasks where id = ?", (task_id,)).fetchone()
                    self.assertEqual(managers["count"], 1)
                    self.assertEqual(task["state"], "paused")
                finally:
                    lifecycle.ensure_tool = original_ensure_tool
                    worker_identity.session_snapshot = original_session_snapshot
        finally:
            if worker_path.exists():
                shutil.rmtree(worker_path)

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

    def test_my_status_resolves_current_worker_task(self):
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
                task_id = worker_db.create_task(conn, name="task-a", goal="Do task A.", summary="In progress.")
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

            original_current_session_name = lifecycle.current_session_name
            try:
                lifecycle.current_session_name = lambda: "codex-worker-a"
                args = argparse.Namespace(json=True, path=str(db_path), session=None, task=None)
                with contextlib.redirect_stdout(io.StringIO()) as stdout:
                    result = lifecycle.command_my_status(args)

                payload = json.loads(stdout.getvalue())
                self.assertEqual(result, 0)
                self.assertEqual(payload["worker"]["name"], "worker-a")
                self.assertEqual(payload["task"]["name"], "task-a")
                self.assertEqual(payload["task"]["state"], "managed")
                self.assertEqual(payload["manager"]["name"], "manager-a")
                self.assertIn("workerctl unmanage", payload["suggested_next_commands"])
            finally:
                lifecycle.current_session_name = original_current_session_name

    def test_remanage_resolves_current_worker_and_restarts_manager(self):
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
        try:
            with tempfile.TemporaryDirectory() as tmpdir:
                db_path = Path(tmpdir) / "workerctl.db"
                prompt_path = Path(tmpdir) / "manager-prompt.md"
                prompt_path.write_text("manager prompt")
                with worker_db.connect(db_path) as conn:
                    worker_db.initialize_database(conn)
                    worker_id = worker_db.upsert_worker(
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
                    old_manager_id = worker_db.create_manager(
                        conn,
                        task_id=task_id,
                        name="manager-old",
                        tmux_session="codex-manager-task-a",
                        tmux_pane_id="%2",
                        codex_args=[],
                        state="stopped",
                    )
                    worker_db.attach_manager_to_binding(conn, task_id=task_id, manager_id=old_manager_id)
                    worker_db.set_task_state(conn, task_id=task_id, state="paused")
                    worker_db.insert_prompt(
                        conn,
                        task_id=task_id,
                        manager_id=old_manager_id,
                        kind="manager",
                        content="manager prompt",
                        content_sha256="hash",
                        generator_version="test",
                        source_snapshot={},
                        policy={},
                        artifact_path=str(prompt_path),
                    )
                    conn.commit()

                original_current_session_name = lifecycle.current_session_name
                original_ensure_tool = lifecycle.ensure_tool
                original_manager_session_exists = lifecycle.manager_session_exists
                original_run = lifecycle.run
                original_session_snapshot = worker_identity.session_snapshot
                try:
                    lifecycle.current_session_name = lambda: "codex-worker-a"
                    lifecycle.ensure_tool = lambda tool: tool
                    lifecycle.manager_session_exists = lambda session: False
                    lifecycle.run = lambda *args, **kwargs: subprocess.CompletedProcess(args[0], 0, "", "")
                    worker_identity.session_snapshot = lambda session: {
                        "live": True,
                        "pane_id": "%3" if session.startswith("codex-manager-") else "%1",
                        "session": session,
                    }
                    args = argparse.Namespace(codex_args=["--", "--model", "test"], path=str(db_path), session=None, task=None)

                    with contextlib.redirect_stdout(io.StringIO()) as stdout:
                        result = lifecycle.command_remanage(args)

                    payload = json.loads(stdout.getvalue())
                    self.assertEqual(result, 0)
                    self.assertEqual(payload["task"], "task-a")
                    self.assertEqual(payload["source"]["initiator"], "worker")
                    self.assertEqual(payload["source"]["source_command"], "remanage")
                    with worker_db.connect(db_path) as conn:
                        task = conn.execute("select state from tasks where id = ?", (task_id,)).fetchone()
                        managers = conn.execute("select state, tmux_pane_id, codex_args_json from managers where task_id = ? order by started_at", (task_id,)).fetchall()
                        command = conn.execute("select type, worker_id, state from commands").fetchone()
                        events = conn.execute("select actor, type, worker_id from events order by id").fetchall()
                    self.assertEqual(task["state"], "managed")
                    self.assertEqual([row["state"] for row in managers], ["stopped", "ready"])
                    self.assertEqual(managers[-1]["tmux_pane_id"], "%3")
                    self.assertEqual(json.loads(managers[-1]["codex_args_json"]), ["--model", "test"])
                    self.assertEqual(command["type"], "remanage")
                    self.assertEqual(command["worker_id"], worker_id)
                    self.assertEqual(command["state"], "succeeded")
                    self.assertIn(("worker", "remanage_intent", worker_id), [(row["actor"], row["type"], row["worker_id"]) for row in events])
                    self.assertIn(("worker", "remanage_succeeded", worker_id), [(row["actor"], row["type"], row["worker_id"]) for row in events])
                finally:
                    lifecycle.current_session_name = original_current_session_name
                    lifecycle.ensure_tool = original_ensure_tool
                    lifecycle.manager_session_exists = original_manager_session_exists
                    lifecycle.run = original_run
                    worker_identity.session_snapshot = original_session_snapshot
        finally:
            if worker_path.exists():
                shutil.rmtree(worker_path)

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
                args = argparse.Namespace(message=None, path=str(db_path), stop_worker=True, task="task-a")

                with contextlib.redirect_stdout(io.StringIO()) as stdout:
                    result = lifecycle.command_stop_task(args)

                payload = json.loads(stdout.getvalue())
                self.assertEqual(result, 0)
                self.assertTrue(payload["killed_manager"])
                self.assertTrue(payload["killed_worker"])
                with worker_db.connect(db_path) as conn:
                    task = conn.execute("select state from tasks where id = ?", (task_id,)).fetchone()
                    binding = conn.execute("select state, ended_at from bindings where id = 'binding-1'").fetchone()
                    manager = conn.execute("select state from managers where id = ?", (manager_id,)).fetchone()
                    worker = conn.execute("select state from workers where name = 'worker-a'").fetchone()
                    command = conn.execute("select state from commands where type = 'stop_task'").fetchone()
                self.assertEqual(task["state"], "done")
                self.assertEqual(binding["state"], "ended")
                self.assertIsNotNone(binding["ended_at"])
                self.assertEqual(manager["state"], "stopped")
                self.assertEqual(worker["state"], "stopped")
                self.assertEqual(command["state"], "succeeded")
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

    def test_close_manager_closes_finished_task_review_manager(self):
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
                worker_db.end_active_binding(conn, task_id=task_id)
                worker_db.set_task_state(conn, task_id=task_id, state="done")
                conn.commit()

            original_session_snapshot = worker_identity.session_snapshot
            original_run = lifecycle.run
            try:
                worker_identity.session_snapshot = lambda session: {
                    "live": True,
                    "pane_id": "%2",
                    "session": session,
                }
                run_calls = []
                lifecycle.run = lambda *args, **kwargs: (
                    run_calls.append(args[0]) or subprocess.CompletedProcess(args[0], 0, "", "")
                )
                args = argparse.Namespace(path=str(db_path), reason="review complete", task="task-a")

                with contextlib.redirect_stdout(io.StringIO()) as stdout:
                    result = lifecycle.command_close_manager(args)

                payload = json.loads(stdout.getvalue())
                self.assertEqual(result, 0)
                self.assertTrue(payload["killed_manager"])
                self.assertEqual(payload["task_state"], "done")
                with worker_db.connect(db_path) as conn:
                    snapshot = worker_db.task_status_snapshot(conn, task="task-a")
                    manager = conn.execute("select state, exit_reason from managers where id = ?", (manager_id,)).fetchone()
                    command = conn.execute("select state from commands where type = 'close_manager'").fetchone()
                    event = conn.execute("select type from events where type = 'close_manager_succeeded'").fetchone()
                self.assertIsNone(snapshot["manager"])
                self.assertEqual(snapshot["state"], "done")
                self.assertEqual(manager["state"], "stopped")
                self.assertEqual(manager["exit_reason"], "review complete")
                self.assertEqual(command["state"], "succeeded")
                self.assertEqual(event["type"], "close_manager_succeeded")
                self.assertEqual(run_calls, [["tmux", "kill-session", "-t", "codex-manager-task-a"]])
            finally:
                worker_identity.session_snapshot = original_session_snapshot
                lifecycle.run = original_run

    def test_recover_marks_missing_finished_review_manager_without_pausing_task(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "workerctl.db"
            with worker_db.connect(db_path) as conn:
                worker_db.initialize_database(conn)
                task_id = worker_db.create_task(conn, name="task-a", goal="Do task A.")
                manager_id = worker_db.create_manager(
                    conn,
                    task_id=task_id,
                    name="manager-a",
                    tmux_session="codex-manager-task-a",
                    tmux_pane_id="%2",
                    codex_args=[],
                    state="ready",
                )
                worker_db.set_task_state(conn, task_id=task_id, state="done")
                conn.commit()

            original_session_snapshot = worker_identity.session_snapshot
            try:
                worker_identity.session_snapshot = lambda session: {
                    "live": False,
                    "pane_id": None,
                    "session": session,
                }
                args = argparse.Namespace(path=str(db_path), recover=True, sync_pane_ids=False, task="task-a")

                with contextlib.redirect_stdout(io.StringIO()) as stdout:
                    result = lifecycle.command_recover(args)

                payload = json.loads(stdout.getvalue())
                self.assertEqual(result, 0)
                self.assertIn("manager_missing", payload["results"][0]["drift"])
                with worker_db.connect(db_path) as conn:
                    task = conn.execute("select state from tasks where id = ?", (task_id,)).fetchone()
                    manager = conn.execute("select state from managers where id = ?", (manager_id,)).fetchone()
                self.assertEqual(task["state"], "done")
                self.assertEqual(manager["state"], "missing")
            finally:
                worker_identity.session_snapshot = original_session_snapshot

    def test_close_manager_marks_already_missing_review_manager_stopped(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "workerctl.db"
            with worker_db.connect(db_path) as conn:
                worker_db.initialize_database(conn)
                task_id = worker_db.create_task(conn, name="task-a", goal="Do task A.")
                manager_id = worker_db.create_manager(
                    conn,
                    task_id=task_id,
                    name="manager-a",
                    tmux_session="codex-manager-task-a",
                    tmux_pane_id="%2",
                    codex_args=[],
                    state="ready",
                )
                worker_db.set_task_state(conn, task_id=task_id, state="done")
                conn.commit()

            original_session_snapshot = worker_identity.session_snapshot
            original_run = lifecycle.run
            try:
                worker_identity.session_snapshot = lambda session: {
                    "live": False,
                    "pane_id": None,
                    "session": session,
                }
                run_calls = []
                lifecycle.run = lambda *args, **kwargs: (
                    run_calls.append(args[0]) or subprocess.CompletedProcess(args[0], 0, "", "")
                )
                args = argparse.Namespace(path=str(db_path), reason="already closed", task="task-a")

                with contextlib.redirect_stdout(io.StringIO()) as stdout:
                    result = lifecycle.command_close_manager(args)

                payload = json.loads(stdout.getvalue())
                self.assertEqual(result, 0)
                self.assertFalse(payload["killed_manager"])
                self.assertFalse(payload["manager_identity"]["live"])
                with worker_db.connect(db_path) as conn:
                    task = conn.execute("select state from tasks where id = ?", (task_id,)).fetchone()
                    manager = conn.execute("select state, exit_reason from managers where id = ?", (manager_id,)).fetchone()
                self.assertEqual(task["state"], "done")
                self.assertEqual(manager["state"], "stopped")
                self.assertEqual(manager["exit_reason"], "already closed")
                self.assertEqual(run_calls, [])
            finally:
                worker_identity.session_snapshot = original_session_snapshot
                lifecycle.run = original_run

    def test_pause_manager_refuses_pane_mismatch_before_kill(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "workerctl.db"
            with worker_db.connect(db_path) as conn:
                worker_db.initialize_database(conn)
                task_id = worker_db.create_task(conn, name="task-a", goal="Do task A.")
                manager_id = worker_db.create_manager(
                    conn,
                    task_id=task_id,
                    name="manager-a",
                    tmux_session="codex-manager-task-a",
                    tmux_pane_id="%2",
                    codex_args=[],
                    state="ready",
                )
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
                args = argparse.Namespace(path=str(db_path), task="task-a")

                with self.assertRaisesRegex(WorkerError, "manager_pane_mismatch"):
                    lifecycle.command_pause_manager(args)

                self.assertEqual(killed, [])
                with worker_db.connect(db_path) as conn:
                    manager = conn.execute("select state from managers where id = ?", (manager_id,)).fetchone()
                    command = conn.execute("select state from commands where type = 'pause_manager'").fetchone()
                self.assertEqual(manager["state"], "ready")
                self.assertEqual(command["state"], "failed")
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

    def test_recover_marks_missing_manager_and_pauses_task(self):
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

            original_session_snapshot = worker_identity.session_snapshot
            try:
                def fake_session_snapshot(session):
                    return {
                        "live": session == "codex-worker-a",
                        "pane_id": "%1" if session == "codex-worker-a" else None,
                        "session": session,
                    }

                worker_identity.session_snapshot = fake_session_snapshot

                with contextlib.redirect_stdout(io.StringIO()) as stdout:
                    result = lifecycle.command_recover(argparse.Namespace(path=str(db_path), task="task-a"))

                payload = json.loads(stdout.getvalue())
                self.assertEqual(result, 0)
                self.assertEqual(payload["results"][0]["drift"], ["manager_missing"])
                with worker_db.connect(db_path) as conn:
                    task = conn.execute("select state from tasks where id = ?", (task_id,)).fetchone()
                    manager = conn.execute("select state from managers where id = ?", (manager_id,)).fetchone()
                self.assertEqual(task["state"], "paused")
                self.assertEqual(manager["state"], "missing")
            finally:
                worker_identity.session_snapshot = original_session_snapshot

    def test_reconcile_reports_pane_mismatches_without_marking_missing(self):
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
                conn.execute("update workers set tmux_pane_id = '%1' where id = ?", (worker_id,))
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
                conn.execute("update managers set tmux_pane_id = '%2' where id = ?", (manager_id,))
                worker_db.attach_manager_to_binding(conn, task_id=task_id, manager_id=manager_id)
                conn.commit()

            original_session_snapshot = worker_identity.session_snapshot
            try:
                def fake_session_snapshot(session):
                    pane_ids = {
                        "codex-worker-a": "%9",
                        "codex-manager-task-a": "%8",
                    }
                    return {"live": True, "pane_id": pane_ids[session], "session": session}

                worker_identity.session_snapshot = fake_session_snapshot

                with contextlib.redirect_stdout(io.StringIO()) as stdout:
                    result = lifecycle.command_recover(argparse.Namespace(path=str(db_path), task="task-a"))

                payload = json.loads(stdout.getvalue())
                self.assertEqual(result, 0)
                drift = payload["results"][0]["drift"]
                self.assertIn("worker_pane_mismatch", drift)
                self.assertIn("manager_pane_mismatch", drift)
                self.assertEqual(payload["results"][0]["worker"]["recorded_pane_id"], "%1")
                self.assertEqual(payload["results"][0]["worker"]["tmux_pane_id"], "%9")
                self.assertEqual(payload["results"][0]["manager"]["recorded_pane_id"], "%2")
                self.assertEqual(payload["results"][0]["manager"]["tmux_pane_id"], "%8")
                with worker_db.connect(db_path) as conn:
                    task = conn.execute("select state from tasks where id = ?", (task_id,)).fetchone()
                    worker = conn.execute("select state from workers where name = 'worker-a'").fetchone()
                    manager = conn.execute("select state from managers where id = ?", (manager_id,)).fetchone()
                    event_types = [row["type"] for row in conn.execute("select type from events order by id")]
                self.assertEqual(task["state"], "managed")
                self.assertEqual(worker["state"], "active")
                self.assertEqual(manager["state"], "ready")
                self.assertIn("recover_worker_pane_mismatch", event_types)
                self.assertIn("recover_manager_pane_mismatch", event_types)
            finally:
                worker_identity.session_snapshot = original_session_snapshot

    def test_recover_syncs_live_pane_ids_when_requested(self):
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
                worker_id = worker_db.upsert_worker(
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

            original_session_snapshot = worker_identity.session_snapshot
            try:
                def fake_session_snapshot(session):
                    pane_ids = {
                        "codex-worker-a": "%9",
                        "codex-manager-task-a": "%8",
                    }
                    return {"live": True, "pane_id": pane_ids[session], "session": session}

                worker_identity.session_snapshot = fake_session_snapshot

                with contextlib.redirect_stdout(io.StringIO()) as stdout:
                    result = lifecycle.command_recover(
                        argparse.Namespace(path=str(db_path), sync_pane_ids=True, task="task-a")
                    )

                payload = json.loads(stdout.getvalue())
                self.assertEqual(result, 0)
                self.assertTrue(payload["sync_pane_ids"])
                self.assertIn("worker_pane_mismatch", payload["results"][0]["drift"])
                self.assertIn("manager_pane_mismatch", payload["results"][0]["drift"])
                with worker_db.connect(db_path) as conn:
                    worker = conn.execute("select tmux_pane_id from workers where name = 'worker-a'").fetchone()
                    manager = conn.execute("select tmux_pane_id from managers where id = ?", (manager_id,)).fetchone()
                    event_types = [row["type"] for row in conn.execute("select type from events order by id")]
                config = json.loads(config_path("worker-a").read_text())
                self.assertEqual(worker["tmux_pane_id"], "%9")
                self.assertEqual(config["tmux_pane_id"], "%9")
                self.assertEqual(manager["tmux_pane_id"], "%8")
                self.assertIn("recover_worker_pane_synced", event_types)
                self.assertIn("recover_manager_pane_synced", event_types)
            finally:
                worker_identity.session_snapshot = original_session_snapshot
                if worker_path.exists():
                    shutil.rmtree(worker_path)

    def test_reconcile_reports_unfinished_commands_with_guidance(self):
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

            with contextlib.redirect_stdout(io.StringIO()) as stdout:
                result = lifecycle.command_reconcile(argparse.Namespace(path=str(db_path), task="task-a"))

            payload = json.loads(stdout.getvalue())
            self.assertEqual(result, 1)
            self.assertIn("unfinished_commands", payload["results"][0]["drift"])
            self.assertEqual(payload["results"][0]["unfinished_commands"][0]["type"], "task_nudge")
            self.assertIn("retry manually", payload["results"][0]["unfinished_commands"][0]["recommended_action"])

    def test_close_stale_dry_run_reports_candidates_without_mutating(self):
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
                conn.commit()

            original_session_snapshot = worker_identity.session_snapshot
            try:
                worker_identity.session_snapshot = lambda session: {"live": False, "pane_id": None, "session": session}

                with contextlib.redirect_stdout(io.StringIO()) as stdout:
                    result = lifecycle.command_close_stale(
                        argparse.Namespace(apply=False, path=str(db_path), task="task-a")
                    )

                payload = json.loads(stdout.getvalue())
                self.assertEqual(result, 0)
                self.assertFalse(payload["apply"])
                self.assertEqual(payload["candidates"][0]["task"]["id"], task_id)
                self.assertEqual(payload["candidates"][0]["planned_state"], "failed")
                with worker_db.connect(db_path) as conn:
                    task = conn.execute("select state from tasks where id = ?", (task_id,)).fetchone()
                    worker = conn.execute("select state from workers where name = 'worker-a'").fetchone()
                    binding = conn.execute("select state from bindings where id = 'binding-1'").fetchone()
                    commands_count = conn.execute("select count(*) from commands where type = 'close_stale'").fetchone()[0]
                self.assertEqual(task["state"], "managed")
                self.assertEqual(worker["state"], "active")
                self.assertEqual(binding["state"], "active")
                self.assertEqual(commands_count, 0)
            finally:
                worker_identity.session_snapshot = original_session_snapshot

    def test_close_stale_apply_marks_failed_and_audits_transition(self):
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
                conn.commit()

            original_session_snapshot = worker_identity.session_snapshot
            try:
                worker_identity.session_snapshot = lambda session: {"live": False, "pane_id": None, "session": session}

                with contextlib.redirect_stdout(io.StringIO()) as stdout:
                    result = lifecycle.command_close_stale(
                        argparse.Namespace(apply=True, path=str(db_path), task="task-a")
                    )

                payload = json.loads(stdout.getvalue())
                self.assertEqual(result, 0)
                self.assertTrue(payload["apply"])
                self.assertEqual(payload["closed"][0]["task"]["id"], task_id)
                with worker_db.connect(db_path) as conn:
                    task = conn.execute("select state from tasks where id = ?", (task_id,)).fetchone()
                    worker = conn.execute("select state from workers where name = 'worker-a'").fetchone()
                    binding = conn.execute("select state, ended_at from bindings where id = 'binding-1'").fetchone()
                    command = conn.execute("select state, result_json from commands where type = 'close_stale'").fetchone()
                    event = conn.execute("select type, payload_json from events where type = 'close_stale_task'").fetchone()
                self.assertEqual(task["state"], "failed")
                self.assertEqual(worker["state"], "missing")
                self.assertEqual(binding["state"], "ended")
                self.assertIsNotNone(binding["ended_at"])
                self.assertEqual(command["state"], "succeeded")
                self.assertEqual(json.loads(command["result_json"])["task_state"], "failed")
                self.assertEqual(event["type"], "close_stale_task")
                self.assertEqual(json.loads(event["payload_json"])["planned_state"], "failed")
            finally:
                worker_identity.session_snapshot = original_session_snapshot

    def test_close_stale_skips_unfinished_commands(self):
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
                worker_db.create_command(
                    conn,
                    command_type="task_nudge",
                    payload={"message": "status"},
                    task_id=task_id,
                    worker_id=worker_id,
                )
                conn.commit()

            original_session_snapshot = worker_identity.session_snapshot
            try:
                worker_identity.session_snapshot = lambda session: {"live": False, "pane_id": None, "session": session}

                with contextlib.redirect_stdout(io.StringIO()) as stdout:
                    result = lifecycle.command_close_stale(
                        argparse.Namespace(apply=True, path=str(db_path), task="task-a")
                    )

                payload = json.loads(stdout.getvalue())
                self.assertEqual(result, 0)
                self.assertEqual(payload["closed"], [])
                self.assertEqual(payload["skipped"][0]["skip_reasons"], ["unfinished_commands"])
                with worker_db.connect(db_path) as conn:
                    task = conn.execute("select state from tasks where id = ?", (task_id,)).fetchone()
                    binding = conn.execute("select state from bindings where id = 'binding-1'").fetchone()
                    close_count = conn.execute("select count(*) from commands where type = 'close_stale'").fetchone()[0]
                self.assertEqual(task["state"], "managed")
                self.assertEqual(binding["state"], "active")
                self.assertEqual(close_count, 0)
            finally:
                worker_identity.session_snapshot = original_session_snapshot

    def test_close_stale_skips_live_manager(self):
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

            original_session_snapshot = worker_identity.session_snapshot
            try:
                def fake_session_snapshot(session):
                    return {"live": session == "codex-manager-task-a", "pane_id": None, "session": session}

                worker_identity.session_snapshot = fake_session_snapshot

                with contextlib.redirect_stdout(io.StringIO()) as stdout:
                    result = lifecycle.command_close_stale(
                        argparse.Namespace(apply=True, path=str(db_path), task="task-a")
                    )

                payload = json.loads(stdout.getvalue())
                self.assertEqual(result, 0)
                self.assertEqual(payload["closed"], [])
                self.assertEqual(payload["skipped"][0]["skip_reasons"], ["manager_live"])
                with worker_db.connect(db_path) as conn:
                    task = conn.execute("select state from tasks where id = ?", (task_id,)).fetchone()
                    worker = conn.execute("select state from workers where name = 'worker-a'").fetchone()
                    manager = conn.execute("select state from managers where id = ?", (manager_id,)).fetchone()
                self.assertEqual(task["state"], "managed")
                self.assertEqual(worker["state"], "active")
                self.assertEqual(manager["state"], "ready")
            finally:
                worker_identity.session_snapshot = original_session_snapshot

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
        self.assertIn("become-managed", proc.stdout)
        self.assertIn("commands", proc.stdout)
        self.assertIn("doctor-self", proc.stdout)
        self.assertIn("explain-managed-flow", proc.stdout)
        self.assertIn("import-compat", proc.stdout)
        self.assertIn("manager-decision", proc.stdout)
        self.assertIn("manager-observe", proc.stdout)
        self.assertIn("manage", proc.stdout)
        self.assertIn("mutation-audit", proc.stdout)
        self.assertIn("my-status", proc.stdout)
        self.assertIn("name-session", proc.stdout)
        self.assertIn("open-manager", proc.stdout)
        self.assertIn("open-worker", proc.stdout)
        self.assertIn("pause-manager", proc.stdout)
        self.assertIn("prune", proc.stdout)
        self.assertIn("qa-plan", proc.stdout)
        self.assertIn("promote", proc.stdout)
        self.assertIn("recover", proc.stdout)
        self.assertIn("reconcile", proc.stdout)
        self.assertIn("replay", proc.stdout)
        self.assertIn("remanage", proc.stdout)
        self.assertIn("resume-manager", proc.stdout)
        self.assertIn("self-promote", proc.stdout)
        self.assertIn("start", proc.stdout)
        self.assertIn("stop-task", proc.stdout)
        self.assertIn("close-stale", proc.stdout)
        self.assertIn("export-task", proc.stdout)
        self.assertIn("finish-task", proc.stdout)
        self.assertIn("task-capture", proc.stdout)
        self.assertIn("task-events", proc.stdout)
        self.assertIn("task-health", proc.stdout)
        self.assertIn("task-idle-check", proc.stdout)
        self.assertIn("task-interrupt", proc.stdout)
        self.assertIn("task-nudge", proc.stdout)
        self.assertIn("transcript-capture", proc.stdout)
        self.assertIn("transcript-prune", proc.stdout)
        self.assertIn("transcript-show", proc.stdout)

    def test_recover_help_includes_sync_pane_ids(self):
        proc = self.run_workerctl("recover", "--help")

        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("--sync-pane-ids", proc.stdout)

    def test_close_stale_help_includes_apply(self):
        proc = self.run_workerctl("close-stale", "--help")

        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("--apply", proc.stdout)

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


@unittest.skipIf(shutil.which("tmux") is None, "tmux is not installed")
class TmuxTests(unittest.TestCase):
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


if __name__ == "__main__":
    unittest.main()
