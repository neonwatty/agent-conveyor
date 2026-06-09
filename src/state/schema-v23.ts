// Generated from the archived Agent Conveyor v24 database schema.
// Regenerate deliberately when SCHEMA_VERSION changes.
export const SCHEMA_V23_SQL = String.raw`
CREATE TABLE acceptance_criteria(
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

CREATE TABLE agent_observations(
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

CREATE TABLE bindings(
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

CREATE TABLE budgets(
          task_id text primary key references tasks(id),
          max_nudges integer not null check (max_nudges >= 0),
          nudges_used integer not null default 0 check (nudges_used >= 0),
          expires_at text not null,
          check (nudges_used <= max_nudges)
        );

CREATE TABLE codex_events(
          id integer primary key autoincrement,
          session_id text not null references sessions(id),
          timestamp text not null,
          type text not null,
          subtype text,
          payload_json text not null check (json_valid(payload_json)),
          byte_offset integer not null,
          ingested_at text not null
        );

CREATE TABLE command_attempts(
          id integer primary key autoincrement,
          command_id text not null references commands(id),
          correlation_id text not null,
          dispatcher_id text not null,
          started_at text not null,
          finished_at text,
          state text not null check (state in ('running','succeeded','failed','abandoned','blocked')),
          result_json text check (result_json is null or json_valid(result_json)),
          error text,
          side_effect_started integer not null default 0 check (side_effect_started in (0, 1)),
          side_effect_completed integer not null default 0 check (side_effect_completed in (0, 1))
        );

CREATE TABLE commands(
          id text primary key,
          idempotency_key text unique not null,
          created_at text not null,
          updated_at text not null,
          task_id text references tasks(id),
          worker_id text references workers(id),
          manager_id text references managers(id),
          correlation_id text,
          type text not null,
          state text not null check (state in ('pending','attempted','succeeded','failed','blocked')),
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

CREATE TABLE continuation_reviews(
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

CREATE TABLE data_migrations(
          name text primary key,
          source_path text not null,
          source_hash text not null,
          applied_at text not null
        );

CREATE TABLE epilogue_runs(
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

CREATE TABLE events(
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

CREATE TABLE manager_configs(
          task_id text primary key references tasks(id),
          recipe_name text,
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

CREATE TABLE manager_cycle_spans(
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

CREATE TABLE manager_cycles(
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

CREATE TABLE manager_decisions(
          id integer primary key autoincrement,
          task_id text not null references tasks(id),
          manager_id text references managers(id),
          manager_cycle_id integer references manager_cycles(id),
          decision text not null check (decision in ('wait','nudge','interrupt','escalate','stop','inspect')),
          reason text not null,
          created_at text not null,
          payload_json text not null check (json_valid(payload_json))
        );

CREATE TABLE managers(
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

CREATE TABLE prompts(
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

CREATE TABLE routed_notifications(
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
          consumed_by_session_id text references sessions(id),
          consumed_at text,
          delivery_mode text not null default 'push' check (delivery_mode in ('push','pull_required')),
          state text not null check (state in ('pending','delivered','failed','suppressed')),
          claimed_by text,
          claimed_at text,
          claim_expires_at text,
          side_effect_started integer not null default 0 check (side_effect_started in (0, 1)),
          side_effect_completed integer not null default 0 check (side_effect_completed in (0, 1)),
          payload_json text not null check (json_valid(payload_json)),
          error text
        );

CREATE TABLE runs(
          id text primary key,
          task_id text not null references tasks(id),
          name text not null,
          purpose text,
          status text not null check (status in ('active','finished','failed','abandoned')),
          started_at text not null,
          ended_at text,
          metadata_json text not null check (json_valid(metadata_json))
        );

CREATE TABLE schema_migrations(
          version integer primary key,
          applied_at text not null
        );

CREATE TABLE sessions(
          id text primary key,
          name text unique not null,
          role text not null check (role in ('worker','manager')),
          identity_token text unique not null,
          tmux_session text,
          tmux_pane_id text,
          codex_session_path text,
          codex_session_id text,
          codex_app_thread_id text,
          codex_app_thread_title text,
          pid integer,
          cwd text not null,
          registered_at text not null,
          last_heartbeat_at text,
          state text not null check (state in ('active','gone'))
        , last_ingest_offset integer);

CREATE TABLE statuses(
          id integer primary key autoincrement,
          worker_id text not null references workers(id),
          state text not null check (state in ('planning','editing','running_tests','blocked','waiting','done','unknown')),
          current_task text,
          next_action text,
          blocker text,
          created_at text not null
        );

CREATE TABLE task_acknowledgements(
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

CREATE TABLE task_continuations(
          id integer primary key autoincrement,
          task_id text not null references tasks(id),
          proposer text not null check (proposer in ('worker','manager')),
          payload_json text not null check (json_valid(payload_json)),
          revision integer not null check (revision > 0),
          created_at text not null,
          correlation_id text not null
        );

CREATE TABLE tasks(
          id text primary key,
          name text not null,
          goal text not null,
          summary text,
          state text not null check (state in ('candidate','managed','paused','done','failed')),
          created_at text not null,
          updated_at text not null
        );

CREATE TABLE telemetry_events(
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

CREATE VIRTUAL TABLE telemetry_events_fts using fts5(
          event_id unindexed,
          task_id unindexed,
          run_id unindexed,
          actor unindexed,
          event_type unindexed,
          summary,
          attributes
        );

CREATE TABLE terminal_captures(
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

CREATE TABLE transcript_captures(
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

CREATE TABLE transcript_segments(
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

CREATE TABLE worker_handoffs(
          id integer primary key autoincrement,
          task_id text not null references tasks(id),
          worker_session_id text references sessions(id),
          summary text not null,
          next_steps_json text not null check (json_valid(next_steps_json)),
          payload_json text not null check (json_valid(payload_json)),
          created_at text not null
        );

CREATE TABLE workers(
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

CREATE UNIQUE INDEX acceptance_criteria_task_source_criterion
        on acceptance_criteria(task_id, source, criterion);

CREATE INDEX acceptance_criteria_task_status
        on acceptance_criteria(task_id, status, id);

CREATE INDEX agent_observations_task_id
        on agent_observations(task_id, id);

CREATE INDEX codex_events_session_id
        on codex_events(session_id, id);

CREATE INDEX command_attempts_command_id
        on command_attempts(command_id, id);

CREATE INDEX command_attempts_correlation_id
        on command_attempts(correlation_id);

CREATE INDEX commands_claimable
        on commands(state, type, available_at, created_at, id);

CREATE INDEX commands_task_state_created
        on commands(task_id, state, created_at);

CREATE INDEX continuation_reviews_task
        on continuation_reviews(task_id, id);

CREATE INDEX epilogue_runs_task_step
        on epilogue_runs(task_id, step_name, id);

CREATE INDEX events_task_id
        on events(task_id, id);

CREATE INDEX manager_configs_task_id
        on manager_configs(task_id);

CREATE INDEX manager_cycle_spans_cycle_phase
        on manager_cycle_spans(manager_cycle_id, phase, id);

CREATE INDEX manager_cycle_spans_task
        on manager_cycle_spans(task_id, id);

CREATE UNIQUE INDEX one_active_binding_per_manager_session
        on bindings(manager_session_id) where state in ('active', 'ending');

CREATE UNIQUE INDEX one_active_binding_per_task
        on bindings(task_id)
        where state in ('active', 'ending');

CREATE UNIQUE INDEX one_active_binding_per_worker
        on bindings(worker_id)
        where state in ('active', 'ending');

CREATE UNIQUE INDEX one_active_binding_per_worker_session
        on bindings(worker_session_id) where state in ('active', 'ending');

CREATE UNIQUE INDEX one_active_manager_per_task
        on managers(task_id)
        where state in ('starting', 'ready', 'stopping');

CREATE UNIQUE INDEX one_active_run_per_task
        on runs(task_id)
        where status = 'active';

CREATE INDEX routed_notifications_claimable
        on routed_notifications(state, signal_type, side_effect_started, claim_expires_at, created_at);

CREATE INDEX routed_notifications_consumed_cycle
        on routed_notifications(consumed_manager_cycle_id);

CREATE UNIQUE INDEX routed_notifications_dedupe_key
        on routed_notifications(dedupe_key);

CREATE INDEX routed_notifications_source_event
        on routed_notifications(source_event_id);

CREATE INDEX routed_notifications_target_inbox
        on routed_notifications(target_session_id, consumed_at, state, created_at, id);

CREATE INDEX runs_task_status
        on runs(task_id, status, started_at);

CREATE INDEX statuses_worker_id
        on statuses(worker_id, id);

CREATE INDEX task_acknowledgements_task_role_revision
        on task_acknowledgements(task_id, role, revision desc, id desc);

CREATE INDEX task_continuations_task_role_revision
        on task_continuations(task_id, proposer, revision desc, id desc);

CREATE INDEX telemetry_events_actor_timestamp
        on telemetry_events(actor, timestamp, id);

CREATE INDEX telemetry_events_run_timestamp
        on telemetry_events(run_id, timestamp, id);

CREATE INDEX telemetry_events_task_timestamp
        on telemetry_events(task_id, timestamp, id);

CREATE INDEX telemetry_events_type_timestamp
        on telemetry_events(event_type, timestamp, id);

CREATE INDEX terminal_captures_task_role
        on terminal_captures(task_id, role, id);

CREATE INDEX transcript_captures_worker_id
        on transcript_captures(worker_id, id);

CREATE INDEX transcript_segments_task_role
        on transcript_segments(task_id, role, id);

CREATE INDEX worker_handoffs_task_id
        on worker_handoffs(task_id, id);

CREATE TRIGGER events_no_delete
        before delete on events
        begin
          select raise(abort, 'events are append-only');
        end;

CREATE TRIGGER events_no_update
        before update on events
        begin
          select raise(abort, 'events are append-only');
        end;
`;
