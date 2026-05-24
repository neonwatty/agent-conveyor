from __future__ import annotations

import json
import sqlite3
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from workerctl.core import WorkerError
from workerctl.core import now_iso
from workerctl.state import state_root


SCHEMA_VERSION = 20
REQUIRED_TABLES = {
    "acceptance_criteria",
    "agent_observations",
    "bindings",
    "budgets",
    "codex_events",
    "command_attempts",
    "commands",
    "continuation_reviews",
    "data_migrations",
    "epilogue_runs",
    "events",
    "manager_configs",
    "manager_cycles",
    "manager_cycle_spans",
    "manager_decisions",
    "managers",
    "prompts",
    "routed_notifications",
    "runs",
    "schema_migrations",
    "sessions",
    "statuses",
    "tasks",
    "task_acknowledgements",
    "task_continuations",
    "telemetry_events",
    "telemetry_events_fts",
    "terminal_captures",
    "transcript_captures",
    "transcript_segments",
    "worker_handoffs",
    "workers",
}
REQUIRED_INDEXES = {
    "acceptance_criteria_task_source_criterion",
    "acceptance_criteria_task_status",
    "codex_events_session_id",
    "command_attempts_command_id",
    "command_attempts_correlation_id",
    "commands_task_state_created",
    "commands_claimable",
    "continuation_reviews_task",
    "events_task_id",
    "epilogue_runs_task_step",
    "manager_configs_task_id",
    "manager_cycle_spans_cycle_phase",
    "manager_cycle_spans_task",
    "one_active_binding_per_task",
    "one_active_run_per_task",
    "one_active_binding_per_manager_session",
    "one_active_binding_per_worker_session",
    "one_active_binding_per_worker",
    "one_active_manager_per_task",
    "agent_observations_task_id",
    "statuses_worker_id",
    "task_acknowledgements_task_role_revision",
    "task_continuations_task_role_revision",
    "runs_task_status",
    "routed_notifications_dedupe_key",
    "routed_notifications_claimable",
    "routed_notifications_source_event",
    "telemetry_events_actor_timestamp",
    "telemetry_events_run_timestamp",
    "telemetry_events_task_timestamp",
    "telemetry_events_type_timestamp",
    "terminal_captures_task_role",
    "transcript_captures_worker_id",
    "transcript_segments_task_role",
    "worker_handoffs_task_id",
}
REQUIRED_TRIGGERS = {
    "events_no_delete",
    "events_no_update",
}
ACCEPTANCE_CRITERION_STATUSES = {"proposed", "accepted", "satisfied", "deferred", "rejected"}
ACCEPTANCE_CRITERION_SOURCES = {"user_requested", "manager_inferred", "worker_proposed", "final_audit"}
TELEMETRY_ACTORS = {"dispatch", "manager", "operator", "system", "worker", "workerctl"}
TELEMETRY_SEVERITIES = {"debug", "error", "info", "warning"}
_PRESERVE_FIELD = object()
_MANAGER_PERMISSION_TAXONOMY = {
    "repo": {"open_pr", "push_branch", "merge_green_pr"},
    "verification": {"run_playwright", "run_xcodebuild", "run_pytest", "run_cargo"},
    "context": {"spawn_reviewer", "fetch_prs", "fetch_issues"},
    "communication": {"comment_on_pr", "notify_operator"},
    "worker_session": {"compact", "clear", "interrupt", "stop"},
}
_MANAGER_PERMISSION_ALIASES = {
    "allow_pr": "repo.open_pr",
    "create_pr": "repo.open_pr",
    "allow_merge_green": "repo.merge_green_pr",
    "merge_green_pr": "repo.merge_green_pr",
    "allow_worker_compact_clear": ["worker_session.compact", "worker_session.clear"],
    "worker_compact_clear": ["worker_session.compact", "worker_session.clear"],
}
_MANAGER_PERMISSION_ACTIONS = {
    f"{category}.{action}"
    for category, actions in _MANAGER_PERMISSION_TAXONOMY.items()
    for action in actions
}


class _ClosingConnection(sqlite3.Connection):
    def __exit__(self, exc_type, exc_value, traceback):
        try:
            return super().__exit__(exc_type, exc_value, traceback)
        finally:
            self.close()


def default_db_path() -> Path:
    return state_root() / "workerctl.db"


def _empty_manager_permissions() -> dict[str, list[str]]:
    return {category: [] for category in _MANAGER_PERMISSION_TAXONOMY}


def _grant_manager_permission(normalized: dict[str, list[str]], name: str) -> None:
    for canonical in _canonical_manager_permission_names(name):
        if "." not in canonical:
            continue
        category, action = canonical.split(".", 1)
        if action in _MANAGER_PERMISSION_TAXONOMY.get(category, set()):
            bucket = normalized.setdefault(category, [])
            if action not in bucket:
                bucket.append(action)
                bucket.sort()


def _canonical_manager_permission_names(name: str) -> list[str]:
    alias = _MANAGER_PERMISSION_ALIASES.get(name, name)
    return alias if isinstance(alias, list) else [alias]


def _validate_required_permission(required_permission: str | None) -> str | None:
    if required_permission is None:
        return None
    permission = required_permission.strip()
    if not permission:
        raise ValueError("required_permission must be non-empty when provided")
    unknown = [
        canonical
        for canonical in _canonical_manager_permission_names(permission)
        if canonical not in _MANAGER_PERMISSION_ACTIONS
    ]
    if unknown:
        raise ValueError(f"unknown required_permission: {required_permission}")
    return permission


def normalize_manager_permissions_json(permissions: dict[str, Any] | None) -> dict[str, list[str]]:
    normalized = _empty_manager_permissions()
    for key, value in (permissions or {}).items():
        if key in _MANAGER_PERMISSION_TAXONOMY and isinstance(value, list):
            for action in value:
                if action in _MANAGER_PERMISSION_TAXONOMY[key]:
                    _grant_manager_permission(normalized, f"{key}.{action}")
            continue
        if bool(value):
            _grant_manager_permission(normalized, key)
    return normalized


def connect(path: Path | None = None) -> sqlite3.Connection:
    db_path = path or default_db_path()
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(db_path, factory=_ClosingConnection)
    conn.row_factory = sqlite3.Row
    configure_connection(conn)
    return conn


def configure_connection(conn: sqlite3.Connection) -> None:
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA busy_timeout = 5000")
    foreign_keys = conn.execute("PRAGMA foreign_keys").fetchone()[0]
    if foreign_keys != 1:
        raise RuntimeError("SQLite foreign key enforcement is not enabled")


def initialize_database(conn: sqlite3.Connection) -> None:
    user_version = conn.execute("PRAGMA user_version").fetchone()[0]
    if user_version > SCHEMA_VERSION:
        raise RuntimeError(f"Database schema version {user_version} is newer than workerctl supports ({SCHEMA_VERSION})")
    migrate(conn, user_version)


def migrate(conn: sqlite3.Connection, from_version: int) -> None:
    if from_version > SCHEMA_VERSION:
        raise RuntimeError(f"Database schema version {from_version} is newer than workerctl supports ({SCHEMA_VERSION})")
    conn.executescript(
        """
        create table if not exists schema_migrations(
          version integer primary key,
          applied_at text not null
        );

        create table if not exists data_migrations(
          name text primary key,
          source_path text not null,
          source_hash text not null,
          applied_at text not null
        );

        create table if not exists workers(
          id text primary key,
          name text unique not null,
          tmux_session text unique not null,
          tmux_pane_id text,
          identity_token text unique not null,
          cwd text not null,
          state text not null check (state in ('candidate','active','stopped','missing','failed')),
          created_at text not null,
          updated_at text not null,
          last_seen_at text,
          exit_detected_at text,
          exit_reason text
        );

        create table if not exists tasks(
          id text primary key,
          name text not null,
          goal text not null,
          summary text,
          state text not null check (state in ('candidate','managed','paused','done','failed')),
          created_at text not null,
          updated_at text not null
        );

        create table if not exists acceptance_criteria(
          id integer primary key autoincrement,
          task_id text not null references tasks(id),
          criterion text not null,
          status text not null check (status in ('proposed','accepted','satisfied','deferred','rejected')),
          source text not null check (source in ('user_requested','manager_inferred','worker_proposed','final_audit')),
          proof text,
          rationale text,
          evidence_json text not null check (json_valid(evidence_json)),
          created_at text not null,
          updated_at text not null
        );

        create table if not exists managers(
          id text primary key,
          name text unique not null,
          task_id text not null references tasks(id),
          tmux_session text unique not null,
          tmux_pane_id text,
          state text not null check (state in ('starting','ready','stopping','stopped','missing','failed')),
          codex_args_json text not null check (json_valid(codex_args_json)),
          started_at text not null,
          stopped_at text,
          last_seen_at text,
          last_capture_sha256 text,
          exit_detected_at text,
          exit_reason text
        );

        create table if not exists bindings(
          id text primary key,
          task_id text not null references tasks(id),
          worker_id text references workers(id),
          manager_id text references managers(id),
          worker_session_id text references sessions(id),
          manager_session_id text references sessions(id),
          state text not null check (state in ('active','ending','ended','invalid')),
          created_at text not null,
          ended_at text
        );

        create table if not exists statuses(
          id integer primary key autoincrement,
          worker_id text not null references workers(id),
          state text not null check (state in ('planning','editing','running_tests','blocked','waiting','done','unknown')),
          current_task text,
          next_action text,
          blocker text,
          created_at text not null
        );

        create table if not exists prompts(
          id integer primary key autoincrement,
          task_id text references tasks(id),
          manager_id text references managers(id),
          kind text not null check (kind in ('manager','worker_contract','resume')),
          content text not null,
          content_sha256 text not null,
          generator_version text not null,
          source_snapshot_json text not null check (json_valid(source_snapshot_json)),
          policy_json text not null check (json_valid(policy_json)),
          artifact_path text,
          created_at text not null
        );

        create table if not exists transcript_captures(
          id integer primary key autoincrement,
          worker_id text not null references workers(id),
          sha256 text not null,
          content text,
          captured_at text not null,
          changed_at text not null,
          history_lines integer not null,
          byte_count integer not null,
          line_count integer not null,
          capture_kind text not null check (capture_kind in ('latest','changed','metadata_only','archived')),
          retention_class text not null check (retention_class in ('hot','warm','archive'))
        );

        create table if not exists terminal_captures(
          id integer primary key autoincrement,
          task_id text not null references tasks(id),
          worker_id text references workers(id),
          manager_id text references managers(id),
          role text not null check (role in ('worker','manager')),
          tmux_session text not null,
          tmux_pane_id text,
          command_id text references commands(id),
          captured_at text not null,
          history_lines integer not null,
          content_sha256 text not null,
          content text,
          content_path text,
          byte_count integer not null,
          line_count integer not null,
          classifier_json text not null check (json_valid(classifier_json)),
          source text not null
        );

        create table if not exists transcript_segments(
          id integer primary key autoincrement,
          task_id text not null references tasks(id),
          role text not null check (role in ('worker','manager')),
          source_capture_id integer not null references terminal_captures(id),
          previous_capture_id integer references terminal_captures(id),
          captured_at text not null,
          content_sha256 text not null,
          segment_text text,
          segment_start_line integer,
          segment_end_line integer,
          byte_count integer not null,
          line_count integer not null,
          retention_class text not null check (retention_class in ('hot','warm','cold','redacted')),
          segment_kind text not null check (segment_kind in ('metadata','excerpt','snapshot','segment','reset')),
          redacted integer not null default 0 check (redacted in (0, 1)),
          created_at text not null
        );

        create table if not exists agent_observations(
          id integer primary key autoincrement,
          task_id text not null references tasks(id),
          worker_id text references workers(id),
          manager_id text references managers(id),
          role text not null check (role in ('worker','manager','workerctl')),
          observation_type text not null check (observation_type in ('status','error','decision','blocker','summary','command_output','health','capture')),
          severity text not null check (severity in ('info','warning','error')),
          source_capture_id integer references terminal_captures(id),
          command_id text references commands(id),
          created_at text not null,
          message text not null,
          payload_json text not null check (json_valid(payload_json))
        );

        create table if not exists manager_cycles(
          id integer primary key autoincrement,
          task_id text not null references tasks(id),
          manager_id text references managers(id),
          started_at text not null,
          completed_at text,
          state text not null check (state in ('started','succeeded','failed')),
          health_observation_id integer references agent_observations(id),
          manager_capture_id integer references terminal_captures(id),
          worker_capture_id integer references terminal_captures(id),
          status_json text check (status_json is null or json_valid(status_json)),
          health_json text check (health_json is null or json_valid(health_json)),
          decision text,
          error text
        );

        create table if not exists manager_cycle_spans(
          id integer primary key autoincrement,
          manager_cycle_id integer not null references manager_cycles(id),
          task_id text not null references tasks(id),
          run_id text references runs(id),
          phase text not null,
          started_at text not null,
          completed_at text not null,
          duration_ms real not null check (duration_ms >= 0),
          state text not null check (state in ('succeeded','failed','degraded')),
          attributes_json text not null check (json_valid(attributes_json)),
          error_type text,
          manager_decision_id integer references manager_decisions(id),
          command_id text references commands(id)
        );

        create table if not exists worker_handoffs(
          id integer primary key autoincrement,
          task_id text not null references tasks(id),
          worker_session_id text references sessions(id),
          summary text not null,
          next_steps_json text not null check (json_valid(next_steps_json)),
          payload_json text not null check (json_valid(payload_json)),
          created_at text not null
        );

        create table if not exists task_acknowledgements(
          id integer primary key autoincrement,
          task_id text not null references tasks(id),
          binding_id text references bindings(id),
          role text not null check (role in ('worker','manager')),
          payload_json text not null check (json_valid(payload_json)),
          revision integer not null check (revision > 0),
          manager_config_revision integer check (manager_config_revision is null or manager_config_revision > 0),
          created_at text not null,
          correlation_id text
        );

        create table if not exists task_continuations(
          id integer primary key autoincrement,
          task_id text not null references tasks(id),
          proposer text not null check (proposer in ('worker','manager')),
          payload_json text not null check (json_valid(payload_json)),
          revision integer not null check (revision > 0),
          created_at text not null,
          correlation_id text not null
        );

        create table if not exists continuation_reviews(
          id integer primary key autoincrement,
          task_id text not null references tasks(id),
          worker_continuation_id integer not null references task_continuations(id),
          manager_continuation_id integer not null references task_continuations(id),
          agreement text not null check (agreement in ('match','compatible','divergent')),
          verdict text not null check (verdict in ('proceed','amend','stop')),
          addendum text,
          rationale text not null,
          subagent_run_json text not null check (json_valid(subagent_run_json)),
          created_at text not null,
          correlation_id text not null
        );

        create table if not exists manager_configs(
          task_id text primary key references tasks(id),
          supervision_mode text not null check (supervision_mode in ('light','guided','strict')),
          objective text,
          guidelines_json text not null check (json_valid(guidelines_json)),
          acceptance_criteria_json text not null check (json_valid(acceptance_criteria_json)),
          reference_paths_json text not null check (json_valid(reference_paths_json)),
          permissions_json text not null check (json_valid(permissions_json)),
          tools_json text not null default '[]' check (json_valid(tools_json)),
          epilogues_json text not null default '[]' check (json_valid(epilogues_json)),
          nudge_on_completion text not null default 'ask-operator' check (nudge_on_completion in ('off','ask-operator','auto-review','auto-proceed')),
          require_acks integer not null default 0 check (require_acks in (0, 1)),
          revision integer not null default 1 check (revision > 0),
          created_at text not null,
          updated_at text not null
        );

        create table if not exists epilogue_runs(
          id integer primary key autoincrement,
          task_id text not null references tasks(id),
          step_name text not null,
          state text not null check (state in ('pending','running','succeeded','failed','skipped')),
          started_at text not null,
          finished_at text,
          result_json text check (result_json is null or json_valid(result_json)),
          error text,
          correlation_id text
        );

        create table if not exists runs(
          id text primary key,
          task_id text not null references tasks(id),
          name text not null,
          purpose text,
          status text not null check (status in ('active','finished','failed','abandoned')),
          started_at text not null,
          ended_at text,
          metadata_json text not null check (json_valid(metadata_json))
        );

        create table if not exists telemetry_events(
          id text primary key,
          run_id text references runs(id),
          task_id text references tasks(id),
          timestamp text not null,
          actor text not null check (actor in ('dispatch','manager','worker','operator','workerctl','system')),
          event_type text not null,
          severity text not null check (severity in ('debug','info','warning','error')),
          summary text not null,
          correlation_json text not null check (json_valid(correlation_json)),
          attributes_json text not null check (json_valid(attributes_json))
        );

        create virtual table if not exists telemetry_events_fts using fts5(
          event_id unindexed,
          task_id unindexed,
          run_id unindexed,
          actor unindexed,
          event_type unindexed,
          summary,
          attributes
        );

        create table if not exists manager_decisions(
          id integer primary key autoincrement,
          task_id text not null references tasks(id),
          manager_id text references managers(id),
          manager_cycle_id integer references manager_cycles(id),
          decision text not null check (decision in ('wait','nudge','interrupt','escalate','stop','inspect')),
          reason text not null,
          created_at text not null,
          payload_json text not null check (json_valid(payload_json))
        );

        create table if not exists budgets(
          task_id text primary key references tasks(id),
          max_nudges integer not null check (max_nudges >= 0),
          nudges_used integer not null default 0 check (nudges_used >= 0),
          expires_at text not null,
          check (nudges_used <= max_nudges)
        );

        create table if not exists commands(
          id text primary key,
          idempotency_key text unique not null,
          created_at text not null,
          updated_at text not null,
          task_id text references tasks(id),
          worker_id text references workers(id),
          manager_id text references managers(id),
          correlation_id text,
          type text not null,
          state text not null check (state in ('pending','attempted','succeeded','failed')),
          available_at text,
          claimed_by text,
          claimed_at text,
          claim_expires_at text,
          attempts integer not null default 0 check (attempts >= 0),
          max_attempts integer not null default 1 check (max_attempts > 0),
          required_permission text,
          payload_json text not null check (json_valid(payload_json)),
          result_json text check (result_json is null or json_valid(result_json)),
          error text
        );

        create table if not exists command_attempts(
          id integer primary key autoincrement,
          command_id text not null references commands(id),
          correlation_id text not null,
          dispatcher_id text not null,
          started_at text not null,
          finished_at text,
          state text not null check (state in ('running','succeeded','failed','abandoned')),
          result_json text check (result_json is null or json_valid(result_json)),
          error text,
          side_effect_started integer not null default 0 check (side_effect_started in (0, 1)),
          side_effect_completed integer not null default 0 check (side_effect_completed in (0, 1))
        );

        create table if not exists events(
          id integer primary key autoincrement,
          created_at text not null,
          actor text not null,
          command_id text references commands(id),
          correlation_id text,
          task_id text references tasks(id),
          worker_id text references workers(id),
          manager_id text references managers(id),
          type text not null,
          payload_json text not null check (json_valid(payload_json))
        );

        create table if not exists routed_notifications(
          id integer primary key autoincrement,
          task_id text not null references tasks(id),
          binding_id text not null references bindings(id),
          correlation_id text not null,
          source_session_id text not null references sessions(id),
          target_session_id text not null references sessions(id),
          signal_type text not null,
          source_event_id integer references codex_events(id),
          source_event_timestamp text,
          dedupe_key text not null unique,
          command_id text references commands(id),
          created_at text not null,
          delivered_at text,
          consumed_manager_cycle_id integer references manager_cycles(id),
          consumed_at text,
          state text not null check (state in ('pending','delivered','failed','suppressed')),
          claimed_by text,
          claimed_at text,
          claim_expires_at text,
          side_effect_started integer not null default 0 check (side_effect_started in (0, 1)),
          side_effect_completed integer not null default 0 check (side_effect_completed in (0, 1)),
          payload_json text not null check (json_valid(payload_json)),
          error text
        );

        create table if not exists codex_events(
          id integer primary key autoincrement,
          session_id text not null references sessions(id),
          timestamp text not null,
          type text not null,
          subtype text,
          payload_json text not null check (json_valid(payload_json)),
          byte_offset integer not null,
          ingested_at text not null
        );

        create table if not exists sessions(
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

        create unique index if not exists one_active_binding_per_worker
        on bindings(worker_id)
        where state in ('active', 'ending');

        create unique index if not exists one_active_binding_per_task
        on bindings(task_id)
        where state in ('active', 'ending');

        create unique index if not exists one_active_manager_per_task
        on managers(task_id)
        where state in ('starting', 'ready', 'stopping');

        create unique index if not exists one_active_run_per_task
        on runs(task_id)
        where status = 'active';

        create index if not exists runs_task_status
        on runs(task_id, status, started_at);

        create index if not exists telemetry_events_run_timestamp
        on telemetry_events(run_id, timestamp, id);

        create index if not exists telemetry_events_task_timestamp
        on telemetry_events(task_id, timestamp, id);

        create index if not exists telemetry_events_type_timestamp
        on telemetry_events(event_type, timestamp, id);

        create index if not exists telemetry_events_actor_timestamp
        on telemetry_events(actor, timestamp, id);

        create index if not exists events_task_id
        on events(task_id, id);

        create index if not exists worker_handoffs_task_id
        on worker_handoffs(task_id, id);

        create index if not exists task_acknowledgements_task_role_revision
        on task_acknowledgements(task_id, role, revision desc, id desc);

        create index if not exists task_continuations_task_role_revision
        on task_continuations(task_id, proposer, revision desc, id desc);

        create index if not exists continuation_reviews_task
        on continuation_reviews(task_id, id);

        create index if not exists epilogue_runs_task_step
        on epilogue_runs(task_id, step_name, id);

        create unique index if not exists routed_notifications_dedupe_key
        on routed_notifications(dedupe_key);

        create index if not exists routed_notifications_source_event
        on routed_notifications(source_event_id);

        create index if not exists routed_notifications_consumed_cycle
        on routed_notifications(consumed_manager_cycle_id);

        create index if not exists routed_notifications_claimable
        on routed_notifications(state, signal_type, side_effect_started, claim_expires_at, created_at);

        create index if not exists manager_configs_task_id
        on manager_configs(task_id);

        create index if not exists manager_cycle_spans_cycle_phase
        on manager_cycle_spans(manager_cycle_id, phase, id);

        create index if not exists manager_cycle_spans_task
        on manager_cycle_spans(task_id, id);

        create index if not exists codex_events_session_id
        on codex_events(session_id, id);

        create index if not exists commands_task_state_created
        on commands(task_id, state, created_at);

        create index if not exists command_attempts_command_id
        on command_attempts(command_id, id);

        create index if not exists command_attempts_correlation_id
        on command_attempts(correlation_id);

        create index if not exists statuses_worker_id
        on statuses(worker_id, id);

        create index if not exists terminal_captures_task_role
        on terminal_captures(task_id, role, id);

        create index if not exists agent_observations_task_id
        on agent_observations(task_id, id);

        create index if not exists transcript_captures_worker_id
        on transcript_captures(worker_id, id);

        create index if not exists transcript_segments_task_role
        on transcript_segments(task_id, role, id);

        create index if not exists acceptance_criteria_task_status
        on acceptance_criteria(task_id, status, id);

        create unique index if not exists acceptance_criteria_task_source_criterion
        on acceptance_criteria(task_id, source, criterion);

        create trigger if not exists events_no_update
        before update on events
        begin
          select raise(abort, 'events are append-only');
        end;

        create trigger if not exists events_no_delete
        before delete on events
        begin
          select raise(abort, 'events are append-only');
        end;
        """
    )
    if from_version < 2:
        migrate_worker_name_ids(conn)
    # Always run v5 invariant repair. Internals are idempotent: bindings rebuild is
    # guarded by column-presence check, backfills use `insert or ignore`, and index
    # creates use `if not exists`. This protects against partial-migration states
    # like the one observed when sessions table was added under a separate commit
    # before the bindings rebuild logic existed.
    migrate_to_v5_sessions(conn)
    # Phase 2 invariant repair. Always runs; the inner check makes it idempotent.
    migrate_to_v6_codex_events(conn)
    migrate_to_v10_manager_config_tools(conn)
    migrate_to_v12_manager_config_require_acks(conn)
    migrate_to_v13_routed_notifications(conn)
    migrate_to_v14_epilogues(conn)
    migrate_to_v15_continuations(conn)
    migrate_to_v16_dispatch_command_attempts(conn)
    migrate_to_v17_command_required_permission(conn)
    migrate_to_v18_manager_cycle_spans(conn)
    migrate_to_v19_dispatch_consumption_and_ack_revisions(conn)
    migrate_to_v20_routed_notification_claims(conn)
    sync_worker_ids_to_config_files(conn)
    conn.execute(
        "insert or ignore into schema_migrations(version, applied_at) values (?, ?)",
        (SCHEMA_VERSION, now_iso()),
    )
    conn.execute(f"PRAGMA user_version = {SCHEMA_VERSION}")
    conn.commit()


