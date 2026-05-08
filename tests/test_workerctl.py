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

    def test_list_json_outputs_json_array(self):
        proc = self.run_workerctl("list", "--json")

        self.assertEqual(proc.returncode, 0, proc.stderr)
        data = json.loads(proc.stdout)
        self.assertIsInstance(data, list)

    def test_doctor_outputs_expected_structure(self):
        proc = self.run_workerctl("doctor")

        data = json.loads(proc.stdout)
        self.assertIn("checks", data)
        self.assertIn("workers", data)
        self.assertTrue(any(check["name"] == "tmux" for check in data["checks"]))
        self.assertTrue(any(check["name"] == "codex" for check in data["checks"]))

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
            original_run = commands.run
            try:
                commands.current_session_name = lambda: "raw-session"
                commands.current_pane_id = lambda target: "%7"

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
                commands.run = original_run
                if worker_path.exists():
                    shutil.rmtree(worker_path)

    def test_start_launches_normal_codex_tmux_session(self):
        launched = []
        original_run = commands.run
        try:
            def fake_run(argv, **kwargs):
                if argv[:3] == ["tmux", "has-session", "-t"]:
                    return subprocess.CompletedProcess(argv, 1, "", "")
                launched.append(argv)
                return subprocess.CompletedProcess(argv, 0, "", "")

            commands.run = fake_run
            args = argparse.Namespace(
                codex_args=["--model", "gpt-5.4-mini"],
                cwd=str(ROOT),
                session="qa-raw",
            )

            with contextlib.redirect_stdout(io.StringIO()) as stdout:
                result = commands.command_start(args)

            payload = json.loads(stdout.getvalue())
            self.assertEqual(result, 0)
            self.assertEqual(payload["session"], "qa-raw")
            self.assertEqual(payload["attach_command"], "tmux attach -t qa-raw")
            self.assertEqual(payload["manage_command"], "workerctl manage --worker <name> --task <task> --goal <goal>")
            self.assertEqual(launched[0][:5], ["tmux", "new-session", "-d", "-s", "qa-raw"])
            self.assertIn("codex --cd", launched[0][5])
            self.assertIn("--no-alt-screen", launched[0][5])
            self.assertIn("'--model' 'gpt-5.4-mini'", launched[0][5])
            self.assertIn("/bin':$PATH", launched[0][5])
        finally:
            commands.run = original_run

    def test_start_refuses_existing_tmux_session(self):
        original_run = commands.run
        try:
            commands.run = lambda argv, **kwargs: subprocess.CompletedProcess(argv, 0, "", "")
            args = argparse.Namespace(codex_args=[], cwd=str(ROOT), session="qa-raw")

            with self.assertRaisesRegex(WorkerError, "tmux session already exists"):
                commands.command_start(args)
        finally:
            commands.run = original_run

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
            try:
                commands.current_session_name = lambda: "raw-session"
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
            original_run = commands.run
            try:
                commands.current_session_name = lambda: "raw-session"
                commands.current_pane_id = lambda target: "%8"
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
                commands.run = original_run
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
            try:
                commands.capture_output = lambda name, lines: captured.append((name, lines)) or "terminal output"
                args = argparse.Namespace(task="task-a", lines=120, json=True, path=str(db_path))

                with contextlib.redirect_stdout(io.StringIO()) as stdout:
                    result = commands.command_task_capture(args)

                payload = json.loads(stdout.getvalue())
                self.assertEqual(result, 0)
                self.assertEqual(captured, [("worker-a", 120)])
                self.assertEqual(payload["binding_id"], "binding-1")
                self.assertEqual(payload["capture"]["output"], "terminal output")
                self.assertEqual(payload["worker"]["name"], "worker-a")
            finally:
                commands.capture_output = original_capture_output

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

    def test_pause_and_resume_manager_lifecycle(self):
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
                worker_identity.session_snapshot = lambda session: {"live": True, "pane_id": "%3", "session": session}

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
                "--path",
                str(db_path),
            )

            self.assertEqual(proc.returncode, 0, proc.stderr)
            payload = json.loads(proc.stdout)
            self.assertEqual(payload["export_dir"], str(output.resolve()))
            self.assertTrue((output / "manifest.json").exists())
            self.assertTrue((output / "task-status.json").exists())
            self.assertTrue(output.with_suffix(".zip").exists())

    def test_task_scoped_read_commands_are_listed_in_help(self):
        proc = self.run_workerctl("--help")

        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("audit", proc.stdout)
        self.assertIn("commands", proc.stdout)
        self.assertIn("import-compat", proc.stdout)
        self.assertIn("manage", proc.stdout)
        self.assertIn("name-session", proc.stdout)
        self.assertIn("pause-manager", proc.stdout)
        self.assertIn("prune", proc.stdout)
        self.assertIn("promote", proc.stdout)
        self.assertIn("recover", proc.stdout)
        self.assertIn("reconcile", proc.stdout)
        self.assertIn("resume-manager", proc.stdout)
        self.assertIn("self-promote", proc.stdout)
        self.assertIn("start", proc.stdout)
        self.assertIn("stop-task", proc.stdout)
        self.assertIn("close-stale", proc.stdout)
        self.assertIn("export-task", proc.stdout)
        self.assertIn("task-capture", proc.stdout)
        self.assertIn("task-events", proc.stdout)
        self.assertIn("task-idle-check", proc.stdout)
        self.assertIn("task-interrupt", proc.stdout)
        self.assertIn("task-nudge", proc.stdout)

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

    def test_install_local_write_is_idempotent(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            profile = Path(tmpdir) / ".zshrc"
            env = os.environ.copy()
            env["WORKERCTL_INSTALL_PROFILE"] = str(profile)
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


if __name__ == "__main__":
    unittest.main()