def migrate_worker_name_ids(conn: sqlite3.Connection) -> None:
    legacy_rows = conn.execute("select id, name from workers where id = name").fetchall()
    if not legacy_rows:
        return
    id_map = {str(row["id"]): f"worker-{uuid.uuid4()}" for row in legacy_rows}
    now = now_iso()
    conn.commit()
    conn.execute("PRAGMA foreign_keys = OFF")
    try:
        conn.execute("begin")
        conn.execute("drop trigger if exists events_no_update")
        conn.execute("drop trigger if exists events_no_delete")
        for old_id, new_id in id_map.items():
            for table in ("bindings", "statuses", "transcript_captures", "commands", "events"):
                conn.execute(f"update {table} set worker_id = ? where worker_id = ?", (new_id, old_id))
            conn.execute("update workers set id = ?, updated_at = ? where id = ?", (new_id, now, old_id))
            conn.execute(
                """
                insert into events(created_at, actor, type, worker_id, payload_json)
                values (?, 'workerctl', 'worker_id_migrated', ?, ?)
                """,
                (
                    now,
                    new_id,
                    json.dumps({"old_worker_id": old_id, "new_worker_id": new_id}, sort_keys=True),
                ),
            )
        conn.execute(
            """
            create trigger events_no_update
            before update on events
            begin
              select raise(abort, 'events are append-only');
            end
            """
        )
        conn.execute(
            """
            create trigger events_no_delete
            before delete on events
            begin
              select raise(abort, 'events are append-only');
            end
            """
        )
        conn.execute(
            "insert or ignore into schema_migrations(version, applied_at) values (?, ?)",
            (2, now),
        )
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.execute("PRAGMA foreign_keys = ON")


def migrate_to_v5_sessions(conn: sqlite3.Connection) -> None:
    """Backfill `sessions` from existing `workers` and `managers` rows.

    Idempotent: uses `insert or ignore` so re-running does not duplicate. Maps:
    - workers -> sessions with role='worker', state='active' (regardless of legacy state).
    - managers -> sessions with role='manager', state='active'.

    Codex-session fields (path, id, pid) are left null; they only populate for sessions
    registered via the new `register-*` commands.
    """
    existing_cols = {row["name"] for row in conn.execute("pragma table_info(bindings)")}
    if "worker_session_id" not in existing_cols:
        # SQLite has no DROP NOT NULL; we rebuild the table to make worker_id nullable
        # and to add the new columns. The parent `migrate()` runs in autocommit mode
        # for the executescript above; we don't need an explicit transaction here.
        conn.executescript(
            """
            alter table bindings rename to bindings_v4;
            create table bindings(
              id text primary key,
              task_id text not null references tasks(id),
              worker_id text references workers(id),
              manager_id text references managers(id),
              worker_session_id text references sessions(id),
              manager_session_id text references sessions(id),
              state text not null check (state in ('active','ending','ended','invalid')),
              created_at text not null,
              ended_at text
            );
            insert into bindings(
              id, task_id, worker_id, manager_id,
              worker_session_id, manager_session_id,
              state, created_at, ended_at
            )
            select id, task_id, worker_id, manager_id, null, null, state, created_at, ended_at
            from bindings_v4;
            drop table bindings_v4;
            """
        )
        # Re-create the existing unique indexes which were dropped with the table.
        conn.executescript(
            """
            create unique index if not exists one_active_binding_per_worker
              on bindings(worker_id) where state in ('active', 'ending');
            create unique index if not exists one_active_binding_per_task
              on bindings(task_id) where state in ('active', 'ending');
            create unique index if not exists one_active_binding_per_worker_session
              on bindings(worker_session_id) where state in ('active', 'ending');
            create unique index if not exists one_active_binding_per_manager_session
              on bindings(manager_session_id) where state in ('active', 'ending');
            """
        )

    now = now_iso()
    worker_rows = conn.execute(
        """
        select id, name, tmux_session, tmux_pane_id, identity_token, cwd, created_at
        from workers
        """
    ).fetchall()
    for row in worker_rows:
        conn.execute(
            """
            insert or ignore into sessions(
              id, name, role, identity_token,
              tmux_session, tmux_pane_id,
              cwd, registered_at, state
            )
            values (?, ?, 'worker', ?, ?, ?, ?, ?, 'active')
            """,
            (
                row["id"], row["name"], row["identity_token"],
                row["tmux_session"], row["tmux_pane_id"],
                row["cwd"], row["created_at"] or now,
            ),
        )

    manager_rows = conn.execute(
        """
        select m.id, m.name, m.tmux_session, m.tmux_pane_id, m.started_at, t.id as task_id
        from managers m
        left join tasks t on t.id = m.task_id
        """
    ).fetchall()
    for row in manager_rows:
        conn.execute(
            """
            insert or ignore into sessions(
              id, name, role, identity_token,
              tmux_session, tmux_pane_id,
              cwd, registered_at, state
            )
            values (?, ?, 'manager', ?, ?, ?, ?, ?, 'active')
            """,
            (
                row["id"], row["name"], f"legacy-manager-token-{uuid.uuid4()}",
                row["tmux_session"], row["tmux_pane_id"],
                "",  # historical managers don't track cwd separately; empty is acceptable
                row["started_at"] or now,
            ),
        )

    # Ensure the two session-id partial unique indexes exist regardless of whether
    # the rebuild branch ran. On fresh DBs the executescript above created the new
    # bindings columns but did not create these indexes; on upgraded DBs the rebuild
    # branch already created them and these statements no-op due to `if not exists`.
    conn.executescript(
        """
        create unique index if not exists one_active_binding_per_worker_session
        on bindings(worker_session_id) where state in ('active', 'ending');
        create unique index if not exists one_active_binding_per_manager_session
        on bindings(manager_session_id) where state in ('active', 'ending');
        """
    )


def migrate_to_v6_codex_events(conn: sqlite3.Connection) -> None:
    """Add `last_ingest_offset` column to `sessions` if missing. Idempotent."""
    existing_cols = {row["name"] for row in conn.execute("pragma table_info(sessions)")}
    if "last_ingest_offset" not in existing_cols:
        conn.execute("alter table sessions add column last_ingest_offset integer")


def migrate_to_v10_manager_config_tools(conn: sqlite3.Connection) -> None:
    """Add `tools_json` to manager_configs if missing. Idempotent."""
    existing_cols = {row["name"] for row in conn.execute("pragma table_info(manager_configs)")}
    if "tools_json" not in existing_cols:
        conn.execute("alter table manager_configs add column tools_json text not null default '[]' check (json_valid(tools_json))")


def migrate_to_v12_manager_config_require_acks(conn: sqlite3.Connection) -> None:
    """Add `require_acks` to manager_configs if missing. Idempotent."""
    existing_cols = {row["name"] for row in conn.execute("pragma table_info(manager_configs)")}
    if "require_acks" not in existing_cols:
        conn.execute("alter table manager_configs add column require_acks integer not null default 0 check (require_acks in (0, 1))")


def migrate_to_v13_routed_notifications(conn: sqlite3.Connection) -> None:
    """Add the Dispatch routed notification table and indexes. Idempotent."""
    telemetry_schema = conn.execute(
        "select sql from sqlite_master where type = 'table' and name = 'telemetry_events'"
    ).fetchone()
    if telemetry_schema is not None and "'dispatch'" not in (telemetry_schema["sql"] or ""):
        conn.executescript(
            """
            create table telemetry_events_v13(
              id text primary key,
              run_id text references runs(id),
              task_id text references tasks(id),
              timestamp text not null,
              actor text not null check (actor in ('dispatch','manager','worker','operator','workerctl','system')),
              event_type text not null,
              severity text not null check (severity in ('debug','info','warning','error')),
              summary text not null,
              correlation_json text not null check (json_valid(correlation_json)),
              attributes_json text not null check (json_valid(attributes_json))
            );

            insert into telemetry_events_v13(
              id, run_id, task_id, timestamp, actor, event_type, severity,
              summary, correlation_json, attributes_json
            )
            select id, run_id, task_id, timestamp, actor, event_type, severity,
                   summary, correlation_json, attributes_json
            from telemetry_events;

            drop table telemetry_events;
            alter table telemetry_events_v13 rename to telemetry_events;

            create index if not exists telemetry_events_run_timestamp
            on telemetry_events(run_id, timestamp, id);

            create index if not exists telemetry_events_task_timestamp
            on telemetry_events(task_id, timestamp, id);

            create index if not exists telemetry_events_type_timestamp
            on telemetry_events(event_type, timestamp, id);

            create index if not exists telemetry_events_actor_timestamp
            on telemetry_events(actor, timestamp, id);
            """
        )
    conn.executescript(
        """
        create table if not exists routed_notifications(
          id integer primary key autoincrement,
          task_id text not null references tasks(id),
          binding_id text not null references bindings(id),
          correlation_id text not null,
          source_session_id text not null references sessions(id),
          target_session_id text not null references sessions(id),
          signal_type text not null,
          source_event_id integer references codex_events(id),
          source_event_timestamp text,
          dedupe_key text not null unique,
          command_id text references commands(id),
          created_at text not null,
          delivered_at text,
          state text not null check (state in ('pending','delivered','failed','suppressed')),
          payload_json text not null check (json_valid(payload_json)),
          error text
        );

        create unique index if not exists routed_notifications_dedupe_key
        on routed_notifications(dedupe_key);

        create index if not exists routed_notifications_source_event
        on routed_notifications(source_event_id);
        """
    )


def migrate_to_v14_epilogues(conn: sqlite3.Connection) -> None:
    """Add manager epilogue configuration and durable epilogue run rows."""
    existing_cols = {row["name"] for row in conn.execute("pragma table_info(manager_configs)")}
    if "epilogues_json" not in existing_cols:
        conn.execute("alter table manager_configs add column epilogues_json text not null default '[]' check (json_valid(epilogues_json))")
    conn.executescript(
        """
        create table if not exists epilogue_runs(
          id integer primary key autoincrement,
          task_id text not null references tasks(id),
          step_name text not null,
          state text not null check (state in ('pending','running','succeeded','failed','skipped')),
          started_at text not null,
          finished_at text,
          result_json text check (result_json is null or json_valid(result_json)),
          error text,
          correlation_id text
        );

        create index if not exists epilogue_runs_task_step
        on epilogue_runs(task_id, step_name, id);
        """
    )


def migrate_to_v15_continuations(conn: sqlite3.Connection) -> None:
    """Add continuation proposal/review tables and nudge-on-completion config."""
    existing_cols = {row["name"] for row in conn.execute("pragma table_info(manager_configs)")}
    if "nudge_on_completion" not in existing_cols:
        conn.execute(
            "alter table manager_configs add column nudge_on_completion text not null default 'ask-operator' "
            "check (nudge_on_completion in ('off','ask-operator','auto-review','auto-proceed'))"
        )
    conn.executescript(
        """
        create table if not exists task_continuations(
          id integer primary key autoincrement,
          task_id text not null references tasks(id),
          proposer text not null check (proposer in ('worker','manager')),
          payload_json text not null check (json_valid(payload_json)),
          revision integer not null check (revision > 0),
          created_at text not null,
          correlation_id text not null
        );

        create table if not exists continuation_reviews(
          id integer primary key autoincrement,
          task_id text not null references tasks(id),
          worker_continuation_id integer not null references task_continuations(id),
          manager_continuation_id integer not null references task_continuations(id),
          agreement text not null check (agreement in ('match','compatible','divergent')),
          verdict text not null check (verdict in ('proceed','amend','stop')),
          addendum text,
          rationale text not null,
          subagent_run_json text not null check (json_valid(subagent_run_json)),
          created_at text not null,
          correlation_id text not null
        );

        create index if not exists task_continuations_task_role_revision
        on task_continuations(task_id, proposer, revision desc, id desc);

        create index if not exists continuation_reviews_task
        on continuation_reviews(task_id, id);
        """
    )


def _add_column_if_missing(conn: sqlite3.Connection, table: str, column: str, definition: str) -> None:
    existing_cols = {row["name"] for row in conn.execute(f"pragma table_info({table})")}
    if column not in existing_cols:
        conn.execute(f"alter table {table} add column {column} {definition}")


def migrate_to_v16_dispatch_command_attempts(conn: sqlite3.Connection) -> None:
    """Add Dispatch command lease metadata and durable attempt rows. Idempotent."""
    _add_column_if_missing(conn, "commands", "correlation_id", "text")
    _add_column_if_missing(conn, "commands", "available_at", "text")
    _add_column_if_missing(conn, "commands", "claimed_by", "text")
    _add_column_if_missing(conn, "commands", "claimed_at", "text")
    _add_column_if_missing(conn, "commands", "claim_expires_at", "text")
    _add_column_if_missing(
        conn,
        "commands",
        "attempts",
        "integer not null default 0 check (attempts >= 0)",
    )
    _add_column_if_missing(
        conn,
        "commands",
        "max_attempts",
        "integer not null default 1 check (max_attempts > 0)",
    )
    conn.executescript(
        """
        create table if not exists command_attempts(
          id integer primary key autoincrement,
          command_id text not null references commands(id),
          correlation_id text not null,
          dispatcher_id text not null,
          started_at text not null,
          finished_at text,
          state text not null check (state in ('running','succeeded','failed','abandoned')),
          result_json text check (result_json is null or json_valid(result_json)),
          error text,
          side_effect_started integer not null default 0 check (side_effect_started in (0, 1)),
          side_effect_completed integer not null default 0 check (side_effect_completed in (0, 1))
        );

        create index if not exists commands_claimable
        on commands(state, type, available_at, created_at, id);

        create index if not exists command_attempts_command_id
        on command_attempts(command_id, id);

        create index if not exists command_attempts_correlation_id
        on command_attempts(correlation_id);
        """
    )


def migrate_to_v17_command_required_permission(conn: sqlite3.Connection) -> None:
    """Add optional manager permission metadata to queued commands. Idempotent."""
    _add_column_if_missing(conn, "commands", "required_permission", "text")


def migrate_to_v18_manager_cycle_spans(conn: sqlite3.Connection) -> None:
    """Add trace-style phase spans for manager supervision cycles."""
    conn.executescript(
        """
        create table if not exists manager_cycle_spans(
          id integer primary key autoincrement,
          manager_cycle_id integer not null references manager_cycles(id),
          task_id text not null references tasks(id),
          run_id text references runs(id),
          phase text not null,
          started_at text not null,
          completed_at text not null,
          duration_ms real not null check (duration_ms >= 0),
          state text not null check (state in ('succeeded','failed','degraded')),
          attributes_json text not null check (json_valid(attributes_json)),
          error_type text,
          manager_decision_id integer references manager_decisions(id),
          command_id text references commands(id)
        );

        create index if not exists manager_cycle_spans_cycle_phase
        on manager_cycle_spans(manager_cycle_id, phase, id);

        create index if not exists manager_cycle_spans_task
        on manager_cycle_spans(task_id, id);
        """
    )


def migrate_to_v19_dispatch_consumption_and_ack_revisions(conn: sqlite3.Connection) -> None:
    """Bind dispatch consumption and acknowledgements to explicit revisions."""
    _add_column_if_missing(conn, "routed_notifications", "consumed_manager_cycle_id", "integer references manager_cycles(id)")
    _add_column_if_missing(conn, "routed_notifications", "consumed_at", "text")
    _add_column_if_missing(
        conn,
        "task_acknowledgements",
        "manager_config_revision",
        "integer check (manager_config_revision is null or manager_config_revision > 0)",
    )
    _add_column_if_missing(conn, "manager_configs", "revision", "integer not null default 1 check (revision > 0)")
    conn.execute(
        """
        create index if not exists routed_notifications_consumed_cycle
        on routed_notifications(consumed_manager_cycle_id)
        """
    )


def migrate_to_v20_routed_notification_claims(conn: sqlite3.Connection) -> None:
    """Track completion notification delivery claims and side-effect risk."""
    _add_column_if_missing(conn, "routed_notifications", "claimed_by", "text")
    _add_column_if_missing(conn, "routed_notifications", "claimed_at", "text")
    _add_column_if_missing(conn, "routed_notifications", "claim_expires_at", "text")
    _add_column_if_missing(
        conn,
        "routed_notifications",
        "side_effect_started",
        "integer not null default 0 check (side_effect_started in (0, 1))",
    )
    _add_column_if_missing(
        conn,
        "routed_notifications",
        "side_effect_completed",
        "integer not null default 0 check (side_effect_completed in (0, 1))",
    )
    conn.execute(
        """
        create index if not exists routed_notifications_claimable
        on routed_notifications(state, signal_type, side_effect_started, claim_expires_at, created_at)
        """
    )


def sync_worker_ids_to_config_files(conn: sqlite3.Connection) -> None:
    database_path = conn.execute("PRAGMA database_list").fetchone()["file"]
    if Path(database_path).resolve() != default_db_path().resolve():
        return
    for row in conn.execute("select id, name from workers"):
        config_path = state_root() / str(row["name"]) / "config.json"
        if not config_path.exists():
            continue
        try:
            config = json.loads(config_path.read_text())
        except (OSError, json.JSONDecodeError):
            continue
        if config.get("worker_id") == row["id"]:
            continue
        config["worker_id"] = row["id"]
        config_path.write_text(json.dumps(config, indent=2, sort_keys=True) + "\n")


def database_health(conn: sqlite3.Connection) -> dict[str, Any]:
    foreign_keys = conn.execute("PRAGMA foreign_keys").fetchone()[0]
    journal_mode = conn.execute("PRAGMA journal_mode").fetchone()[0]
    busy_timeout = conn.execute("PRAGMA busy_timeout").fetchone()[0]
    user_version = conn.execute("PRAGMA user_version").fetchone()[0]
    schema_version = conn.execute("select max(version) from schema_migrations").fetchone()[0]

    tables = {
        row["name"]
        for row in conn.execute(
            "select name from sqlite_master where type = 'table' and name not like 'sqlite_%'"
        )
    }
    indexes = {
        row["name"]
        for row in conn.execute("select name from sqlite_master where type = 'index' and name not like 'sqlite_%'")
    }
    triggers = {row["name"] for row in conn.execute("select name from sqlite_master where type = 'trigger'")}
    foreign_key_violations = [
        dict(row)
        for row in conn.execute(
            """
            select "table", rowid, parent, fkid
            from pragma_foreign_key_check
            """
        )
    ]

    checks = [
        {"name": "foreign_keys", "ok": foreign_keys == 1, "value": foreign_keys},
        {"name": "journal_mode_wal", "ok": str(journal_mode).lower() == "wal", "value": journal_mode},
        {"name": "busy_timeout", "ok": busy_timeout >= 5000, "value": busy_timeout},
        {"name": "schema_version", "ok": schema_version == SCHEMA_VERSION, "value": schema_version},
        {"name": "user_version", "ok": user_version == SCHEMA_VERSION, "value": user_version},
        {"name": "required_tables", "ok": REQUIRED_TABLES <= tables, "missing": sorted(REQUIRED_TABLES - tables)},
        {"name": "required_indexes", "ok": REQUIRED_INDEXES <= indexes, "missing": sorted(REQUIRED_INDEXES - indexes)},
        {"name": "required_triggers", "ok": REQUIRED_TRIGGERS <= triggers, "missing": sorted(REQUIRED_TRIGGERS - triggers)},
        {
            "name": "foreign_key_check",
            "ok": not foreign_key_violations,
            "violations": foreign_key_violations,
        },
    ]
    return {
        "checks": checks,
        "ok": all(check["ok"] for check in checks),
        "schema_version": schema_version,
        "user_version": user_version,
    }


def insert_event(
    conn: sqlite3.Connection,
    event_type: str,
    *,
    actor: str,
    payload: dict[str, Any] | None = None,
    command_id: str | None = None,
    correlation_id: str | None = None,
    task_id: str | None = None,
    worker_id: str | None = None,
    manager_id: str | None = None,
) -> int:
    cursor = conn.execute(
        """
        insert into events(
          created_at, actor, command_id, correlation_id, task_id, worker_id,
          manager_id, type, payload_json
        )
        values (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            now_iso(),
            actor,
            command_id,
            correlation_id,
            task_id,
            worker_id,
            manager_id,
            event_type,
            json.dumps(payload or {}, sort_keys=True),
        ),
    )
    return int(cursor.lastrowid)


def _command_record(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "attempts": row["attempts"],
        "available_at": row["available_at"],
        "claim_expires_at": row["claim_expires_at"],
        "claimed_at": row["claimed_at"],
        "claimed_by": row["claimed_by"],
        "correlation_id": row["correlation_id"],
        "created_at": row["created_at"],
        "error": row["error"],
        "id": row["id"],
        "idempotency_key": row["idempotency_key"],
        "manager_id": row["manager_id"],
        "max_attempts": row["max_attempts"],
        "payload": json.loads(row["payload_json"]),
        "required_permission": row["required_permission"],
        "result": json.loads(row["result_json"]) if row["result_json"] else None,
        "state": row["state"],
        "task_id": row["task_id"],
        "type": row["type"],
        "updated_at": row["updated_at"],
        "worker_id": row["worker_id"],
    }


def _command_attempt_record(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "command_id": row["command_id"],
        "correlation_id": row["correlation_id"],
        "dispatcher_id": row["dispatcher_id"],
        "error": row["error"],
        "finished_at": row["finished_at"],
        "id": row["id"],
        "result": json.loads(row["result_json"]) if row["result_json"] else None,
        "side_effect_completed": bool(row["side_effect_completed"]),
        "side_effect_started": bool(row["side_effect_started"]),
        "started_at": row["started_at"],
        "state": row["state"],
    }


def _routed_notification_record(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "binding_id": row["binding_id"],
        "claimed_at": row["claimed_at"],
        "claimed_by": row["claimed_by"],
        "claim_expires_at": row["claim_expires_at"],
        "command_id": row["command_id"],
        "correlation_id": row["correlation_id"],
        "created_at": row["created_at"],
        "consumed_at": row["consumed_at"],
        "consumed_manager_cycle_id": row["consumed_manager_cycle_id"],
        "dedupe_key": row["dedupe_key"],
        "delivered_at": row["delivered_at"],
        "error": row["error"],
        "id": row["id"],
        "payload": json.loads(row["payload_json"]),
        "side_effect_completed": bool(row["side_effect_completed"]),
        "side_effect_started": bool(row["side_effect_started"]),
        "signal_type": row["signal_type"],
        "source_event_id": row["source_event_id"],
        "source_event_timestamp": row["source_event_timestamp"],
        "source_session_id": row["source_session_id"],
        "state": row["state"],
        "target_session_id": row["target_session_id"],
        "task_id": row["task_id"],
    }


def _command_manager_decision_id(command: dict[str, Any]) -> int | None:
    for root in (command.get("payload") or {}, command.get("result") or {}):
        manager_decision = root.get("manager_decision") if isinstance(root, dict) else None
        if not isinstance(manager_decision, dict):
            continue
        decision_record = manager_decision.get("decision")
        if not isinstance(decision_record, dict):
            decision_record = manager_decision
        decision_id = manager_decision.get("decision_id") or decision_record.get("id")
        if isinstance(decision_id, int):
            return decision_id
        if isinstance(decision_id, str) and decision_id.isdigit():
            return int(decision_id)
    return None


def _next_manager_cycle_for_notification(
    notification: dict[str, Any],
    manager_cycles: list[dict[str, Any]],
) -> dict[str, Any] | None:
    consumed_cycle_id = notification.get("consumed_manager_cycle_id")
    if consumed_cycle_id is None:
        return None
    return next((cycle for cycle in manager_cycles if cycle.get("id") == consumed_cycle_id), None)


def _build_correlation_chains(
    *,
    commands: list[dict[str, Any]],
    command_attempts: list[dict[str, Any]],
    routed_notifications: list[dict[str, Any]],
    manager_decisions: list[dict[str, Any]],
    manager_cycles: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    decisions_by_id = {decision["id"]: decision for decision in manager_decisions}
    decisions_by_cycle: dict[int, list[dict[str, Any]]] = {}
    for decision in manager_decisions:
        cycle_id = decision.get("manager_cycle_id")
        if cycle_id is not None:
            decisions_by_cycle.setdefault(cycle_id, []).append(decision)
    cycles_by_id = {cycle["id"]: cycle for cycle in manager_cycles}
    attempts_by_command: dict[str, list[dict[str, Any]]] = {}
    for attempt in command_attempts:
        attempts_by_command.setdefault(attempt["command_id"], []).append(attempt)
    notifications_by_command: dict[str, list[dict[str, Any]]] = {}
    notifications_without_command: list[dict[str, Any]] = []
    for notification in routed_notifications:
        command_id = notification.get("command_id")
        if command_id:
            notifications_by_command.setdefault(command_id, []).append(notification)
        else:
            notifications_without_command.append(notification)
    chains: list[dict[str, Any]] = []
    for command in commands:
        decision_id = _command_manager_decision_id(command)
        decision = decisions_by_id.get(decision_id) if decision_id is not None else None
        decision_cycle = cycles_by_id.get(decision["manager_cycle_id"]) if decision and decision.get("manager_cycle_id") else None
        attempts = attempts_by_command.get(command["id"], [])
        notifications = notifications_by_command.get(command["id"], [])
        if not (decision or attempts or notifications or command.get("correlation_id")):
            continue
        consumed_cycle = next(
            (cycle for notification in notifications if (cycle := _next_manager_cycle_for_notification(notification, manager_cycles))),
            None,
        )
        chains.append(
            {
                "attempt_ids": [attempt["id"] for attempt in attempts],
                "command_id": command["id"],
                "command_state": command["state"],
                "command_type": command["type"],
                "correlation_id": command.get("correlation_id"),
                "created_at": command["created_at"],
                "manager_cycle_id": consumed_cycle["id"] if consumed_cycle else (decision_cycle["id"] if decision_cycle else None),
                "manager_decision_cycle_id": decision_cycle["id"] if decision_cycle else None,
                "manager_decision_id": decision["id"] if decision else None,
                "routed_notification_ids": [notification["id"] for notification in notifications],
            }
        )
    for notification in notifications_without_command:
        cycle = _next_manager_cycle_for_notification(notification, manager_cycles)
        cycle_decisions = decisions_by_cycle.get(cycle["id"], []) if cycle else []
        decision = cycle_decisions[0] if cycle_decisions else None
        chains.append(
            {
                "attempt_ids": [],
                "command_id": None,
                "command_state": notification["state"],
                "command_type": notification["signal_type"],
                "correlation_id": notification["correlation_id"],
                "created_at": notification["created_at"],
                "manager_cycle_id": cycle["id"] if cycle else None,
                "manager_decision_id": decision["id"] if decision else None,
                "routed_notification_ids": [notification["id"]],
                "signal_type": notification["signal_type"],
                "source_event_id": notification["source_event_id"],
            }
        )
    return sorted(chains, key=lambda chain: (chain.get("created_at") or "", str(chain.get("command_id") or "")))


def create_command(
    conn: sqlite3.Connection,
    *,
    command_type: str,
    payload: dict[str, Any],
    idempotency_key: str | None = None,
    task_id: str | None = None,
    worker_id: str | None = None,
    manager_id: str | None = None,
    correlation_id: str | None = None,
    available_at: str | None = None,
    max_attempts: int = 1,
    required_permission: str | None = None,
    timestamp: str | None = None,
) -> str:
    required_permission = _validate_required_permission(required_permission)
    command_id = f"command-{uuid.uuid4()}"
    correlation_id = correlation_id or f"dispatch-{uuid.uuid4()}"
    now = timestamp or now_iso()
    key = idempotency_key or command_id
    conn.execute(
        """
        insert into commands(
          id, idempotency_key, created_at, updated_at, task_id, worker_id,
          manager_id, correlation_id, type, state, available_at, max_attempts,
          required_permission, payload_json
        )
        values (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)
        """,
        (
            command_id,
            key,
            now,
            now,
            task_id,
            worker_id,
            manager_id,
            correlation_id,
            command_type,
            available_at,
            max_attempts,
            required_permission,
            json.dumps(payload, sort_keys=True),
        ),
    )
    emit_telemetry_event(
        conn,
        actor="workerctl",
        event_type="command_created",
        task_id=task_id,
        summary=f"Created command {command_type}.",
        correlation={"command_id": command_id, "command_type": command_type, "correlation_id": correlation_id},
        attributes={
            "idempotency_key": key,
            "manager_id": manager_id,
            "required_permission": required_permission,
            "state": "pending",
            "worker_id": worker_id,
        },
    )
    manager_decision = payload.get("manager_decision") if isinstance(payload, dict) else None
    if isinstance(manager_decision, dict):
        decision_record = manager_decision.get("decision")
        if not isinstance(decision_record, dict):
            decision_record = manager_decision
        cycle_id = decision_record.get("manager_cycle_id")
        decision_id = manager_decision.get("decision_id") or decision_record.get("id")
        if isinstance(cycle_id, str) and cycle_id.isdigit():
            cycle_id = int(cycle_id)
        if isinstance(decision_id, str) and decision_id.isdigit():
            decision_id = int(decision_id)
        if isinstance(cycle_id, int) and task_id is not None:
            insert_manager_cycle_span(
                conn,
                manager_cycle_id=cycle_id,
                task_id=task_id,
                phase="side_effect_command",
                started_at=now,
                completed_at=now,
                duration_ms=0.0,
                state="succeeded",
                attributes={"command_type": command_type, "side_effect": True},
                manager_decision_id=decision_id if isinstance(decision_id, int) else None,
                command_id=command_id,
            )
    return command_id


def enqueue_notify_manager(
    conn: sqlite3.Connection,
    *,
    task_id: str,
    message: str,
    required_permission: str | None = None,
    idempotency_key: str | None = None,
    correlation_id: str | None = None,
    available_at: str | None = None,
    max_attempts: int = 1,
    timestamp: str | None = None,
    payload: dict[str, Any] | None = None,
) -> str:
    if not message.strip():
        raise ValueError("notify_manager message must be non-empty")
    return create_command(
        conn,
        command_type="notify_manager",
        task_id=task_id,
        payload={**(payload or {}), "message": message},
        idempotency_key=idempotency_key,
        correlation_id=correlation_id,
        available_at=available_at,
        max_attempts=max_attempts,
        required_permission=required_permission,
        timestamp=timestamp,
    )


def enqueue_nudge_worker(
    conn: sqlite3.Connection,
    *,
    task_id: str,
    message: str,
    required_permission: str | None = None,
    idempotency_key: str | None = None,
    correlation_id: str | None = None,
    available_at: str | None = None,
    max_attempts: int = 1,
    timestamp: str | None = None,
    payload: dict[str, Any] | None = None,
) -> str:
    if not message.strip():
        raise ValueError("nudge_worker message must be non-empty")
    return create_command(
        conn,
        command_type="nudge_worker",
        task_id=task_id,
        payload={**(payload or {}), "message": message},
        idempotency_key=idempotency_key,
        correlation_id=correlation_id,
        available_at=available_at,
        max_attempts=max_attempts,
        required_permission=required_permission,
        timestamp=timestamp,
    )


def mark_command_attempted(conn: sqlite3.Connection, *, command_id: str, timestamp: str | None = None) -> None:
    conn.execute(
        """
        update commands
        set state = 'attempted', updated_at = ?
        where id = ? and state = 'pending'
        """,
        (timestamp or now_iso(), command_id),
    )
    row = conn.execute(
        """
        select task_id, worker_id, manager_id, type, state
        from commands
        where id = ?
        """,
        (command_id,),
    ).fetchone()
    if row is not None:
        emit_telemetry_event(
            conn,
            actor="workerctl",
            event_type="command_attempted",
            task_id=row["task_id"],
            summary=f"Attempted command {row['type']}.",
            correlation={"command_id": command_id, "command_type": row["type"]},
            attributes={
                "manager_id": row["manager_id"],
                "state": row["state"],
                "worker_id": row["worker_id"],
            },
        )


def _parse_timestamp(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def _iso_after(value: str, seconds: int) -> str:
    return (_parse_timestamp(value) + timedelta(seconds=seconds)).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def claim_next_dispatch_command(
    conn: sqlite3.Connection,
    *,
    dispatcher_id: str,
    command_types: list[str] | tuple[str, ...],
    timestamp: str | None = None,
    lease_seconds: int = 60,
) -> dict[str, Any] | None:
    if not command_types:
        raise ValueError("command_types must not be empty")
    now = timestamp or now_iso()
    claim_expires_at = _iso_after(now, max(1, lease_seconds))
    correlation_id = f"dispatch-{uuid.uuid4()}"
    placeholders = ", ".join("?" for _ in command_types)
    row = conn.execute(
        f"""
        update commands
        set state = 'attempted',
            updated_at = ?,
            correlation_id = coalesce(correlation_id, ?),
            claimed_by = ?,
            claimed_at = ?,
            claim_expires_at = ?,
            attempts = attempts + 1
        where id = (
          select id
          from commands
          where state = 'pending'
            and type in ({placeholders})
            and (available_at is null or available_at <= ?)
            and attempts < max_attempts
          order by created_at, id
          limit 1
        )
          and state = 'pending'
        returning id, idempotency_key, created_at, updated_at, task_id, worker_id,
                  manager_id, correlation_id, type, state, available_at, claimed_by,
                  claimed_at, claim_expires_at, attempts, max_attempts, payload_json,
                  required_permission, result_json, error
        """,
        (now, correlation_id, dispatcher_id, now, claim_expires_at, *command_types, now),
    ).fetchone()
    if row is None:
        return None
    attempt_cursor = conn.execute(
        """
        insert into command_attempts(
          command_id, correlation_id, dispatcher_id, started_at, state
        )
        values (?, ?, ?, ?, 'running')
        """,
        (row["id"], row["correlation_id"], dispatcher_id, now),
    )
    emit_telemetry_event(
        conn,
        actor="dispatch",
        event_type="dispatch_command_claimed",
        task_id=row["task_id"],
        summary=f"Dispatch claimed command {row['type']}.",
        correlation={
            "attempt_id": attempt_cursor.lastrowid,
            "command_id": row["id"],
            "command_type": row["type"],
            "correlation_id": row["correlation_id"],
            "dispatcher_id": dispatcher_id,
        },
        attributes={
            "attempts": row["attempts"],
            "claim_expires_at": row["claim_expires_at"],
            "manager_id": row["manager_id"],
            "worker_id": row["worker_id"],
        },
    )
    return {
        "attempt": {
            "id": int(attempt_cursor.lastrowid),
            "command_id": row["id"],
            "correlation_id": row["correlation_id"],
            "dispatcher_id": dispatcher_id,
            "started_at": now,
            "state": "running",
        },
        "command": _command_record(row),
    }


def finish_command_attempt(
    conn: sqlite3.Connection,
    *,
    attempt_id: int,
    state: str,
    result: dict[str, Any] | None = None,
    error: str | None = None,
    side_effect_started: bool = False,
    side_effect_completed: bool = False,
    timestamp: str | None = None,
) -> dict[str, Any]:
    if state not in {"succeeded", "failed", "abandoned"}:
        raise ValueError(f"invalid command attempt finish state: {state}")
    now = timestamp or now_iso()
    cursor = conn.execute(
        """
        update command_attempts
        set state = ?, finished_at = ?, result_json = ?, error = ?,
            side_effect_started = ?, side_effect_completed = ?
        where id = ? and state = 'running'
        """,
        (
            state,
            now,
            json.dumps(result, sort_keys=True) if result is not None else None,
            error,
            1 if side_effect_started else 0,
            1 if side_effect_completed else 0,
            attempt_id,
        ),
    )
    if cursor.rowcount != 1:
        existing_attempt = conn.execute(
            "select state from command_attempts where id = ?",
            (attempt_id,),
        ).fetchone()
        if existing_attempt is None:
            raise WorkerError(f"Unknown command attempt: {attempt_id}")
        raise WorkerError(
            f"Command attempt {attempt_id} is not running "
            f"(state: {existing_attempt['state']})"
        )
    attempt = conn.execute(
        """
        select command_attempts.id, command_attempts.command_id,
               command_attempts.correlation_id, command_attempts.dispatcher_id,
               command_attempts.started_at, command_attempts.finished_at,
               command_attempts.state, command_attempts.result_json,
               command_attempts.error, command_attempts.side_effect_started,
               command_attempts.side_effect_completed,
               commands.task_id, commands.worker_id, commands.manager_id,
               commands.type as command_type
        from command_attempts
        join commands on commands.id = command_attempts.command_id
        where command_attempts.id = ?
        """,
        (attempt_id,),
    ).fetchone()
    if attempt is None:
        raise WorkerError(f"Unknown command attempt: {attempt_id}")
    command_state = "succeeded" if state == "succeeded" else "failed"
    conn.execute(
        """
        update commands
        set state = ?, updated_at = ?, result_json = ?, error = ?
        where id = ?
        """,
        (
            command_state,
            now,
            json.dumps(result, sort_keys=True) if result is not None else None,
            error,
            attempt["command_id"],
        ),
    )
    event_type = {
        "succeeded": "dispatch_command_succeeded",
        "failed": "dispatch_command_failed",
        "abandoned": "dispatch_command_abandoned",
    }[state]
    emit_telemetry_event(
        conn,
        actor="dispatch",
        event_type=event_type,
        severity="error" if state == "failed" else "warning" if state == "abandoned" else "info",
        task_id=attempt["task_id"],
        summary=f"Dispatch command {attempt['command_type']} {state}.",
        correlation={
            "attempt_id": attempt_id,
            "command_id": attempt["command_id"],
            "command_type": attempt["command_type"],
            "correlation_id": attempt["correlation_id"],
            "dispatcher_id": attempt["dispatcher_id"],
        },
        attributes={
            "error": error,
            "manager_id": attempt["manager_id"],
            "result": result or {},
            "side_effect_completed": side_effect_completed,
            "side_effect_started": side_effect_started,
            "worker_id": attempt["worker_id"],
        },
    )
    return _command_attempt_record(attempt)


def mark_command_attempt_side_effect_started(
    conn: sqlite3.Connection,
    *,
    attempt_id: int,
) -> None:
    conn.execute(
        """
        update command_attempts
        set side_effect_started = 1
        where id = ? and state = 'running'
        """,
        (attempt_id,),
    )


def recover_stale_dispatch_claims(
    conn: sqlite3.Connection,
    *,
    dispatcher_id: str,
    command_types: list[str] | tuple[str, ...],
    timestamp: str | None = None,
    limit: int = 10,
) -> list[dict[str, Any]]:
    if not command_types:
        raise ValueError("command_types must not be empty")
    now = timestamp or now_iso()
    placeholders = ", ".join("?" for _ in command_types)
    rows = conn.execute(
        f"""
        select id, task_id, type, correlation_id, attempts, max_attempts
        from commands
        where state = 'attempted'
          and type in ({placeholders})
          and claim_expires_at is not null
          and claim_expires_at <= ?
        order by claim_expires_at, created_at, id
        limit ?
        """,
        (*command_types, now, max(1, limit)),
    ).fetchall()
    recovered: list[dict[str, Any]] = []
    for command in rows:
        attempt = conn.execute(
            """
            select id, side_effect_started
            from command_attempts
            where command_id = ? and state = 'running'
            order by id desc
            limit 1
            """,
            (command["id"],),
        ).fetchone()
        side_effect_started = bool(attempt["side_effect_started"]) if attempt is not None else False
        if side_effect_started:
            error = "stale dispatch claim expired after side effect started; manual review required"
            if attempt is not None:
                conn.execute(
                    """
                    update command_attempts
                    set state = 'failed', finished_at = ?, error = ?
                    where id = ?
                    """,
                    (now, error, attempt["id"]),
                )
            conn.execute(
                """
                update commands
                set state = 'failed', updated_at = ?, error = ?,
                    claimed_by = null, claimed_at = null, claim_expires_at = null
                where id = ?
                """,
                (now, error, command["id"]),
            )
            state = "failed"
            event_type = "dispatch_command_failed"
        else:
            error = "stale dispatch claim abandoned before side effect started"
            next_state = "pending" if command["attempts"] < command["max_attempts"] else "failed"
            if attempt is not None:
                conn.execute(
                    """
                    update command_attempts
                    set state = 'abandoned', finished_at = ?, error = ?
                    where id = ?
                    """,
                    (now, error, attempt["id"]),
                )
            conn.execute(
                """
                update commands
                set state = ?, updated_at = ?, error = ?,
                    claimed_by = null, claimed_at = null, claim_expires_at = null
                where id = ?
                """,
                (next_state, now, None if next_state == "pending" else error, command["id"]),
            )
            state = "requeued" if next_state == "pending" else "failed"
            event_type = "dispatch_command_abandoned"
        emit_telemetry_event(
            conn,
            actor="dispatch",
            event_type=event_type,
            severity="error" if state == "failed" else "warning",
            task_id=command["task_id"],
            summary=f"Recovered stale dispatch claim for {command['type']}.",
            correlation={
                "attempt_id": attempt["id"] if attempt is not None else None,
                "command_id": command["id"],
                "command_type": command["type"],
                "correlation_id": command["correlation_id"],
                "dispatcher_id": dispatcher_id,
            },
            attributes={
                "recovery_state": state,
                "side_effect_started": side_effect_started,
            },
        )
        recovered.append(
            {
                "attempt_id": attempt["id"] if attempt is not None else None,
                "command_id": command["id"],
                "command_type": command["type"],
                "error": error,
                "side_effect_started": side_effect_started,
                "state": state,
            }
        )
    return recovered


def claimable_dispatch_commands(
    conn: sqlite3.Connection,
    *,
    command_types: list[str] | tuple[str, ...],
    limit: int = 10,
    timestamp: str | None = None,
) -> list[dict[str, Any]]:
    if not command_types:
        raise ValueError("command_types must not be empty")
    now = timestamp or now_iso()
    placeholders = ", ".join("?" for _ in command_types)
    rows = conn.execute(
        f"""
        select id, idempotency_key, created_at, updated_at, task_id, worker_id,
               manager_id, correlation_id, type, state, available_at, claimed_by,
               claimed_at, claim_expires_at, attempts, max_attempts, payload_json,
               required_permission, result_json, error
        from commands
        where state = 'pending'
          and type in ({placeholders})
          and (available_at is null or available_at <= ?)
          and attempts < max_attempts
        order by created_at, id
        limit ?
        """,
        (*command_types, now, max(1, limit)),
    ).fetchall()
    return [_command_record(row) for row in rows]


def finish_command(
    conn: sqlite3.Connection,
    *,
    command_id: str,
    state: str,
    result: dict[str, Any] | None = None,
    error: str | None = None,
    timestamp: str | None = None,
) -> None:
    if state not in {"succeeded", "failed"}:
        raise ValueError(f"invalid command finish state: {state}")
    conn.execute(
        """
        update commands
        set state = ?, updated_at = ?, result_json = ?, error = ?
        where id = ?
        """,
        (
            state,
            timestamp or now_iso(),
            json.dumps(result, sort_keys=True) if result is not None else None,
            error,
            command_id,
        ),
    )
    row = conn.execute(
        """
        select task_id, worker_id, manager_id, type, state
        from commands
        where id = ?
        """,
        (command_id,),
    ).fetchone()
    if row is not None:
        emit_telemetry_event(
            conn,
            actor="workerctl",
            event_type=f"command_{state}",
            severity="error" if state == "failed" else "info",
            task_id=row["task_id"],
            summary=f"Command {row['type']} {state}.",
            correlation={"command_id": command_id, "command_type": row["type"]},
            attributes={
                "error": error,
                "manager_id": row["manager_id"],
                "result": result or {},
                "state": row["state"],
                "worker_id": row["worker_id"],
            },
        )


def upsert_worker(
    conn: sqlite3.Connection,
    *,
    name: str,
    cwd: str,
    tmux_session: str,
    state: str,
    identity_token: str | None = None,
    tmux_pane_id: str | None = None,
    timestamp: str | None = None,
) -> str:
    existing = conn.execute("select id, identity_token from workers where name = ?", (name,)).fetchone()
    worker_id = str(existing["id"]) if existing else f"worker-{uuid.uuid4()}"
    token = identity_token or f"workerctl-{uuid.uuid4()}"
    now = timestamp or now_iso()
    conn.execute(
        """
        insert into workers(
          id, name, tmux_session, tmux_pane_id, identity_token, cwd, state, created_at, updated_at
        )
        values (?, ?, ?, ?, ?, ?, ?, ?, ?)
        on conflict(name) do update set
          tmux_session = excluded.tmux_session,
          tmux_pane_id = coalesce(excluded.tmux_pane_id, workers.tmux_pane_id),
          cwd = excluded.cwd,
          state = excluded.state,
          updated_at = excluded.updated_at,
          exit_detected_at = null,
          exit_reason = null
        """,
        (worker_id, name, tmux_session, tmux_pane_id, token, cwd, state, now, now),
    )
    row = conn.execute("select id from workers where name = ?", (name,)).fetchone()
    return str(row["id"])


def set_worker_pane_id(conn: sqlite3.Connection, *, worker_id: str, tmux_pane_id: str | None) -> None:
    if tmux_pane_id is None:
        return
    conn.execute(
        "update workers set tmux_pane_id = ?, updated_at = ? where id = ?",
        (tmux_pane_id, now_iso(), worker_id),
    )


def register_session(
    conn: sqlite3.Connection,
    *,
    name: str,
    role: str,
    codex_session_path: str,
    codex_session_id: str,
    pid: int,
    cwd: str,
    tmux_session: str | None = None,
    tmux_pane_id: str | None = None,
    identity_token: str | None = None,
    timestamp: str | None = None,
) -> str:
    """Idempotent upsert into `sessions`. Returns the session id.

    On conflict by name: updates pid, codex_session_path, codex_session_id, tmux fields,
    and state='active'. Raises WorkerError if a row exists with the same name but a
    different role.
    """
    if role not in ("worker", "manager"):
        raise WorkerError(f"invalid session role: {role}")
    now = timestamp or now_iso()
    existing = conn.execute(
        "select id, role, identity_token from sessions where name = ?", (name,)
    ).fetchone()
    if existing is not None and existing["role"] != role:
        raise WorkerError(
            f"session name {name!r} already exists with role {existing['role']!r}; "
            f"refusing to re-register as {role!r}"
        )
    session_id = str(existing["id"]) if existing else f"session-{uuid.uuid4()}"
    token = (existing["identity_token"] if existing else None) or identity_token or f"session-token-{uuid.uuid4()}"
    conn.execute(
        """
        insert into sessions(
          id, name, role, identity_token,
          tmux_session, tmux_pane_id,
          codex_session_path, codex_session_id, pid,
          cwd, registered_at, last_heartbeat_at, state
        )
        values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')
        on conflict(name) do update set
          tmux_session = excluded.tmux_session,
          tmux_pane_id = coalesce(excluded.tmux_pane_id, sessions.tmux_pane_id),
          codex_session_path = excluded.codex_session_path,
          codex_session_id = excluded.codex_session_id,
          pid = excluded.pid,
          cwd = excluded.cwd,
          last_heartbeat_at = excluded.last_heartbeat_at,
          last_ingest_offset = null,
          state = 'active'
        """,
        (
            session_id, name, role, token,
            tmux_session, tmux_pane_id,
            codex_session_path, codex_session_id, pid,
            cwd, now, now,
        ),
    )
    return session_id


def session_row(conn: sqlite3.Connection, *, name: str, role: str | None = None) -> sqlite3.Row:
    """Look up a session by name. Optionally verify role. Raises WorkerError if missing or role mismatch."""
    row = conn.execute("select * from sessions where name = ?", (name,)).fetchone()
    if row is None:
        raise WorkerError(f"no session registered with name {name!r}")
    if role is not None and row["role"] != role:
        raise WorkerError(f"session {name!r} has role {row['role']!r}, expected {role!r}")
    return row


def session_by_id(conn: sqlite3.Connection, *, session_id: str) -> sqlite3.Row | None:
    """Look up a session by id. Returns the row or None if not found.

    Mirrors `session_row` (which looks up by name) but for id-keyed access.
    Callers that need a present-row contract should check the return value
    explicitly — this helper does not raise on missing.
    """
    return conn.execute(
        "select * from sessions where id = ?", (session_id,)
    ).fetchone()


def list_sessions(
    conn: sqlite3.Connection,
    *,
    role: str | None = None,
    include_legacy: bool = False,
    state: str | None = None,
) -> list[dict[str, Any]]:
    """List sessions, optionally filtering by role.

    By default, excludes legacy sessions (pid IS NULL) from Phase 1 backfill and
    gone sessions. Use include_legacy=True to opt in to legacy rows. Use
    state="all" to bypass both default filters.
    """
    if state not in (None, "active", "gone", "all"):
        raise ValueError(f"invalid state filter: {state!r}")

    query = "select * from sessions"
    clauses: list[str] = []
    params: list = []
    if role is not None:
        clauses.append("role = ?")
        params.append(role)
    if state == "gone":
        clauses.append("state = 'gone'")
    elif state == "all":
        pass
    else:
        clauses.append("state != 'gone'")
    if state in (None,) and not include_legacy:
        clauses.append("pid is not null")
    elif state == "active":
        clauses.append("pid is not null")
    if clauses:
        query += " where " + " and ".join(clauses)
    query += " order by registered_at"
    return [dict(row) for row in conn.execute(query, tuple(params))]


def deregister_session(conn: sqlite3.Connection, *, name: str, timestamp: str | None = None) -> None:
    now = timestamp or now_iso()
    existing = conn.execute("select id from sessions where name = ?", (name,)).fetchone()
    if existing is None:
        raise WorkerError(f"no session registered with name {name!r}")
    session_id = existing["id"]
    active_binding = conn.execute(
        """
        select id, task_id from bindings
        where state in ('active', 'ending')
          and (worker_session_id = ? or manager_session_id = ?)
        limit 1
        """,
        (session_id, session_id),
    ).fetchone()
    if active_binding is not None:
        raise WorkerError(
            f"cannot deregister session {name!r}: it is still bound to task "
            f"{active_binding['task_id']!r} (binding {active_binding['id']!r}). "
            f"Unbind the task first."
        )
    conn.execute(
        "update sessions set state='gone', last_heartbeat_at=? where name=?",
        (now, name),
    )


def insert_codex_event(
    conn: sqlite3.Connection,
    *,
    session_id: str,
    timestamp: str,
    event_type: str,
    subtype: str | None,
    payload: dict[str, Any],
    byte_offset: int,
    ingested_at: str | None = None,
) -> int:
    """Insert one codex event row. Returns the autoincrement id."""
    now = ingested_at or now_iso()
    cursor = conn.execute(
        """
        insert into codex_events(
          session_id, timestamp, type, subtype, payload_json, byte_offset, ingested_at
        )
        values (?, ?, ?, ?, ?, ?, ?)
        """,
        (session_id, timestamp, event_type, subtype,
         json.dumps(payload, sort_keys=True), byte_offset, now),
    )
    return int(cursor.lastrowid)


def latest_codex_events_for_session(
    conn: sqlite3.Connection,
    *,
    session_id: str,
    limit: int = 50,
    subtype: str | None = None,
) -> list[sqlite3.Row]:
    """Return up to `limit` most recent codex events for `session_id`, newest first."""
    query = "select * from codex_events where session_id = ?"
    params: list[Any] = [session_id]
    if subtype is not None:
        query += " and subtype = ?"
        params.append(subtype)
    query += " order by id desc limit ?"
    params.append(limit)
    return list(conn.execute(query, tuple(params)))


def latest_codex_event_subtype(
    conn: sqlite3.Connection, *, session_id: str
) -> str | None:
    """Return the subtype of the most recent codex event for a session, or None if no events exist."""
    row = conn.execute(
        "select subtype from codex_events where session_id = ? "
        "order by id desc limit 1",
        (session_id,),
    ).fetchone()
    return row["subtype"] if row else None


def unrouted_worker_completion_events(conn: sqlite3.Connection, *, limit: int = 10) -> list[sqlite3.Row]:
    """Return bound worker task_complete events that Dispatch has not routed."""
    return list(
        conn.execute(
            """
            select
              ce.id as source_event_id,
              ce.timestamp as source_event_timestamp,
              ce.session_id as source_session_id,
              ce.payload_json as source_payload_json,
              b.id as binding_id,
              b.task_id as task_id,
              b.manager_session_id as target_session_id,
              ws.name as worker_session_name,
              ms.name as manager_session_name,
              t.name as task_name
            from codex_events ce
            join bindings b on b.worker_session_id = ce.session_id
            join sessions ws on ws.id = b.worker_session_id
            join sessions ms on ms.id = b.manager_session_id
            join tasks t on t.id = b.task_id
            left join routed_notifications rn on rn.source_event_id = ce.id
            where ce.subtype = 'task_complete'
              and b.state in ('active', 'ending')
              and rn.id is null
            order by ce.id asc
            limit ?
            """,
            (limit,),
        )
    )


def insert_routed_notification(
    conn: sqlite3.Connection,
    *,
    task_id: str,
    binding_id: str,
    correlation_id: str,
    source_session_id: str,
    target_session_id: str,
    signal_type: str,
    source_event_id: int | None,
    source_event_timestamp: str | None,
    dedupe_key: str,
    payload: dict[str, Any],
    command_id: str | None = None,
    state: str = "pending",
    claimed_by: str | None = None,
    claimed_at: str | None = None,
    claim_expires_at: str | None = None,
    timestamp: str | None = None,
) -> int:
    if state not in {"pending", "delivered", "failed", "suppressed"}:
        raise WorkerError(f"invalid routed notification state: {state}")
    created_at = timestamp or now_iso()
    cursor = conn.execute(
        """
        insert into routed_notifications(
          task_id, binding_id, correlation_id, source_session_id, target_session_id,
          signal_type, source_event_id, source_event_timestamp, dedupe_key, command_id,
          created_at, state, payload_json, claimed_by, claimed_at, claim_expires_at
        )
        values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            task_id,
            binding_id,
            correlation_id,
            source_session_id,
            target_session_id,
            signal_type,
            source_event_id,
            source_event_timestamp,
            dedupe_key,
            command_id,
            created_at,
            state,
            json.dumps(payload, sort_keys=True),
            claimed_by,
            claimed_at or (created_at if claimed_by else None),
            claim_expires_at,
        ),
    )
    return int(cursor.lastrowid)


def finish_routed_notification(
    conn: sqlite3.Connection,
    *,
    notification_id: int,
    state: str,
    error: str | None = None,
    timestamp: str | None = None,
) -> None:
    if state not in {"delivered", "failed", "suppressed"}:
        raise WorkerError(f"invalid routed notification finish state: {state}")
    delivered_at = (timestamp or now_iso()) if state == "delivered" else None
    side_effect_completed = 1 if state == "delivered" else 0
    conn.execute(
        """
        update routed_notifications
        set state = ?, delivered_at = ?, error = ?, side_effect_completed = ?
        where id = ?
        """,
        (state, delivered_at, error, side_effect_completed, notification_id),
    )


def mark_routed_notification_side_effect_started(
    conn: sqlite3.Connection,
    *,
    notification_id: int,
    claimed_by: str | None = None,
    claim_expires_at: str | None = None,
    timestamp: str | None = None,
) -> None:
    if claimed_by is None and claim_expires_at is None:
        conn.execute(
            """
            update routed_notifications
            set side_effect_started = 1
            where id = ?
            """,
            (notification_id,),
        )
        return
    now = timestamp or now_iso()
    conn.execute(
        """
        update routed_notifications
        set side_effect_started = 1,
            claimed_by = coalesce(?, claimed_by),
            claimed_at = coalesce(claimed_at, ?),
            claim_expires_at = coalesce(?, claim_expires_at)
        where id = ?
        """,
        (claimed_by, now, claim_expires_at, notification_id),
    )


def defer_routed_notification_before_side_effect(
    conn: sqlite3.Connection,
    *,
    notification_id: int,
    error: str,
) -> None:
    conn.execute(
        """
        update routed_notifications
        set state = 'pending',
            error = ?,
            claimed_by = null,
            claimed_at = null,
            claim_expires_at = null,
            side_effect_started = 0,
            side_effect_completed = 0
        where id = ?
        """,
        (error, notification_id),
    )


def claim_pending_routed_completion_notifications(
    conn: sqlite3.Connection,
    *,
    dispatcher_id: str,
    lease_seconds: int,
    limit: int = 10,
    timestamp: str | None = None,
) -> list[sqlite3.Row]:
    """Claim stale pending completion notifications that never started sending."""
    now = timestamp or now_iso()
    expires_at = (datetime.now(timezone.utc) + timedelta(seconds=lease_seconds)).isoformat().replace("+00:00", "Z")
    candidate_rows = conn.execute(
        """
        select id
        from routed_notifications
        where state = 'pending'
          and signal_type = 'worker_task_complete'
          and side_effect_started = 0
          and (claim_expires_at is null or claim_expires_at <= ?)
        order by created_at, id
        limit ?
        """,
        (now, limit),
    ).fetchall()
    claimed_ids: list[int] = []
    for row in candidate_rows:
        cursor = conn.execute(
            """
            update routed_notifications
            set claimed_by = ?, claimed_at = ?, claim_expires_at = ?
            where id = ?
              and state = 'pending'
              and side_effect_started = 0
              and (claim_expires_at is null or claim_expires_at <= ?)
            """,
            (dispatcher_id, now, expires_at, row["id"], now),
        )
        if cursor.rowcount:
            claimed_ids.append(int(row["id"]))
    if not claimed_ids:
        return []
    placeholders = ",".join("?" for _ in claimed_ids)
    return list(
        conn.execute(
            f"""
            select
              rn.id as notification_id,
              rn.task_id as task_id,
              rn.binding_id as binding_id,
              rn.correlation_id as correlation_id,
              rn.source_session_id as source_session_id,
              rn.target_session_id as target_session_id,
              rn.signal_type as signal_type,
              rn.source_event_id as source_event_id,
              rn.source_event_timestamp as source_event_timestamp,
              rn.dedupe_key as dedupe_key,
              rn.payload_json as notification_payload_json,
              ws.name as worker_session_name,
              ms.name as manager_session_name,
              t.name as task_name
            from routed_notifications rn
            join sessions ws on ws.id = rn.source_session_id
            join sessions ms on ms.id = rn.target_session_id
            join tasks t on t.id = rn.task_id
            where rn.id in ({placeholders})
            order by rn.created_at, rn.id
            """,
            claimed_ids,
        )
    )


def fail_stale_started_routed_notifications(
    conn: sqlite3.Connection,
    *,
    limit: int = 10,
    timestamp: str | None = None,
) -> list[dict[str, Any]]:
    """Fail pending completion notifications whose tmux send may have started."""
    now = timestamp or now_iso()
    rows = conn.execute(
        """
        select id, task_id, binding_id, correlation_id, source_event_id, signal_type,
               claimed_by, claim_expires_at
        from routed_notifications
        where state = 'pending'
          and signal_type = 'worker_task_complete'
          and side_effect_started = 1
          and side_effect_completed = 0
          and claim_expires_at is not null
          and claim_expires_at <= ?
        order by claim_expires_at, id
        limit ?
        """,
        (now, limit),
    ).fetchall()
    failed: list[dict[str, Any]] = []
    for row in rows:
        error = "stale pending completion notification had started side effect; not retrying automatically"
        conn.execute(
            """
            update routed_notifications
            set state = 'failed', error = ?
            where id = ? and state = 'pending'
            """,
            (error, row["id"]),
        )
        failed.append(
            {
                "binding_id": row["binding_id"],
                "claim_expires_at": row["claim_expires_at"],
                "claimed_by": row["claimed_by"],
                "correlation_id": row["correlation_id"],
                "error": error,
                "notification_id": row["id"],
                "signal_type": row["signal_type"],
                "source_event_id": row["source_event_id"],
                "state": "failed",
                "task_id": row["task_id"],
            }
        )
    return failed


def consume_routed_notifications_for_cycle(
    conn: sqlite3.Connection,
    *,
    task_id: str,
    binding_id: str,
    manager_cycle_id: int,
    timestamp: str | None = None,
) -> int:
    consumed_at = timestamp or now_iso()
    cursor = conn.execute(
        """
        update routed_notifications
        set consumed_manager_cycle_id = ?, consumed_at = ?
        where task_id = ?
          and binding_id = ?
          and state = 'delivered'
          and consumed_manager_cycle_id is null
        """,
        (manager_cycle_id, consumed_at, task_id, binding_id),
    )
    return int(cursor.rowcount or 0)


def routed_notifications(conn: sqlite3.Connection, *, task_id: str | None = None) -> list[dict[str, Any]]:
    query = """
        select id, task_id, binding_id, correlation_id, source_session_id,
               target_session_id, signal_type, source_event_id, source_event_timestamp,
               dedupe_key, command_id, created_at, delivered_at, consumed_manager_cycle_id,
               consumed_at, state, claimed_by, claimed_at, claim_expires_at,
               side_effect_started, side_effect_completed, payload_json, error
        from routed_notifications
    """
    params: list[Any] = []
    if task_id is not None:
        query += " where task_id = ?"
        params.append(task_id)
    query += " order by id"
    return [
        {
            "binding_id": row["binding_id"],
            "claimed_at": row["claimed_at"],
            "claimed_by": row["claimed_by"],
            "claim_expires_at": row["claim_expires_at"],
            "command_id": row["command_id"],
            "correlation_id": row["correlation_id"],
            "created_at": row["created_at"],
            "consumed_at": row["consumed_at"],
            "consumed_manager_cycle_id": row["consumed_manager_cycle_id"],
            "dedupe_key": row["dedupe_key"],
            "delivered_at": row["delivered_at"],
            "error": row["error"],
            "id": row["id"],
            "payload": json.loads(row["payload_json"]),
            "side_effect_completed": bool(row["side_effect_completed"]),
            "side_effect_started": bool(row["side_effect_started"]),
            "signal_type": row["signal_type"],
            "source_event_id": row["source_event_id"],
            "source_event_timestamp": row["source_event_timestamp"],
            "source_session_id": row["source_session_id"],
            "state": row["state"],
            "target_session_id": row["target_session_id"],
            "task_id": row["task_id"],
        }
        for row in conn.execute(query, tuple(params))
    ]


def set_session_ingest_offset(
    conn: sqlite3.Connection,
    *,
    session_id: str,
    offset: int,
) -> None:
    conn.execute(
        "update sessions set last_ingest_offset = ? where id = ?",
        (offset, session_id),
    )


def bump_session_heartbeat(
    conn: sqlite3.Connection,
    *,
    session_id: str,
    timestamp: str | None = None,
) -> None:
    now = timestamp or now_iso()
    conn.execute(
        "update sessions set last_heartbeat_at = ? where id = ?",
        (now, session_id),
    )


def insert_status(
    conn: sqlite3.Connection,
    *,
    worker_id: str,
    status: dict[str, Any],
    timestamp: str | None = None,
) -> int:
    cursor = conn.execute(
        """
        insert into statuses(worker_id, state, current_task, next_action, blocker, created_at)
        values (?, ?, ?, ?, ?, ?)
        """,
        (
            worker_id,
            status.get("state", "unknown"),
            status.get("current_task"),
            status.get("next_action"),
            status.get("blocker"),
            timestamp or status.get("last_update") or now_iso(),
        ),
    )
    return int(cursor.lastrowid)


def insert_transcript_capture(
    conn: sqlite3.Connection,
    *,
    worker_id: str,
    sha256: str,
    content: str,
    captured_at: str,
    changed_at: str,
    history_lines: int,
    changed: bool,
) -> int:
    cursor = conn.execute(
        """
        insert into transcript_captures(
          worker_id, sha256, content, captured_at, changed_at, history_lines,
          byte_count, line_count, capture_kind, retention_class
        )
        values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            worker_id,
            sha256,
            content if changed else None,
            captured_at,
            changed_at,
            history_lines,
            len(content.encode()),
            len(content.splitlines()),
            "changed" if changed else "metadata_only",
            "hot",
        ),
    )
    capture_id = int(cursor.lastrowid)
    emit_telemetry_event(
        conn,
        actor="workerctl",
        event_type="transcript_capture_recorded",
        summary="Recorded transcript capture metadata.",
        correlation={"capture_id": capture_id, "worker_id": worker_id},
        attributes={
            "byte_count": len(content.encode()),
            "changed": changed,
            "history_lines": history_lines,
            "line_count": len(content.splitlines()),
            "retention_class": "hot",
        },
        timestamp=captured_at,
    )
    return capture_id


def insert_terminal_capture(
    conn: sqlite3.Connection,
    *,
    task_id: str,
    role: str,
    tmux_session: str,
    content_sha256: str,
    content: str,
    history_lines: int,
    source: str,
    worker_id: str | None = None,
    manager_id: str | None = None,
    tmux_pane_id: str | None = None,
    command_id: str | None = None,
    classifier: dict[str, Any] | None = None,
    content_path: str | None = None,
    timestamp: str | None = None,
) -> int:
    cursor = conn.execute(
        """
        insert into terminal_captures(
          task_id, worker_id, manager_id, role, tmux_session, tmux_pane_id,
          command_id, captured_at, history_lines, content_sha256, content,
          content_path, byte_count, line_count, classifier_json, source
        )
        values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            task_id,
            worker_id,
            manager_id,
            role,
            tmux_session,
            tmux_pane_id,
            command_id,
            timestamp or now_iso(),
            history_lines,
            content_sha256,
            content,
            content_path,
            len(content.encode()),
            len(content.splitlines()),
            json.dumps(classifier or {}, sort_keys=True),
            source,
        ),
    )
    capture_id = int(cursor.lastrowid)
    emit_telemetry_event(
        conn,
        actor="workerctl",
        event_type="terminal_capture_recorded",
        task_id=task_id,
        summary=f"Recorded {role} terminal capture.",
        correlation={
            "capture_id": capture_id,
            "command_id": command_id,
            "manager_id": manager_id,
            "role": role,
            "source": source,
            "worker_id": worker_id,
        },
        attributes={
            "byte_count": len(content.encode()),
            "classifier": classifier or {},
            "content_path": content_path,
            "history_lines": history_lines,
            "line_count": len(content.splitlines()),
            "tmux_pane_id": tmux_pane_id,
            "tmux_session": tmux_session,
        },
        timestamp=timestamp,
    )
    return capture_id


def latest_terminal_capture_for_role(
    conn: sqlite3.Connection,
    *,
    task_id: str,
    role: str,
    before_id: int | None = None,
) -> dict[str, Any] | None:
    where = "task_id = ? and role = ?"
    params: list[Any] = [task_id, role]
    if before_id is not None:
        where += " and id < ?"
        params.append(before_id)
    row = conn.execute(
        f"""
        select id, captured_at, content_sha256, content, line_count
        from terminal_captures
        where {where}
        order by id desc
        limit 1
        """,
        params,
    ).fetchone()
    return dict(row) if row else None


def insert_transcript_segment(
    conn: sqlite3.Connection,
    *,
    task_id: str,
    role: str,
    source_capture_id: int,
    previous_capture_id: int | None,
    content_sha256: str,
    segment_text: str | None,
    segment_start_line: int | None,
    segment_end_line: int | None,
    segment_kind: str,
    retention_class: str = "hot",
    timestamp: str | None = None,
) -> int:
    row_timestamp = timestamp or now_iso()
    cursor = conn.execute(
        """
        insert into transcript_segments(
          task_id, role, source_capture_id, previous_capture_id, captured_at,
          content_sha256, segment_text, segment_start_line, segment_end_line,
          byte_count, line_count, retention_class, segment_kind, created_at
        )
        values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            task_id,
            role,
            source_capture_id,
            previous_capture_id,
            row_timestamp,
            content_sha256,
            segment_text,
            segment_start_line,
            segment_end_line,
            len((segment_text or "").encode()),
            len((segment_text or "").splitlines()),
            retention_class,
            segment_kind,
            row_timestamp,
        ),
    )
    segment_id = int(cursor.lastrowid)
    emit_telemetry_event(
        conn,
        actor="workerctl",
        event_type="transcript_segment_recorded",
        task_id=task_id,
        summary=f"Recorded {role} transcript segment.",
        correlation={
            "previous_capture_id": previous_capture_id,
            "role": role,
            "segment_id": segment_id,
            "source_capture_id": source_capture_id,
        },
        attributes={
            "byte_count": len((segment_text or "").encode()),
            "line_count": len((segment_text or "").splitlines()),
            "retention_class": retention_class,
            "segment_end_line": segment_end_line,
            "segment_kind": segment_kind,
            "segment_start_line": segment_start_line,
        },
        timestamp=row_timestamp,
    )
    return segment_id


def insert_agent_observation(
    conn: sqlite3.Connection,
    *,
    task_id: str,
    role: str,
    observation_type: str,
    severity: str,
    message: str,
    payload: dict[str, Any] | None = None,
    worker_id: str | None = None,
    manager_id: str | None = None,
    source_capture_id: int | None = None,
    command_id: str | None = None,
    timestamp: str | None = None,
) -> int:
    cursor = conn.execute(
        """
        insert into agent_observations(
          task_id, worker_id, manager_id, role, observation_type, severity,
          source_capture_id, command_id, created_at, message, payload_json
        )
        values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            task_id,
            worker_id,
            manager_id,
            role,
            observation_type,
            severity,
            source_capture_id,
            command_id,
            timestamp or now_iso(),
            message,
            json.dumps(payload or {}, sort_keys=True),
        ),
    )
    return int(cursor.lastrowid)


def create_manager_cycle(
    conn: sqlite3.Connection,
    *,
    task_id: str,
    manager_id: str | None,
    timestamp: str | None = None,
) -> int:
    cursor = conn.execute(
        """
        insert into manager_cycles(task_id, manager_id, started_at, state)
        values (?, ?, ?, 'started')
        """,
        (task_id, manager_id, timestamp or now_iso()),
    )
    return int(cursor.lastrowid)


def finish_manager_cycle(
    conn: sqlite3.Connection,
    *,
    cycle_id: int,
    state: str,
    health_observation_id: int | None = None,
    manager_capture_id: int | None = None,
    worker_capture_id: int | None = None,
    status: dict[str, Any] | None = None,
    health: dict[str, Any] | None = None,
    decision: str | None = None,
    error: str | None = None,
    timestamp: str | None = None,
) -> None:
    conn.execute(
        """
        update manager_cycles
        set completed_at = ?, state = ?, health_observation_id = ?,
            manager_capture_id = ?, worker_capture_id = ?, status_json = ?,
            health_json = ?, decision = ?, error = ?
        where id = ?
        """,
        (
            timestamp or now_iso(),
            state,
            health_observation_id,
            manager_capture_id,
            worker_capture_id,
            json.dumps(status, sort_keys=True) if status is not None else None,
            json.dumps(health, sort_keys=True) if health is not None else None,
            decision,
            error,
            cycle_id,
        ),
    )


def _manager_cycle_span_from_row(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "attributes": json.loads(row["attributes_json"]),
        "command_id": row["command_id"],
        "completed_at": row["completed_at"],
        "duration_ms": row["duration_ms"],
        "error_type": row["error_type"],
        "id": row["id"],
        "manager_cycle_id": row["manager_cycle_id"],
        "manager_decision_id": row["manager_decision_id"],
        "phase": row["phase"],
        "run_id": row["run_id"],
        "started_at": row["started_at"],
        "state": row["state"],
        "task_id": row["task_id"],
    }


def insert_manager_cycle_span(
    conn: sqlite3.Connection,
    *,
    manager_cycle_id: int,
    task_id: str,
    phase: str,
    started_at: str,
    completed_at: str,
    duration_ms: float,
    state: str = "succeeded",
    attributes: dict[str, Any] | None = None,
    error_type: str | None = None,
    manager_decision_id: int | None = None,
    command_id: str | None = None,
    run_id: str | None = _PRESERVE_FIELD,
) -> int:
    if not phase or not phase.strip():
        raise ValueError("phase must be non-empty")
    if state not in {"succeeded", "failed", "degraded"}:
        raise ValueError("manager cycle span state must be succeeded, failed, or degraded")
    if duration_ms < 0:
        raise ValueError("duration_ms must be non-negative")
    if run_id is _PRESERVE_FIELD:
        active = active_run_for_task(conn, task_id=task_id)
        run_id = active["id"] if active is not None else None
    cursor = conn.execute(
        """
        insert into manager_cycle_spans(
          manager_cycle_id, task_id, run_id, phase, started_at, completed_at,
          duration_ms, state, attributes_json, error_type, manager_decision_id,
          command_id
        )
        values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            manager_cycle_id,
            task_id,
            run_id,
            phase,
            started_at,
            completed_at,
            duration_ms,
            state,
            json.dumps(attributes or {}, sort_keys=True, default=str),
            error_type,
            manager_decision_id,
            command_id,
        ),
    )
    return int(cursor.lastrowid)


def manager_cycle_spans(
    conn: sqlite3.Connection,
    *,
    task_id: str | None = None,
    manager_cycle_id: int | None = None,
) -> list[dict[str, Any]]:
    clauses: list[str] = []
    params: list[Any] = []
    if task_id is not None:
        clauses.append("task_id = ?")
        params.append(task_id)
    if manager_cycle_id is not None:
        clauses.append("manager_cycle_id = ?")
        params.append(manager_cycle_id)
    where = f"where {' and '.join(clauses)}" if clauses else ""
    rows = conn.execute(
        f"""
        select id, manager_cycle_id, task_id, run_id, phase, started_at,
               completed_at, duration_ms, state, attributes_json, error_type,
               manager_decision_id, command_id
        from manager_cycle_spans
        {where}
        order by manager_cycle_id, id
        """,
        params,
    ).fetchall()
    return [_manager_cycle_span_from_row(row) for row in rows]


def insert_manager_decision(
    conn: sqlite3.Connection,
    *,
    task_id: str,
    manager_id: str | None,
    decision: str,
    reason: str,
    manager_cycle_id: int | None = None,
    payload: dict[str, Any] | None = None,
    timestamp: str | None = None,
) -> int:
    cursor = conn.execute(
        """
        insert into manager_decisions(
          task_id, manager_id, manager_cycle_id, decision, reason, created_at, payload_json
        )
        values (?, ?, ?, ?, ?, ?, ?)
        """,
        (
            task_id,
            manager_id,
            manager_cycle_id,
            decision,
            reason,
            timestamp or now_iso(),
            json.dumps(payload or {}, sort_keys=True),
        ),
    )
    decision_id = int(cursor.lastrowid)
    emit_telemetry_event(
        conn,
        actor="manager" if manager_id else "workerctl",
        event_type="manager_decision_recorded",
        task_id=task_id,
        summary=f"Recorded manager decision {decision}.",
        correlation={
            "decision_id": decision_id,
            "manager_cycle_id": manager_cycle_id,
            "manager_id": manager_id,
        },
        attributes={
            "decision": decision,
            "payload": payload or {},
            "reason": reason,
        },
    )
    if manager_cycle_id is not None:
        insert_manager_cycle_span(
            conn,
            manager_cycle_id=manager_cycle_id,
            task_id=task_id,
            phase="manager_decision",
            started_at=timestamp or now_iso(),
            completed_at=timestamp or now_iso(),
            duration_ms=0.0,
            state="succeeded",
            attributes={"decision": decision},
            manager_decision_id=decision_id,
        )
    return decision_id


def _parse_iso(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def assess_manager_decision(
    conn: sqlite3.Connection,
    *,
    task_id: str,
    decision_id: int | None,
    allowed_decisions: set[str],
    max_age_seconds: int = 900,
) -> dict[str, Any]:
    if decision_id is None:
        return {
            "allowed_decisions": sorted(allowed_decisions),
            "decision": None,
            "decision_id": None,
            "ok": False,
            "warnings": ["missing_decision_id"],
        }
    row = conn.execute(
        """
        select id, task_id, manager_id, manager_cycle_id, decision, reason,
               created_at, payload_json
        from manager_decisions
        where id = ?
        """,
        (decision_id,),
    ).fetchone()
    if row is None:
        return {
            "allowed_decisions": sorted(allowed_decisions),
            "decision": None,
            "decision_id": decision_id,
            "ok": False,
            "warnings": ["decision_not_found"],
        }
    decision = {
        "created_at": row["created_at"],
        "decision": row["decision"],
        "id": row["id"],
        "manager_cycle_id": row["manager_cycle_id"],
        "manager_id": row["manager_id"],
        "reason": row["reason"],
        "task_id": row["task_id"],
    }
    warnings: list[str] = []
    if row["task_id"] != task_id:
        warnings.append("decision_task_mismatch")
    if row["decision"] not in allowed_decisions:
        warnings.append("decision_mismatch")
    created_at = _parse_iso(row["created_at"])
    age_seconds = None
    if created_at is None:
        warnings.append("decision_timestamp_invalid")
    else:
        age_seconds = int((datetime.now(timezone.utc) - created_at).total_seconds())
        if age_seconds > max_age_seconds:
            warnings.append("decision_stale")
    return {
        "age_seconds": age_seconds,
        "allowed_decisions": sorted(allowed_decisions),
        "decision": decision,
        "decision_id": decision_id,
        "max_age_seconds": max_age_seconds,
        "ok": not warnings,
        "warnings": warnings,
    }


def require_manager_decision_ok(
    *,
    command_type: str,
    decision_check: dict[str, Any] | None,
    strict: bool,
) -> None:
    if not strict:
        return
    if decision_check and decision_check.get("ok"):
        return
    details = {
        "command_type": command_type,
        "error": "manager_decision_validation_failed",
        "manager_decision": decision_check,
    }
    raise WorkerError(f"strict manager decision validation failed: {json.dumps(details, sort_keys=True)}")


def task_row(conn: sqlite3.Connection, *, task: str) -> sqlite3.Row:
    row = conn.execute(
        """
        select id, name, goal, summary, state, created_at, updated_at
        from tasks
        where id = ? or name = ?
        order by created_at desc
        limit 1
        """,
        (task, task),
    ).fetchone()
    if row is None:
        raise WorkerError(f"Unknown task: {task}")
    return row


def _validate_acceptance_criterion_status(status: str) -> None:
    if status not in ACCEPTANCE_CRITERION_STATUSES:
        allowed = ", ".join(sorted(ACCEPTANCE_CRITERION_STATUSES))
        raise WorkerError(f"invalid acceptance criterion status: {status!r}; expected one of: {allowed}")


def _validate_acceptance_criterion_source(source: str) -> None:
    if source not in ACCEPTANCE_CRITERION_SOURCES:
        allowed = ", ".join(sorted(ACCEPTANCE_CRITERION_SOURCES))
        raise WorkerError(f"invalid acceptance criterion source: {source!r}; expected one of: {allowed}")


def _acceptance_criterion_evidence_json(evidence: dict[str, Any] | None) -> str:
    if evidence is None:
        evidence = {}
    if not isinstance(evidence, dict):
        raise WorkerError("acceptance criterion evidence must be a JSON object")
    return json.dumps(evidence, sort_keys=True)


def _acceptance_criterion_from_row(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "task_id": row["task_id"],
        "criterion": row["criterion"],
        "status": row["status"],
        "source": row["source"],
        "proof": row["proof"],
        "rationale": row["rationale"],
        "evidence": json.loads(row["evidence_json"]),
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


def insert_acceptance_criterion(
    conn: sqlite3.Connection,
    *,
    task_id: str,
    criterion: str,
    status: str,
    source: str,
    proof: str | None = None,
    rationale: str | None = None,
    evidence: dict[str, Any] | None = None,
) -> int:
    _validate_acceptance_criterion_status(status)
    _validate_acceptance_criterion_source(source)
    existing = conn.execute(
        """
        select id
        from acceptance_criteria
        where task_id = ? and source = ? and criterion = ?
        """,
        (task_id, source, criterion),
    ).fetchone()
    if existing is not None:
        return int(existing["id"])
    now = now_iso()
    cursor = conn.execute(
        """
        insert into acceptance_criteria(
          task_id, criterion, status, source, proof, rationale,
          evidence_json, created_at, updated_at
        )
        values (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            task_id,
            criterion,
            status,
            source,
            proof,
            rationale,
            _acceptance_criterion_evidence_json(evidence),
            now,
            now,
        ),
    )
    criterion_id = int(cursor.lastrowid)
    emit_telemetry_event(
        conn,
        actor="workerctl",
        event_type="acceptance_criterion_added",
        task_id=task_id,
        summary="Added acceptance criterion.",
        correlation={"criterion_id": criterion_id, "source": source},
        attributes={
            "criterion": criterion,
            "has_evidence": bool(evidence),
            "has_proof": proof is not None,
            "status": status,
        },
        timestamp=now,
    )
    return criterion_id


def seed_manager_acceptance_criteria(
    conn: sqlite3.Connection,
    *,
    task_id: str,
    criteria: list[str] | tuple[str, ...] | None,
) -> list[int]:
    """Seed accepted ledger criteria from manager config without changing existing rows."""
    inserted: list[int] = []
    seen: set[str] = set()
    for raw in criteria or []:
        criterion = raw.strip() if isinstance(raw, str) else ""
        if not criterion or criterion in seen:
            continue
        seen.add(criterion)
        existing = conn.execute(
            """
            select id
            from acceptance_criteria
            where task_id = ? and criterion = ?
            limit 1
            """,
            (task_id, criterion),
        ).fetchone()
        if existing is not None:
            continue
        inserted.append(
            insert_acceptance_criterion(
                conn,
                task_id=task_id,
                criterion=criterion,
                status="accepted",
                source="manager_inferred",
                rationale="Seeded from manager acceptance configuration.",
                evidence={"source": "manager_config"},
            )
        )
    return inserted


def acceptance_criteria_for_task(
    conn: sqlite3.Connection,
    *,
    task_id: str,
    statuses: list[str] | tuple[str, ...] | set[str] | None = None,
) -> list[dict[str, Any]]:
    params: list[Any] = [task_id]
    where = "where task_id = ?"
    if statuses is not None:
        status_list = list(statuses)
        for status in status_list:
            _validate_acceptance_criterion_status(status)
        if not status_list:
            return []
        where += f" and status in ({','.join('?' for _ in status_list)})"
        params.extend(status_list)
    rows = conn.execute(
        f"""
        select id, task_id, criterion, status, source, proof, rationale,
               evidence_json, created_at, updated_at
        from acceptance_criteria
        {where}
        order by id
        """,
        tuple(params),
    ).fetchall()
    return [_acceptance_criterion_from_row(row) for row in rows]


def update_acceptance_criterion(
    conn: sqlite3.Connection,
    *,
    criterion_id: int,
    status: str,
    evidence: Any = _PRESERVE_FIELD,
    proof: Any = _PRESERVE_FIELD,
    rationale: Any = _PRESERVE_FIELD,
) -> dict[str, Any]:
    _validate_acceptance_criterion_status(status)
    existing = conn.execute(
        """
        select id, task_id, criterion, status, source, proof, rationale,
               evidence_json, created_at, updated_at
        from acceptance_criteria
        where id = ?
        """,
        (criterion_id,),
    ).fetchone()
    if existing is None:
        raise WorkerError(f"Unknown acceptance criterion: {criterion_id}")
    evidence_json = (
        existing["evidence_json"]
        if evidence is _PRESERVE_FIELD
        else _acceptance_criterion_evidence_json(evidence)
    )
    conn.execute(
        """
        update acceptance_criteria
        set status = ?,
            evidence_json = ?,
            proof = ?,
            rationale = ?,
            updated_at = ?
        where id = ?
        """,
        (
            status,
            evidence_json,
            existing["proof"] if proof is _PRESERVE_FIELD else proof,
            existing["rationale"] if rationale is _PRESERVE_FIELD else rationale,
            now_iso(),
            criterion_id,
        ),
    )
    row = conn.execute(
        """
        select id, task_id, criterion, status, source, proof, rationale,
               evidence_json, created_at, updated_at
        from acceptance_criteria
        where id = ?
        """,
        (criterion_id,),
    ).fetchone()
    updated = _acceptance_criterion_from_row(row)
    emit_telemetry_event(
        conn,
        actor="workerctl",
        event_type="acceptance_criterion_updated",
        task_id=updated["task_id"],
        summary="Updated acceptance criterion.",
        correlation={"criterion_id": criterion_id, "source": updated["source"]},
        attributes={
            "criterion": updated["criterion"],
            "has_evidence": bool(updated["evidence"]),
            "has_proof": updated["proof"] is not None,
            "previous_status": existing["status"],
            "status": updated["status"],
        },
    )
    return updated


def worker_row(conn: sqlite3.Connection, *, worker: str) -> sqlite3.Row:
    row = conn.execute(
        """
        select id, name, tmux_session, tmux_pane_id, identity_token, cwd, state,
               created_at, updated_at, last_seen_at, exit_detected_at, exit_reason
        from workers
        where id = ? or name = ?
        limit 1
        """,
        (worker, worker),
    ).fetchone()
    if row is None:
        raise WorkerError(f"Unknown worker: {worker}")
    return row


def create_task(
    conn: sqlite3.Connection,
    *,
    name: str,
    goal: str,
    summary: str | None = None,
    task_id: str | None = None,
    timestamp: str | None = None,
) -> str:
    new_task_id = task_id or f"task-{uuid.uuid4()}"
    now = timestamp or now_iso()
    conn.execute(
        """
        insert into tasks(id, name, goal, summary, state, created_at, updated_at)
        values (?, ?, ?, ?, 'candidate', ?, ?)
        """,
        (new_task_id, name, goal, summary, now, now),
    )
    insert_event(
        conn,
        "task_created",
        actor="workerctl",
        task_id=new_task_id,
        payload={"goal": goal, "name": name, "summary": summary},
    )
    return new_task_id


def ensure_task(
    conn: sqlite3.Connection,
    *,
    name: str,
    goal: str,
    summary: str | None = None,
    timestamp: str | None = None,
) -> str:
    row = conn.execute(
        """
        select id, state from tasks
        where name = ?
        order by created_at desc
        limit 1
        """,
        (name,),
    ).fetchone()
    if row is not None:
        if row["state"] not in {"candidate", "paused"}:
            raise WorkerError(f"Task {name} is not promotable in state {row['state']}")
        return str(row["id"])
    return create_task(conn, name=name, goal=goal, summary=summary, timestamp=timestamp)


def set_budget(
    conn: sqlite3.Connection,
    *,
    task_id: str,
    max_nudges: int,
    expires_at: str,
) -> None:
    conn.execute(
        """
        insert into budgets(task_id, max_nudges, nudges_used, expires_at)
        values (?, ?, 0, ?)
        on conflict(task_id) do update set
          max_nudges = excluded.max_nudges,
          expires_at = excluded.expires_at,
          nudges_used = min(budgets.nudges_used, excluded.max_nudges)
        """,
        (task_id, max_nudges, expires_at),
    )


def extend_nudge_budget(
    conn: sqlite3.Connection,
    *,
    task_id: str,
    add_nudges: int,
    expires_at: str,
) -> dict[str, Any]:
    if add_nudges <= 0:
        raise WorkerError("--add-nudges must be > 0")
    conn.execute(
        """
        insert into budgets(task_id, max_nudges, nudges_used, expires_at)
        values (?, ?, 0, ?)
        on conflict(task_id) do update set
          max_nudges = budgets.max_nudges + excluded.max_nudges,
          expires_at = excluded.expires_at
        """,
        (task_id, add_nudges, expires_at),
    )
    row = conn.execute(
        "select max_nudges, nudges_used, expires_at from budgets where task_id = ?",
        (task_id,),
    ).fetchone()
    return {
        "expires_at": row["expires_at"],
        "max_nudges": row["max_nudges"],
        "nudges_remaining": row["max_nudges"] - row["nudges_used"],
        "nudges_used": row["nudges_used"],
    }


def reserve_nudge_budget(conn: sqlite3.Connection, *, task_id: str, timestamp: str | None = None) -> dict[str, Any] | None:
    row = conn.execute(
        "select max_nudges, nudges_used, expires_at from budgets where task_id = ?",
        (task_id,),
    ).fetchone()
    if row is None:
        return None
    now = timestamp or now_iso()
    if row["expires_at"] < now:
        raise WorkerError(f"Nudge budget expired at {row['expires_at']}")
    if row["nudges_used"] >= row["max_nudges"]:
        raise WorkerError("Nudge budget exhausted")
    conn.execute(
        """
        update budgets
        set nudges_used = nudges_used + 1
        where task_id = ? and nudges_used < max_nudges and expires_at >= ?
        """,
        (task_id, now),
    )
    updated = conn.execute(
        "select max_nudges, nudges_used, expires_at from budgets where task_id = ?",
        (task_id,),
    ).fetchone()
    return {
        "expires_at": updated["expires_at"],
        "max_nudges": updated["max_nudges"],
        "nudges_remaining": updated["max_nudges"] - updated["nudges_used"],
        "nudges_used": updated["nudges_used"],
    }


def insert_prompt(
    conn: sqlite3.Connection,
    *,
    task_id: str,
    kind: str,
    content: str,
    content_sha256: str,
    generator_version: str,
    source_snapshot: dict[str, Any],
    policy: dict[str, Any],
    manager_id: str | None = None,
    artifact_path: str | None = None,
    timestamp: str | None = None,
) -> int:
    cursor = conn.execute(
        """
        insert into prompts(
          task_id, manager_id, kind, content, content_sha256, generator_version,
          source_snapshot_json, policy_json, artifact_path, created_at
        )
        values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            task_id,
            manager_id,
            kind,
            content,
            content_sha256,
            generator_version,
            json.dumps(source_snapshot, sort_keys=True),
            json.dumps(policy, sort_keys=True),
            artifact_path,
            timestamp or now_iso(),
        ),
    )
    return int(cursor.lastrowid)


def insert_worker_handoff(
    conn: sqlite3.Connection,
    *,
    task_id: str,
    summary: str,
    next_steps: list[str] | None = None,
    payload: dict[str, Any] | None = None,
    worker_session_id: str | None = None,
    timestamp: str | None = None,
) -> int:
    cursor = conn.execute(
        """
        insert into worker_handoffs(
          task_id, worker_session_id, summary, next_steps_json, payload_json, created_at
        )
        values (?, ?, ?, ?, ?, ?)
        """,
        (
            task_id,
            worker_session_id,
            summary,
            json.dumps(next_steps or [], sort_keys=True),
            json.dumps(payload or {}, sort_keys=True),
            timestamp or now_iso(),
        ),
    )
    handoff_id = int(cursor.lastrowid)
    emit_telemetry_event(
        conn,
        actor="worker",
        event_type="worker_handoff_recorded",
        task_id=task_id,
        summary="Recorded worker handoff.",
        correlation={"handoff_id": handoff_id, "worker_session_id": worker_session_id},
        attributes={
            "next_step_count": len(next_steps or []),
            "payload_keys": sorted((payload or {}).keys()),
            "summary_length": len(summary),
        },
        timestamp=timestamp,
    )
    return handoff_id


def latest_worker_handoff(conn: sqlite3.Connection, *, task_id: str) -> dict[str, Any] | None:
    row = conn.execute(
        """
        select id, task_id, worker_session_id, summary, next_steps_json, payload_json, created_at
        from worker_handoffs
        where task_id = ?
        order by id desc
        limit 1
        """,
        (task_id,),
    ).fetchone()
    if row is None:
        return None
    return {
        "created_at": row["created_at"],
        "id": row["id"],
        "next_steps": json.loads(row["next_steps_json"]),
        "payload": json.loads(row["payload_json"]),
        "summary": row["summary"],
        "task_id": row["task_id"],
        "worker_session_id": row["worker_session_id"],
    }


def insert_task_acknowledgement(
    conn: sqlite3.Connection,
    *,
    task_id: str,
    role: str,
    payload: dict[str, Any],
    binding_id: str | None = None,
    correlation_id: str | None = None,
    timestamp: str | None = None,
) -> int:
    if role not in {"worker", "manager"}:
        raise WorkerError("ack role must be one of: worker, manager")
    if not isinstance(payload, dict):
        raise WorkerError("ack payload must be a JSON object")
    if binding_id is None:
        binding_row = conn.execute(
            """
            select id
            from bindings
            where task_id = ? and state in ('active', 'ending')
            order by created_at desc, id desc
            limit 1
            """,
            (task_id,),
        ).fetchone()
        binding_id = binding_row["id"] if binding_row else None
    config_row = conn.execute(
        "select revision from manager_configs where task_id = ?",
        (task_id,),
    ).fetchone()
    manager_config_revision = int(config_row["revision"]) if config_row else None
    row = conn.execute(
        """
        select max(revision) as revision
        from task_acknowledgements
        where task_id = ? and role = ?
        """,
        (task_id, role),
    ).fetchone()
    revision = int(row["revision"] or 0) + 1
    cursor = conn.execute(
        """
        insert into task_acknowledgements(
          task_id, binding_id, role, payload_json, revision, manager_config_revision, created_at, correlation_id
        )
        values (?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            task_id,
            binding_id,
            role,
            json.dumps(payload, sort_keys=True),
            revision,
            manager_config_revision,
            timestamp or now_iso(),
            correlation_id,
        ),
    )
    return int(cursor.lastrowid)


def latest_task_acknowledgement(
    conn: sqlite3.Connection,
    *,
    task_id: str,
    role: str,
) -> dict[str, Any] | None:
    row = conn.execute(
        """
        select id, task_id, binding_id, role, payload_json, revision,
               manager_config_revision, created_at, correlation_id
        from task_acknowledgements
        where task_id = ? and role = ?
        order by revision desc, id desc
        limit 1
        """,
        (task_id, role),
    ).fetchone()
    if row is None:
        return None
    return {
        "binding_id": row["binding_id"],
        "correlation_id": row["correlation_id"],
        "created_at": row["created_at"],
        "id": row["id"],
        "manager_config_revision": row["manager_config_revision"],
        "payload": json.loads(row["payload_json"]),
        "revision": row["revision"],
        "role": row["role"],
        "task_id": row["task_id"],
    }


def latest_task_acknowledgements(conn: sqlite3.Connection, *, task_id: str) -> dict[str, Any]:
    return {
        "worker": latest_task_acknowledgement(conn, task_id=task_id, role="worker"),
        "manager": latest_task_acknowledgement(conn, task_id=task_id, role="manager"),
    }


def insert_epilogue_run(
    conn: sqlite3.Connection,
    *,
    task_id: str,
    step_name: str,
    state: str,
    result: dict[str, Any] | None = None,
    error: str | None = None,
    correlation_id: str | None = None,
    started_at: str | None = None,
    finished_at: str | None = None,
) -> int:
    if state not in {"pending", "running", "succeeded", "failed", "skipped"}:
        raise WorkerError(f"invalid epilogue state: {state}")
    start = started_at or now_iso()
    finish = finished_at if finished_at is not None else (now_iso() if state in {"succeeded", "failed", "skipped"} else None)
    cursor = conn.execute(
        """
        insert into epilogue_runs(
          task_id, step_name, state, started_at, finished_at, result_json, error, correlation_id
        )
        values (?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            task_id,
            step_name,
            state,
            start,
            finish,
            json.dumps(result, sort_keys=True) if result is not None else None,
            error,
            correlation_id,
        ),
    )
    return int(cursor.lastrowid)


def epilogue_runs(conn: sqlite3.Connection, *, task_id: str) -> list[dict[str, Any]]:
    rows = conn.execute(
        """
        select id, task_id, step_name, state, started_at, finished_at, result_json, error, correlation_id
        from epilogue_runs
        where task_id = ?
        order by id
        """,
        (task_id,),
    ).fetchall()
    return [
        {
            "correlation_id": row["correlation_id"],
            "error": row["error"],
            "finished_at": row["finished_at"],
            "id": row["id"],
            "result": json.loads(row["result_json"]) if row["result_json"] else None,
            "started_at": row["started_at"],
            "state": row["state"],
            "step_name": row["step_name"],
            "task_id": row["task_id"],
        }
        for row in rows
    ]


def latest_epilogue_runs_by_step(conn: sqlite3.Connection, *, task_id: str) -> dict[str, dict[str, Any]]:
    latest: dict[str, dict[str, Any]] = {}
    for row in epilogue_runs(conn, task_id=task_id):
        latest[row["step_name"]] = row
    return latest


def epilogue_status(conn: sqlite3.Connection, *, task_id: str, required_steps: list[str]) -> dict[str, Any]:
    latest = latest_epilogue_runs_by_step(conn, task_id=task_id)
    steps = []
    for step in required_steps:
        run = latest.get(step)
        steps.append(
            {
                "latest_run": run,
                "ok": bool(run and run["state"] == "succeeded"),
                "state": run["state"] if run else "pending",
                "step_name": step,
            }
        )
    missing_or_incomplete = [step["step_name"] for step in steps if not step["ok"]]
    return {
        "missing_or_incomplete": missing_or_incomplete,
        "ok": not missing_or_incomplete,
        "required_steps": required_steps,
        "steps": steps,
    }


def insert_task_continuation(
    conn: sqlite3.Connection,
    *,
    task_id: str,
    proposer: str,
    payload: dict[str, Any],
    correlation_id: str,
    timestamp: str | None = None,
) -> int:
    if proposer not in {"worker", "manager"}:
        raise WorkerError("continuation proposer must be worker or manager")
    if not isinstance(payload, dict):
        raise WorkerError("continuation payload must be a JSON object")
    row = conn.execute(
        "select max(revision) as revision from task_continuations where task_id = ? and proposer = ?",
        (task_id, proposer),
    ).fetchone()
    revision = int(row["revision"] or 0) + 1
    cursor = conn.execute(
        """
        insert into task_continuations(
          task_id, proposer, payload_json, revision, created_at, correlation_id
        )
        values (?, ?, ?, ?, ?, ?)
        """,
        (
            task_id,
            proposer,
            json.dumps(payload, sort_keys=True),
            revision,
            timestamp or now_iso(),
            correlation_id,
        ),
    )
    return int(cursor.lastrowid)


def task_continuations(conn: sqlite3.Connection, *, task_id: str, correlation_id: str | None = None) -> list[dict[str, Any]]:
    query = """
        select id, task_id, proposer, payload_json, revision, created_at, correlation_id
        from task_continuations
        where task_id = ?
    """
    params: list[Any] = [task_id]
    if correlation_id is not None:
        query += " and correlation_id = ?"
        params.append(correlation_id)
    query += " order by id"
    return [
        {
            "correlation_id": row["correlation_id"],
            "created_at": row["created_at"],
            "id": row["id"],
            "payload": json.loads(row["payload_json"]),
            "proposer": row["proposer"],
            "revision": row["revision"],
            "task_id": row["task_id"],
        }
        for row in conn.execute(query, tuple(params))
    ]


def latest_task_continuation(
    conn: sqlite3.Connection,
    *,
    task_id: str,
    proposer: str,
    correlation_id: str | None = None,
) -> dict[str, Any] | None:
    rows = task_continuations(conn, task_id=task_id, correlation_id=correlation_id)
    for row in reversed(rows):
        if row["proposer"] == proposer:
            return row
    return None


def insert_continuation_review(
    conn: sqlite3.Connection,
    *,
    task_id: str,
    worker_continuation_id: int,
    manager_continuation_id: int,
    agreement: str,
    verdict: str,
    addendum: str | None,
    rationale: str,
    subagent_run: dict[str, Any],
    correlation_id: str,
    timestamp: str | None = None,
) -> int:
    if agreement not in {"match", "compatible", "divergent"}:
        raise WorkerError("review agreement must be match, compatible, or divergent")
    if verdict not in {"proceed", "amend", "stop"}:
        raise WorkerError("review verdict must be proceed, amend, or stop")
    cursor = conn.execute(
        """
        insert into continuation_reviews(
          task_id, worker_continuation_id, manager_continuation_id, agreement,
          verdict, addendum, rationale, subagent_run_json, created_at, correlation_id
        )
        values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            task_id,
            worker_continuation_id,
            manager_continuation_id,
            agreement,
            verdict,
            addendum,
            rationale,
            json.dumps(subagent_run, sort_keys=True),
            timestamp or now_iso(),
            correlation_id,
        ),
    )
    return int(cursor.lastrowid)


def continuation_reviews(conn: sqlite3.Connection, *, task_id: str) -> list[dict[str, Any]]:
    return [
        {
            "addendum": row["addendum"],
            "agreement": row["agreement"],
            "correlation_id": row["correlation_id"],
            "created_at": row["created_at"],
            "id": row["id"],
            "manager_continuation_id": row["manager_continuation_id"],
            "rationale": row["rationale"],
            "subagent_run": json.loads(row["subagent_run_json"]),
            "task_id": row["task_id"],
            "verdict": row["verdict"],
            "worker_continuation_id": row["worker_continuation_id"],
        }
        for row in conn.execute(
            """
            select id, task_id, worker_continuation_id, manager_continuation_id,
                   agreement, verdict, addendum, rationale, subagent_run_json,
                   created_at, correlation_id
            from continuation_reviews
            where task_id = ?
            order by id
            """,
            (task_id,),
        )
    ]


def upsert_manager_config(
    conn: sqlite3.Connection,
    *,
    task_id: str,
    supervision_mode: str,
    objective: str | None = None,
    guidelines: list[str] | None = None,
    acceptance_criteria: list[str] | None = None,
    reference_paths: list[str] | None = None,
    permissions: dict[str, Any] | None = None,
    tools: list[str] | None = None,
    epilogues: list[str] | None = None,
    nudge_on_completion: str = "ask-operator",
    require_acks: bool = False,
    timestamp: str | None = None,
) -> None:
    if nudge_on_completion not in {"off", "ask-operator", "auto-review", "auto-proceed"}:
        raise WorkerError("nudge_on_completion must be off, ask-operator, auto-review, or auto-proceed")
    now = timestamp or now_iso()
    conn.execute(
        """
        insert into manager_configs(
          task_id, supervision_mode, objective, guidelines_json,
          acceptance_criteria_json, reference_paths_json, permissions_json, tools_json, epilogues_json, nudge_on_completion, require_acks,
          revision, created_at, updated_at
        )
        values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
        on conflict(task_id) do update set
          supervision_mode = excluded.supervision_mode,
          objective = excluded.objective,
          guidelines_json = excluded.guidelines_json,
          acceptance_criteria_json = excluded.acceptance_criteria_json,
          reference_paths_json = excluded.reference_paths_json,
          permissions_json = excluded.permissions_json,
          tools_json = excluded.tools_json,
          epilogues_json = excluded.epilogues_json,
          nudge_on_completion = excluded.nudge_on_completion,
          require_acks = excluded.require_acks,
          revision = case when
            manager_configs.supervision_mode is not excluded.supervision_mode or
            manager_configs.objective is not excluded.objective or
            manager_configs.guidelines_json is not excluded.guidelines_json or
            manager_configs.acceptance_criteria_json is not excluded.acceptance_criteria_json or
            manager_configs.reference_paths_json is not excluded.reference_paths_json or
            manager_configs.permissions_json is not excluded.permissions_json or
            manager_configs.tools_json is not excluded.tools_json or
            manager_configs.epilogues_json is not excluded.epilogues_json or
            manager_configs.nudge_on_completion is not excluded.nudge_on_completion or
            manager_configs.require_acks is not excluded.require_acks
          then manager_configs.revision + 1 else manager_configs.revision end,
          updated_at = excluded.updated_at
        """,
        (
            task_id,
            supervision_mode,
            objective,
            json.dumps(guidelines or [], sort_keys=True),
            json.dumps(acceptance_criteria or [], sort_keys=True),
            json.dumps(reference_paths or [], sort_keys=True),
            json.dumps(normalize_manager_permissions_json(permissions), sort_keys=True),
            json.dumps(tools or [], sort_keys=True),
            json.dumps(epilogues or [], sort_keys=True),
            nudge_on_completion,
            1 if require_acks else 0,
            now,
            now,
        ),
    )


def manager_config(conn: sqlite3.Connection, *, task_id: str) -> dict[str, Any] | None:
    row = conn.execute(
        """
        select task_id, supervision_mode, objective, guidelines_json,
               acceptance_criteria_json, reference_paths_json, permissions_json, tools_json, epilogues_json, nudge_on_completion, require_acks,
               revision, created_at, updated_at
        from manager_configs
        where task_id = ?
        """,
        (task_id,),
    ).fetchone()
    if row is None:
        return None
    return {
        "acceptance_criteria": json.loads(row["acceptance_criteria_json"]),
        "created_at": row["created_at"],
        "epilogues": json.loads(row["epilogues_json"]),
        "guidelines": json.loads(row["guidelines_json"]),
        "nudge_on_completion": row["nudge_on_completion"],
        "objective": row["objective"],
        "permissions": normalize_manager_permissions_json(json.loads(row["permissions_json"])),
        "reference_paths": json.loads(row["reference_paths_json"]),
        "require_acks": bool(row["require_acks"]),
        "revision": row["revision"],
        "supervision_mode": row["supervision_mode"],
        "task_id": row["task_id"],
        "tools": json.loads(row["tools_json"]),
        "updated_at": row["updated_at"],
    }


def _metadata_json(metadata: dict[str, Any] | None, *, field: str) -> str:
    if metadata is None:
        metadata = {}
    if not isinstance(metadata, dict):
        raise WorkerError(f"{field} must be a JSON object")
    return json.dumps(metadata, sort_keys=True)


def _validate_telemetry_actor(actor: str) -> None:
    if actor not in TELEMETRY_ACTORS:
        allowed = ", ".join(sorted(TELEMETRY_ACTORS))
        raise WorkerError(f"invalid telemetry actor: {actor!r}; expected one of: {allowed}")


def _validate_telemetry_severity(severity: str) -> None:
    if severity not in TELEMETRY_SEVERITIES:
        allowed = ", ".join(sorted(TELEMETRY_SEVERITIES))
        raise WorkerError(f"invalid telemetry severity: {severity!r}; expected one of: {allowed}")


def _task_exists(conn: sqlite3.Connection, *, task_id: str) -> bool:
    return conn.execute("select 1 from tasks where id = ?", (task_id,)).fetchone() is not None


def _run_from_row(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "ended_at": row["ended_at"],
        "id": row["id"],
        "metadata": json.loads(row["metadata_json"]),
        "name": row["name"],
        "purpose": row["purpose"],
        "started_at": row["started_at"],
        "status": row["status"],
        "task_id": row["task_id"],
    }


def _telemetry_event_from_row(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "actor": row["actor"],
        "attributes": json.loads(row["attributes_json"]),
        "correlation": json.loads(row["correlation_json"]),
        "event_type": row["event_type"],
        "id": row["id"],
        "run_id": row["run_id"],
        "severity": row["severity"],
        "summary": row["summary"],
        "task_id": row["task_id"],
        "timestamp": row["timestamp"],
    }


def run_row(conn: sqlite3.Connection, *, run: str) -> dict[str, Any]:
    row = conn.execute(
        """
        select id, task_id, name, purpose, status, started_at, ended_at, metadata_json
        from runs
        where id = ? or name = ?
        order by started_at desc, id desc
        limit 1
        """,
        (run, run),
    ).fetchone()
    if row is None:
        raise WorkerError(f"Unknown run: {run}")
    return _run_from_row(row)


def active_run_for_task(conn: sqlite3.Connection, *, task_id: str) -> dict[str, Any] | None:
    row = conn.execute(
        """
        select id, task_id, name, purpose, status, started_at, ended_at, metadata_json
        from runs
        where task_id = ? and status = 'active'
        order by started_at desc, id desc
        limit 1
        """,
        (task_id,),
    ).fetchone()
    return _run_from_row(row) if row is not None else None


def create_run(
    conn: sqlite3.Connection,
    *,
    task_id: str,
    name: str | None = None,
    purpose: str | None = None,
    metadata: dict[str, Any] | None = None,
    run_id: str | None = None,
    timestamp: str | None = None,
) -> str:
    task = conn.execute(
        "select id, name, goal from tasks where id = ?",
        (task_id,),
    ).fetchone()
    if task is None:
        raise WorkerError(f"Unknown task id: {task_id}")
    existing = active_run_for_task(conn, task_id=task_id)
    if existing is not None:
        raise WorkerError(f"task {task['name']!r} already has active run {existing['id']!r}")
    now = timestamp or now_iso()
    new_run_id = run_id or f"run-{uuid.uuid4()}"
    run_name = name or f"{task['name']}-{now.replace(':', '').replace('.', '-')}"
    conn.execute(
        """
        insert into runs(id, task_id, name, purpose, status, started_at, metadata_json)
        values (?, ?, ?, ?, 'active', ?, ?)
        """,
        (
            new_run_id,
            task_id,
            run_name,
            purpose,
            now,
            _metadata_json(metadata, field="run metadata"),
        ),
    )
    return new_run_id


def finish_run(
    conn: sqlite3.Connection,
    *,
    run: str,
    status: str = "finished",
    timestamp: str | None = None,
) -> dict[str, Any]:
    if status not in {"finished", "failed", "abandoned"}:
        raise WorkerError("run finish status must be one of: finished, failed, abandoned")
    current = run_row(conn, run=run)
    now = timestamp or now_iso()
    conn.execute(
        """
        update runs
        set status = ?, ended_at = ?
        where id = ?
        """,
        (status, now, current["id"]),
    )
    emit_telemetry_event(
        conn,
        actor="workerctl",
        event_type="run_finished",
        severity="error" if status == "failed" else "info",
        run_id=current["id"],
        summary=f"Run {current['name']} marked {status}.",
        correlation={"run_id": current["id"], "run_name": current["name"]},
        attributes={"status": status},
        timestamp=now,
    )
    return run_row(conn, run=current["id"])


def list_runs(
    conn: sqlite3.Connection,
    *,
    task_id: str | None = None,
    status: str | None = None,
) -> list[dict[str, Any]]:
    clauses: list[str] = []
    params: list[Any] = []
    if task_id is not None:
        clauses.append("runs.task_id = ?")
        params.append(task_id)
    if status is not None:
        clauses.append("runs.status = ?")
        params.append(status)
    where = f"where {' and '.join(clauses)}" if clauses else ""
    rows = conn.execute(
        f"""
        select runs.id, runs.task_id, runs.name, runs.purpose, runs.status,
               runs.started_at, runs.ended_at, runs.metadata_json
        from runs
        {where}
        order by runs.started_at desc, runs.id desc
        """,
        params,
    ).fetchall()
    return [_run_from_row(row) for row in rows]


def emit_telemetry_event(
    conn: sqlite3.Connection,
    *,
    actor: str,
    event_type: str,
    summary: str,
    severity: str = "info",
    run_id: str | None = None,
    task_id: str | None = None,
    correlation: dict[str, Any] | None = None,
    attributes: dict[str, Any] | None = None,
    event_id: str | None = None,
    timestamp: str | None = None,
) -> str:
    _validate_telemetry_actor(actor)
    _validate_telemetry_severity(severity)
    correlation_json = _metadata_json(correlation, field="telemetry correlation")
    attributes_json = _metadata_json(attributes, field="telemetry attributes")
    if run_id is not None:
        run = run_row(conn, run=run_id)
        if task_id is not None and task_id != run["task_id"]:
            raise WorkerError(
                f"telemetry event task_id {task_id!r} does not match run {run['id']!r} task_id {run['task_id']!r}"
            )
        task_id = run["task_id"]
        run_id = run["id"]
    elif task_id is not None:
        if not _task_exists(conn, task_id=task_id):
            raise WorkerError(f"Unknown task id: {task_id}")
        active = active_run_for_task(conn, task_id=task_id)
        if active is not None:
            run_id = active["id"]
    new_event_id = event_id or f"telemetry-{uuid.uuid4()}"
    conn.execute(
        """
        insert into telemetry_events(
          id, run_id, task_id, timestamp, actor, event_type, severity,
          summary, correlation_json, attributes_json
        )
        values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            new_event_id,
            run_id,
            task_id,
            timestamp or now_iso(),
            actor,
            event_type,
            severity,
            summary,
            correlation_json,
            attributes_json,
        ),
    )
    conn.execute(
        """
        insert into telemetry_events_fts(
          event_id, task_id, run_id, actor, event_type, summary, attributes
        )
        values (?, ?, ?, ?, ?, ?, ?)
        """,
        (new_event_id, task_id, run_id, actor, event_type, summary, attributes_json),
    )
    return new_event_id


def telemetry_events(
    conn: sqlite3.Connection,
    *,
    run_id: str | None = None,
    task_id: str | None = None,
    limit: int = 100,
) -> list[dict[str, Any]]:
    clauses: list[str] = []
    params: list[Any] = []
    if run_id is not None:
        clauses.append("run_id = ?")
        params.append(run_id)
    if task_id is not None:
        clauses.append("task_id = ?")
        params.append(task_id)
    where = f"where {' and '.join(clauses)}" if clauses else ""
    params.append(limit)
    rows = conn.execute(
        f"""
        select id, run_id, task_id, timestamp, actor, event_type, severity,
               summary, correlation_json, attributes_json
        from telemetry_events
        {where}
        order by timestamp, rowid
        limit ?
        """,
        params,
    ).fetchall()
    return [_telemetry_event_from_row(row) for row in rows]


def query_telemetry_events(
    conn: sqlite3.Connection,
    *,
    run_id: str | None = None,
    task_id: str | None = None,
    actor: str | None = None,
    event_type: str | None = None,
    severity: str | None = None,
    search: str | None = None,
    limit: int = 100,
) -> list[dict[str, Any]]:
    clauses: list[str] = []
    params: list[Any] = []
    from_sql = "telemetry_events te"
    if search:
        from_sql = "telemetry_events te join telemetry_events_fts fts on fts.event_id = te.id"
        clauses.append("telemetry_events_fts match ?")
        params.append(_telemetry_fts_query(search))
    if run_id is not None:
        clauses.append("te.run_id = ?")
        params.append(run_id)
    if task_id is not None:
        clauses.append("te.task_id = ?")
        params.append(task_id)
    if actor is not None:
        _validate_telemetry_actor(actor)
        clauses.append("te.actor = ?")
        params.append(actor)
    if event_type is not None:
        clauses.append("te.event_type = ?")
        params.append(event_type)
    if severity is not None:
        _validate_telemetry_severity(severity)
        clauses.append("te.severity = ?")
        params.append(severity)
    where = f"where {' and '.join(clauses)}" if clauses else ""
    params.append(limit)
    rows = conn.execute(
        f"""
        select te.id, te.run_id, te.task_id, te.timestamp, te.actor,
               te.event_type, te.severity, te.summary,
               te.correlation_json, te.attributes_json
        from {from_sql}
        {where}
        order by te.timestamp, te.rowid
        limit ?
        """,
        params,
    ).fetchall()
    return [_telemetry_event_from_row(row) for row in rows]


def _telemetry_fts_query(search: str) -> str:
    return " ".join(f'"{term.replace(chr(34), chr(34) + chr(34))}"' for term in search.split())


def telemetry_summary(events: list[dict[str, Any]]) -> dict[str, Any]:
    summary: dict[str, Any] = {
        "by_actor": {},
        "by_event_type": {},
        "by_severity": {},
        "first_timestamp": None,
        "last_timestamp": None,
        "run_id": None,
        "task_id": None,
        "total": len(events),
    }
    if events:
        summary["first_timestamp"] = events[0]["timestamp"]
        summary["last_timestamp"] = events[-1]["timestamp"]
        run_ids = {event["run_id"] for event in events if event["run_id"] is not None}
        task_ids = {event["task_id"] for event in events if event["task_id"] is not None}
        summary["run_id"] = next(iter(run_ids)) if len(run_ids) == 1 else None
        summary["task_id"] = next(iter(task_ids)) if len(task_ids) == 1 else None
    for event in events:
        for key, field in (
            ("by_actor", "actor"),
            ("by_event_type", "event_type"),
            ("by_severity", "severity"),
        ):
            value = event[field]
            bucket = summary[key]
            bucket[value] = bucket.get(value, 0) + 1
    return summary


def create_manager(
    conn: sqlite3.Connection,
    *,
    task_id: str,
    name: str,
    tmux_session: str,
    codex_args: list[str],
    state: str = "starting",
    manager_id: str | None = None,
    tmux_pane_id: str | None = None,
    timestamp: str | None = None,
) -> str:
    new_manager_id = manager_id or name
    now = timestamp or now_iso()
    conn.execute(
        """
        insert into managers(
          id, name, task_id, tmux_session, tmux_pane_id, state, codex_args_json, started_at
        )
        values (?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (new_manager_id, name, task_id, tmux_session, tmux_pane_id, state, json.dumps(codex_args), now),
    )
    return new_manager_id


def manager_from_row(row: sqlite3.Row, *, task_id: str) -> dict[str, Any]:
    return {
        "codex_args": json.loads(row["codex_args_json"]),
        "exit_detected_at": row["exit_detected_at"],
        "exit_reason": row["exit_reason"],
        "id": row["id"],
        "last_seen_at": row["last_seen_at"],
        "name": row["name"],
        "started_at": row["started_at"],
        "state": row["state"],
        "stopped_at": row["stopped_at"],
        "task_id": task_id,
        "tmux_pane_id": row["tmux_pane_id"],
        "tmux_session": row["tmux_session"],
    }


def active_manager(conn: sqlite3.Connection, *, task: str) -> dict[str, Any] | None:
    task = task_row(conn, task=task)
    row = conn.execute(
        """
        select id, name, tmux_session, tmux_pane_id, state, codex_args_json, started_at,
               stopped_at, last_seen_at, exit_detected_at, exit_reason
        from managers
        where task_id = ? and state in ('starting', 'ready', 'stopping')
        order by started_at desc
        limit 1
        """,
        (task["id"],),
    ).fetchone()
    if row is None:
        return None
    return manager_from_row(row, task_id=task["id"])


def set_manager_pane_id(conn: sqlite3.Connection, *, manager_id: str, tmux_pane_id: str | None) -> None:
    if tmux_pane_id is None:
        return
    conn.execute(
        "update managers set tmux_pane_id = ? where id = ?",
        (tmux_pane_id, manager_id),
    )


def mark_manager_seen(
    conn: sqlite3.Connection,
    *,
    manager_id: str,
    last_capture_sha256: str | None = None,
    timestamp: str | None = None,
) -> None:
    conn.execute(
        """
        update managers
        set last_seen_at = ?,
            last_capture_sha256 = coalesce(?, last_capture_sha256)
        where id = ?
        """,
        (timestamp or now_iso(), last_capture_sha256, manager_id),
    )


def latest_manager_prompt(conn: sqlite3.Connection, *, task_id: str) -> sqlite3.Row:
    row = conn.execute(
        """
        select content, artifact_path
        from prompts
        where task_id = ? and kind = 'manager'
        order by id desc
        limit 1
        """,
        (task_id,),
    ).fetchone()
    if row is None:
        raise WorkerError("No manager prompt has been recorded for this task")
    return row


def set_manager_state(
    conn: sqlite3.Connection,
    *,
    manager_id: str,
    state: str,
    timestamp: str | None = None,
    exit_reason: str | None = None,
) -> None:
    now = timestamp or now_iso()
    stopped_at = now if state in {"stopped", "missing", "failed"} else None
    conn.execute(
        """
        update managers
        set state = ?, stopped_at = coalesce(?, stopped_at),
            exit_detected_at = case when ? in ('missing', 'failed') then ? else exit_detected_at end,
            exit_reason = coalesce(?, exit_reason)
        where id = ?
        """,
        (state, stopped_at, state, now, exit_reason, manager_id),
    )


def set_task_state(conn: sqlite3.Connection, *, task_id: str, state: str, timestamp: str | None = None) -> None:
    conn.execute(
        "update tasks set state = ?, updated_at = ? where id = ?",
        (state, timestamp or now_iso(), task_id),
    )


def attach_manager_to_binding(
    conn: sqlite3.Connection,
    *,
    task_id: str,
    manager_id: str,
) -> None:
    conn.execute(
        """
        update bindings
        set manager_id = ?
        where task_id = ? and state in ('active', 'ending')
        """,
        (manager_id, task_id),
    )


def end_active_binding(
    conn: sqlite3.Connection,
    *,
    task_id: str,
    timestamp: str | None = None,
) -> None:
    conn.execute(
        """
        update bindings
        set state = 'ended', ended_at = ?
        where task_id = ? and state in ('active', 'ending')
        """,
        (timestamp or now_iso(), task_id),
    )


def list_tasks(conn: sqlite3.Connection, *, active_only: bool = False) -> list[dict[str, Any]]:
    where = "where tasks.state in ('candidate', 'managed', 'paused')" if active_only else ""
    rows = conn.execute(
        f"""
        select tasks.id, tasks.name, tasks.goal, tasks.summary, tasks.state,
               tasks.created_at, tasks.updated_at,
               budgets.max_nudges, budgets.nudges_used, budgets.expires_at
        from tasks
        left join budgets on budgets.task_id = tasks.id
        {where}
        order by tasks.created_at, tasks.id
        """
    ).fetchall()
    tasks: list[dict[str, Any]] = []
    for row in rows:
        task = {
            "created_at": row["created_at"],
            "goal": row["goal"],
            "id": row["id"],
            "name": row["name"],
            "state": row["state"],
            "summary": row["summary"],
            "updated_at": row["updated_at"],
        }
        if row["max_nudges"] is not None:
            task["budget"] = {
                "expires_at": row["expires_at"],
                "max_nudges": row["max_nudges"],
                "nudges_remaining": row["max_nudges"] - row["nudges_used"],
                "nudges_used": row["nudges_used"],
            }
        else:
            task["budget"] = None
        tasks.append(task)
    return tasks


def bind_task_worker(
    conn: sqlite3.Connection,
    *,
    task: str,
    worker: str,
    binding_id: str | None = None,
    timestamp: str | None = None,
) -> str:
    task_row = conn.execute(
        "select id, name, state from tasks where id = ? or name = ? order by created_at desc limit 1",
        (task, task),
    ).fetchone()
    if task_row is None:
        raise WorkerError(f"Unknown task: {task}")
    if task_row["state"] not in {"candidate", "paused"}:
        raise WorkerError(f"Task {task_row['name']} is not bindable in state {task_row['state']}")

    worker_row = conn.execute("select id, name from workers where name = ? or id = ?", (worker, worker)).fetchone()
    if worker_row is None:
        raise WorkerError(f"Unknown worker: {worker}")

    active_task_binding = conn.execute(
        """
        select id from bindings
        where task_id = ? and state in ('active', 'ending')
        """,
        (task_row["id"],),
    ).fetchone()
    if active_task_binding is not None:
        raise WorkerError(f"Task {task_row['name']} already has an active binding")

    active_worker_binding = conn.execute(
        """
        select id from bindings
        where worker_id = ? and state in ('active', 'ending')
        """,
        (worker_row["id"],),
    ).fetchone()
    if active_worker_binding is not None:
        raise WorkerError(f"Worker {worker_row['name']} already has an active binding")

    new_binding_id = binding_id or f"binding-{uuid.uuid4()}"
    now = timestamp or now_iso()
    conn.execute(
        """
        insert into bindings(id, task_id, worker_id, state, created_at)
        values (?, ?, ?, 'active', ?)
        """,
        (new_binding_id, task_row["id"], worker_row["id"], now),
    )
    conn.execute(
        """
        update tasks
        set state = 'managed', updated_at = ?
        where id = ?
        """,
        (now, task_row["id"]),
    )
    insert_event(
        conn,
        "worker_bound",
        actor="workerctl",
        task_id=task_row["id"],
        worker_id=worker_row["id"],
        payload={
            "binding_id": new_binding_id,
            "task": task_row["name"],
            "worker": worker_row["name"],
        },
    )
    return new_binding_id


def bind_sessions(
    conn: sqlite3.Connection,
    *,
    task_name: str,
    worker_session_name: str,
    manager_session_name: str,
    timestamp: str | None = None,
) -> str:
    """Create an active binding between a task and a (worker, manager) session pair.

    Uses the new `worker_session_id` / `manager_session_id` columns. Raises WorkerError
    on missing task/session, role mismatch, or pre-existing active binding for the task.
    """
    now = timestamp or now_iso()
    task = task_row(conn, task=task_name)
    worker_sess = session_row(conn, name=worker_session_name, role="worker")
    manager_sess = session_row(conn, name=manager_session_name, role="manager")

    existing = conn.execute(
        "select id from bindings where task_id = ? and state in ('active','ending')",
        (task["id"],),
    ).fetchone()
    if existing is not None:
        raise WorkerError(
            f"task {task_name!r} already has an active binding {existing['id']!r}"
        )

    for label, session_record in (("worker", worker_sess), ("manager", manager_sess)):
        already_bound = conn.execute(
            """
            select id, task_id from bindings
            where state in ('active','ending')
              and (worker_session_id = ? or manager_session_id = ?)
            limit 1
            """,
            (session_record["id"], session_record["id"]),
        ).fetchone()
        if already_bound is not None:
            raise WorkerError(
                f"{label} session {session_record['name']!r} is already bound to task "
                f"{already_bound['task_id']!r} (binding {already_bound['id']!r})"
            )

    binding_id = f"binding-{uuid.uuid4()}"
    conn.execute(
        """
        insert into bindings(
          id, task_id, worker_session_id, manager_session_id, state, created_at
        )
        values (?, ?, ?, ?, 'active', ?)
        """,
        (binding_id, task["id"], worker_sess["id"], manager_sess["id"], now),
    )
    return binding_id


def unbind_task(
    conn: sqlite3.Connection,
    *,
    task_name: str,
    timestamp: str | None = None,
) -> None:
    """End the active binding for `task_name`. Raises WorkerError if no active binding."""
    now = timestamp or now_iso()
    task = task_row(conn, task=task_name)
    cursor = conn.execute(
        "update bindings set state='ended', ended_at=? "
        "where task_id=? and state in ('active','ending')",
        (now, task["id"]),
    )
    if cursor.rowcount == 0:
        raise WorkerError(f"no active binding for task {task_name!r}")


def active_binding_for_task(
    conn: sqlite3.Connection,
    *,
    task_name: str,
) -> dict[str, Any]:
    """Return the active (or ending) binding for `task_name` with session names resolved.

    Returns a dict with keys:
      - `binding_id`: str
      - `task_id`: str
      - `worker_session_id`: str
      - `manager_session_id`: str
      - `worker_session_name`: str
      - `manager_session_name`: str
      - `state`: str ('active' | 'ending')
      - `created_at`: str

    Raises WorkerError if the task is unknown or has no active binding. Only resolves
    session-id-based bindings (Phase 1+); legacy worker_id/manager_id bindings are
    NOT returned here (they remain accessible via active_task_worker).
    """
    task = task_row(conn, task=task_name)
    row = conn.execute(
        """
        select
          b.id as binding_id,
          b.task_id as task_id,
          b.worker_session_id as worker_session_id,
          b.manager_session_id as manager_session_id,
          ws.name as worker_session_name,
          ms.name as manager_session_name,
          b.state as state,
          b.created_at as created_at
        from bindings b
        join sessions ws on ws.id = b.worker_session_id
        join sessions ms on ms.id = b.manager_session_id
        where b.task_id = ?
          and b.state in ('active', 'ending')
        order by b.created_at desc
        limit 1
        """,
        (task["id"],),
    ).fetchone()
    if row is None:
        raise WorkerError(f"no active session-based binding for task {task_name!r}")
    return dict(row)


def latest_session_binding_for_task(
    conn: sqlite3.Connection,
    *,
    task_name: str,
) -> dict[str, Any]:
    """Return the latest session-based binding for a task, including ended bindings."""
    task = task_row(conn, task=task_name)
    row = conn.execute(
        """
        select
          b.id as binding_id,
          b.task_id as task_id,
          b.worker_session_id as worker_session_id,
          b.manager_session_id as manager_session_id,
          ws.name as worker_session_name,
          ms.name as manager_session_name,
          b.state as state,
          b.created_at as created_at,
          b.ended_at as ended_at
        from bindings b
        join sessions ws on ws.id = b.worker_session_id
        join sessions ms on ms.id = b.manager_session_id
        where b.task_id = ?
          and b.worker_session_id is not null
          and b.manager_session_id is not null
        order by b.created_at desc
        limit 1
        """,
        (task["id"],),
    ).fetchone()
    if row is None:
        raise WorkerError(f"no session-based binding for task {task_name!r}")
    return dict(row)


def divergent_cycles_for_task(
    conn: sqlite3.Connection,
    *,
    task_name: str,
    limit: int = 50,
) -> list[dict[str, Any]]:
    """Return successful Phase 3 cycle rows where the shadow pane signal flagged
    a notable pattern (`notable_pane_pattern` is non-null in `status_json`).

    Returns a list of dicts with keys: `id`, `task_id`, `started_at`,
    `completed_at`, `state`, `notable_pane_pattern`, `status` (parsed status_json).
    Ordered newest-first, capped at `limit`.

    Raises WorkerError if `task_name` is unknown. Failed cycles are excluded
    (they don't carry a notable_pane_pattern field — see supervise_cycle.run_cycle).

    The SQL filter `state = 'succeeded'` is a redundant guardrail in case a
    future failure-payload shape adds `notable_pane_pattern` — the data-flow
    guarantee (failure_status omits the key) is the primary mechanism; this is
    belt-and-suspenders.
    """
    task = task_row(conn, task=task_name)
    rows = conn.execute(
        """
        select
          id, task_id, started_at, completed_at, state, status_json,
          json_extract(status_json, '$.notable_pane_pattern') as notable_pane_pattern
        from manager_cycles
        where task_id = ?
          and state = 'succeeded'
          and json_extract(status_json, '$.notable_pane_pattern') is not null
        order by id desc
        limit ?
        """,
        (task["id"], limit),
    ).fetchall()
    return [
        {
            "id": r["id"],
            "task_id": r["task_id"],
            "started_at": r["started_at"],
            "completed_at": r["completed_at"],
            "state": r["state"],
            "notable_pane_pattern": r["notable_pane_pattern"],
            "status": json.loads(r["status_json"]),
        }
        for r in rows
    ]


def active_task_worker(conn: sqlite3.Connection, *, task: str) -> dict[str, Any]:
    row = conn.execute(
        """
        select tasks.id as task_id, tasks.name as task_name, tasks.state as task_state,
               bindings.id as binding_id, bindings.state as binding_state,
               workers.id as worker_id, workers.name as worker_name,
               workers.tmux_session, workers.tmux_pane_id, workers.identity_token,
               workers.cwd, workers.state as worker_state
        from tasks
        left join bindings on bindings.task_id = tasks.id and bindings.state in ('active', 'ending')
        left join workers on workers.id = bindings.worker_id
        where tasks.id = ? or tasks.name = ?
        order by tasks.created_at desc
        limit 1
        """,
        (task, task),
    ).fetchone()
    if row is None:
        raise WorkerError(f"Unknown task: {task}")
    if row["worker_id"] is None:
        manager = active_manager(conn, task=row["task_id"])
        manager_state = manager["state"] if manager else None
        raise WorkerError(
            f"Task {row['task_name']} has no active worker binding "
            f"(task_state={row['task_state']}, manager_state={manager_state})"
        )
    return {
        "binding_id": row["binding_id"],
        "binding_state": row["binding_state"],
        "task_id": row["task_id"],
        "task_name": row["task_name"],
        "task_state": row["task_state"],
        "worker_cwd": row["cwd"],
        "worker_id": row["worker_id"],
        "worker_identity_token": row["identity_token"],
        "worker_name": row["worker_name"],
        "worker_state": row["worker_state"],
        "worker_tmux_pane_id": row["tmux_pane_id"],
        "worker_tmux_session": row["tmux_session"],
    }


def task_audit(conn: sqlite3.Connection, *, task: str) -> dict[str, Any]:
    task_row = conn.execute(
        """
        select id, name, goal, summary, state, created_at, updated_at
        from tasks
        where id = ? or name = ?
        order by created_at desc
        limit 1
        """,
        (task, task),
    ).fetchone()
    if task_row is None:
        raise WorkerError(f"Unknown task: {task}")

    event_rows = conn.execute(
        """
        select id, created_at, actor, command_id, correlation_id, task_id,
               worker_id, manager_id, type, payload_json
        from events
        where task_id = ?
        order by id
        """,
        (task_row["id"],),
    ).fetchall()
    command_rows = conn.execute(
        """
        select id, idempotency_key, created_at, updated_at, task_id, worker_id,
               manager_id, correlation_id, type, state, available_at, claimed_by,
               claimed_at, claim_expires_at, attempts, max_attempts, payload_json,
               required_permission, result_json, error
        from commands
        where task_id = ?
        order by created_at, id
        """,
        (task_row["id"],),
    ).fetchall()
    command_attempt_rows = conn.execute(
        """
        select command_attempts.id, command_attempts.command_id,
               command_attempts.correlation_id, command_attempts.dispatcher_id,
               command_attempts.started_at, command_attempts.finished_at,
               command_attempts.state, command_attempts.result_json,
               command_attempts.error, command_attempts.side_effect_started,
               command_attempts.side_effect_completed
        from command_attempts
        join commands on commands.id = command_attempts.command_id
        where commands.task_id = ?
        order by command_attempts.started_at, command_attempts.id
        """,
        (task_row["id"],),
    ).fetchall()
    routed_notification_rows = conn.execute(
        """
        select id, task_id, binding_id, correlation_id, source_session_id,
               target_session_id, signal_type, source_event_id, source_event_timestamp,
               dedupe_key, command_id, created_at, delivered_at, consumed_manager_cycle_id,
               consumed_at, state, claimed_by, claimed_at, claim_expires_at,
               side_effect_started, side_effect_completed, payload_json, error
        from routed_notifications
        where task_id = ?
        order by created_at, id
        """,
        (task_row["id"],),
    ).fetchall()
    capture_rows = conn.execute(
        """
        select id, task_id, worker_id, manager_id, role, tmux_session,
               tmux_pane_id, command_id, captured_at, history_lines,
               content_sha256, content, content_path, byte_count, line_count,
               classifier_json, source
        from terminal_captures
        where task_id = ?
        order by id
        """,
        (task_row["id"],),
    ).fetchall()
    segment_rows = conn.execute(
        """
        select id, task_id, role, source_capture_id, previous_capture_id,
               captured_at, content_sha256, segment_text, segment_start_line,
               segment_end_line, byte_count, line_count, retention_class,
               segment_kind, redacted, created_at
        from transcript_segments
        where task_id = ?
        order by id
        """,
        (task_row["id"],),
    ).fetchall()
    observation_rows = conn.execute(
        """
        select id, task_id, worker_id, manager_id, role, observation_type,
               severity, source_capture_id, command_id, created_at, message,
               payload_json
        from agent_observations
        where task_id = ?
        order by id
        """,
        (task_row["id"],),
    ).fetchall()
    cycle_rows = conn.execute(
        """
        select id, task_id, manager_id, started_at, completed_at, state,
               health_observation_id, manager_capture_id, worker_capture_id,
               status_json, health_json, decision, error
        from manager_cycles
        where task_id = ?
        order by id
        """,
        (task_row["id"],),
    ).fetchall()
    span_rows = conn.execute(
        """
        select id, manager_cycle_id, task_id, run_id, phase, started_at,
               completed_at, duration_ms, state, attributes_json, error_type,
               manager_decision_id, command_id
        from manager_cycle_spans
        where task_id = ?
        order by manager_cycle_id, id
        """,
        (task_row["id"],),
    ).fetchall()
    decision_rows = conn.execute(
        """
        select id, task_id, manager_id, manager_cycle_id, decision, reason,
               created_at, payload_json
        from manager_decisions
        where task_id = ?
        order by id
        """,
        (task_row["id"],),
    ).fetchall()
    acknowledgement_rows = conn.execute(
        """
        select id, task_id, binding_id, role, payload_json, revision,
               manager_config_revision, created_at, correlation_id
        from task_acknowledgements
        where task_id = ?
        order by created_at, id
        """,
        (task_row["id"],),
    ).fetchall()
    continuation_rows = task_continuations(conn, task_id=task_row["id"])
    continuation_review_rows = continuation_reviews(conn, task_id=task_row["id"])
    epilogue_rows = epilogue_runs(conn, task_id=task_row["id"])
    criteria = acceptance_criteria_for_task(conn, task_id=task_row["id"])
    command_records = [_command_record(row) for row in command_rows]
    command_attempt_records = [_command_attempt_record(row) for row in command_attempt_rows]
    routed_notification_records = [_routed_notification_record(row) for row in routed_notification_rows]
    manager_cycle_records = [
        {
            "completed_at": row["completed_at"],
            "decision": row["decision"],
            "error": row["error"],
            "health": json.loads(row["health_json"]) if row["health_json"] else None,
            "health_observation_id": row["health_observation_id"],
            "id": row["id"],
            "manager_capture_id": row["manager_capture_id"],
            "manager_id": row["manager_id"],
            "started_at": row["started_at"],
            "state": row["state"],
            "status": json.loads(row["status_json"]) if row["status_json"] else None,
            "task_id": row["task_id"],
            "worker_capture_id": row["worker_capture_id"],
        }
        for row in cycle_rows
    ]
    manager_cycle_span_records = [_manager_cycle_span_from_row(row) for row in span_rows]
    manager_decision_records = [
        {
            "created_at": row["created_at"],
            "decision": row["decision"],
            "id": row["id"],
            "manager_cycle_id": row["manager_cycle_id"],
            "manager_id": row["manager_id"],
            "payload": json.loads(row["payload_json"]),
            "reason": row["reason"],
            "task_id": row["task_id"],
        }
        for row in decision_rows
    ]
    return {
        "acceptance_criteria": criteria,
        "continuation_reviews": continuation_review_rows,
        "task_continuations": continuation_rows,
        "epilogue_runs": epilogue_rows,
        "task_acknowledgements": [
            {
                "binding_id": row["binding_id"],
                "correlation_id": row["correlation_id"],
                "created_at": row["created_at"],
                "id": row["id"],
                "manager_config_revision": row["manager_config_revision"],
                "payload": json.loads(row["payload_json"]),
                "revision": row["revision"],
                "role": row["role"],
                "task_id": row["task_id"],
            }
            for row in acknowledgement_rows
        ],
        "commands": command_records,
        "command_attempts": command_attempt_records,
        "correlation_chains": _build_correlation_chains(
            commands=command_records,
            command_attempts=command_attempt_records,
            routed_notifications=routed_notification_records,
            manager_decisions=manager_decision_records,
            manager_cycles=manager_cycle_records,
        ),
        "agent_observations": [
            {
                "command_id": row["command_id"],
                "created_at": row["created_at"],
                "id": row["id"],
                "manager_id": row["manager_id"],
                "message": row["message"],
                "observation_type": row["observation_type"],
                "payload": json.loads(row["payload_json"]),
                "role": row["role"],
                "severity": row["severity"],
                "source_capture_id": row["source_capture_id"],
                "task_id": row["task_id"],
                "worker_id": row["worker_id"],
            }
            for row in observation_rows
        ],
        "events": [
            {
                "actor": row["actor"],
                "command_id": row["command_id"],
                "correlation_id": row["correlation_id"],
                "created_at": row["created_at"],
                "id": row["id"],
                "manager_id": row["manager_id"],
                "payload": json.loads(row["payload_json"]),
                "task_id": row["task_id"],
                "type": row["type"],
                "worker_id": row["worker_id"],
            }
            for row in event_rows
        ],
        "manager_cycles": manager_cycle_records,
        "manager_cycle_spans": manager_cycle_span_records,
        "manager_decisions": manager_decision_records,
        "routed_notifications": routed_notification_records,
        "task": {
            "created_at": task_row["created_at"],
            "goal": task_row["goal"],
            "id": task_row["id"],
            "name": task_row["name"],
            "state": task_row["state"],
            "summary": task_row["summary"],
            "updated_at": task_row["updated_at"],
        },
        "terminal_captures": [
            {
                "byte_count": row["byte_count"],
                "captured_at": row["captured_at"],
                "classifier": json.loads(row["classifier_json"]),
                "command_id": row["command_id"],
                "content": row["content"],
                "content_path": row["content_path"],
                "content_sha256": row["content_sha256"],
                "history_lines": row["history_lines"],
                "id": row["id"],
                "line_count": row["line_count"],
                "manager_id": row["manager_id"],
                "role": row["role"],
                "source": row["source"],
                "task_id": row["task_id"],
                "tmux_pane_id": row["tmux_pane_id"],
                "tmux_session": row["tmux_session"],
                "worker_id": row["worker_id"],
            }
            for row in capture_rows
        ],
        "transcript_segments": [
            {
                "byte_count": row["byte_count"],
                "captured_at": row["captured_at"],
                "content_sha256": row["content_sha256"],
                "created_at": row["created_at"],
                "id": row["id"],
                "line_count": row["line_count"],
                "previous_capture_id": row["previous_capture_id"],
                "redacted": bool(row["redacted"]),
                "retention_class": row["retention_class"],
                "role": row["role"],
                "segment_end_line": row["segment_end_line"],
                "segment_kind": row["segment_kind"],
                "segment_start_line": row["segment_start_line"],
                "segment_text": row["segment_text"],
                "source_capture_id": row["source_capture_id"],
                "task_id": row["task_id"],
            }
            for row in segment_rows
        ],
    }


def task_status_snapshot(conn: sqlite3.Connection, *, task: str) -> dict[str, Any]:
    task_row = conn.execute(
        """
        select tasks.id, tasks.name, tasks.goal, tasks.summary, tasks.state,
               tasks.created_at, tasks.updated_at,
               budgets.max_nudges, budgets.nudges_used, budgets.expires_at
        from tasks
        left join budgets on budgets.task_id = tasks.id
        where tasks.id = ? or tasks.name = ?
        order by tasks.created_at desc
        limit 1
        """,
        (task, task),
    ).fetchone()
    if task_row is None:
        raise WorkerError(f"Unknown task: {task}")

    binding_row = conn.execute(
        """
        select bindings.id, bindings.state, bindings.created_at,
               workers.id as worker_id, workers.name as worker_name,
               workers.tmux_session, workers.tmux_pane_id, workers.state as worker_state,
               workers.cwd
        from bindings
        join workers on workers.id = bindings.worker_id
        where bindings.task_id = ? and bindings.state in ('active', 'ending')
        order by bindings.created_at desc
        limit 1
        """,
        (task_row["id"],),
    ).fetchone()

    worker = None
    latest_status = None
    if binding_row is not None:
        worker = {
            "binding_id": binding_row["id"],
            "binding_state": binding_row["state"],
            "cwd": binding_row["cwd"],
            "id": binding_row["worker_id"],
            "name": binding_row["worker_name"],
            "state": binding_row["worker_state"],
            "tmux_pane_id": binding_row["tmux_pane_id"],
            "tmux_session": binding_row["tmux_session"],
        }
        status_row = conn.execute(
            """
            select state, current_task, next_action, blocker, created_at
            from statuses
            where worker_id = ?
            order by id desc
            limit 1
            """,
            (binding_row["worker_id"],),
        ).fetchone()
        if status_row is not None:
            latest_status = {
                "blocker": status_row["blocker"],
                "current_task": status_row["current_task"],
                "last_update": status_row["created_at"],
                "next_action": status_row["next_action"],
                "state": status_row["state"],
            }

    budget = None
    if task_row["max_nudges"] is not None:
        budget = {
            "expires_at": task_row["expires_at"],
            "max_nudges": task_row["max_nudges"],
            "nudges_remaining": task_row["max_nudges"] - task_row["nudges_used"],
            "nudges_used": task_row["nudges_used"],
        }

    manager = active_manager(conn, task=task_row["id"])
    handoff = latest_worker_handoff(conn, task_id=task_row["id"])
    config = manager_config(conn, task_id=task_row["id"])
    integrity_issues = []
    if task_row["state"] == "managed" and worker is None:
        integrity_issues.append("managed_without_active_worker_binding")
    if task_row["state"] == "managed" and manager is None:
        integrity_issues.append("managed_without_active_manager")
    if task_row["state"] == "failed" and manager is not None:
        integrity_issues.append("closed_task_has_active_manager")

    return {
        "budget": budget,
        "created_at": task_row["created_at"],
        "goal": task_row["goal"],
        "id": task_row["id"],
        "name": task_row["name"],
        "state": task_row["state"],
        "summary": task_row["summary"],
        "updated_at": task_row["updated_at"],
        "integrity": {
            "issues": integrity_issues,
            "ok": not integrity_issues,
        },
        "manager": manager,
        "manager_config": config,
        "worker": worker,
        "worker_handoff": handoff,
        "worker_status": latest_status,
    }


def mark_worker_state(conn: sqlite3.Connection, *, name: str, state: str, timestamp: str | None = None) -> None:
    conn.execute(
        """
        update workers
        set state = ?, updated_at = ?
        where name = ?
        """,
        (state, timestamp or now_iso(), name),
    )
