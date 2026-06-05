import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { DatabaseSync } from "node:sqlite";

import { runTypescriptRuntimeCommand } from "./typescript-runtime.js";
import type { TmuxRunner } from "../runtime/tmux.js";
import {
  claimNextDispatchCommandSync,
  createCommandSync,
} from "../runtime/commands.js";
import { executeDispatchCommandSync } from "../runtime/dispatch.js";
import { recordLoopEvidenceSync } from "../runtime/loop-evidence.js";
import {
  bindSessionsSync,
  createTaskSync,
} from "../runtime/tasks.js";
import {
  initializeDatabaseSync,
  openDatabaseSync,
} from "../state/database.js";
import {
  configPath,
  defaultDbPath,
  eventsPath,
  statusPath,
  transcriptPath,
  workerDir,
} from "../state/files.js";

test("unmigrated TypeScript runtime command falls back when disabled", () => {
  assert.deepEqual(
    runTypescriptRuntimeCommand({
      args: ["commands", "--json"],
      env: {},
    }),
    { exitCode: 0, handled: false },
  );
});

test("TypeScript runtime handles task create list and active filtering by default", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-ts-tasks."));
  try {
    const dbPath = join(root, "workerctl.db");
    const created = runTypescriptRuntimeCommand({
      args: [
        "tasks",
        "--path",
        dbPath,
        "--create",
        "auth-refactor",
        "--goal",
        "Finish auth refactor.",
        "--summary",
        "Middleware replaced.",
      ],
      env: {},
    });
    assert.equal(created.exitCode, 0);
    assert.equal(created.handled, true);
    const createdPayload = JSON.parse(created.stdout ?? "{}") as {
      created: boolean;
      id: string;
      name: string;
    };
    assert.equal(createdPayload.created, true);
    assert.match(createdPayload.id, /^task-/);
    assert.equal(createdPayload.name, "auth-refactor");

    const listed = runTypescriptRuntimeCommand({
      args: ["tasks", "--path", dbPath, "--json"],
      env: {},
    });
    assert.equal(listed.exitCode, 0);
    const tasks = JSON.parse(listed.stdout ?? "[]") as Array<{
      budget: null;
      goal: string;
      name: string;
      state: string;
      summary: string | null;
    }>;
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].budget, null);
    assert.equal(tasks[0].goal, "Finish auth refactor.");
    assert.equal(tasks[0].name, "auth-refactor");
    assert.equal(tasks[0].state, "candidate");
    assert.equal(tasks[0].summary, "Middleware replaced.");

    const text = runTypescriptRuntimeCommand({
      args: ["tasks", "--path", dbPath],
      env: {},
    });
    assert.equal(text.stdout, "auth-refactor\tcandidate\tFinish auth refactor.\n");

    const database = openDatabaseSync(dbPath);
    try {
      database.prepare("update tasks set state = 'done' where name = ?").run("auth-refactor");
    } finally {
      database.close();
    }

    const active = runTypescriptRuntimeCommand({
      args: ["tasks", "--path", dbPath, "--active", "--json"],
      env: {},
    });
    assert.equal(active.stdout, "[]\n");

    const missingGoal = runTypescriptRuntimeCommand({
      args: ["tasks", "--path", dbPath, "--create", "missing-goal"],
      env: {},
    });
    assert.equal(missingGoal.exitCode, 2);
    assert.match(missingGoal.stderr ?? "", /--goal is required with tasks --create/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("TypeScript runtime handles bind and unbind by default", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-ts-bind."));
  try {
    mkdirSync(join(root, ".codex-workers"));
    const dbPath = defaultDbPath({ cwd: root, env: {} });
    const database = openDatabaseSync(dbPath);
    try {
      initializeDatabaseSync(database);
      createTaskSync(database, {
        goal: "Bind worker and manager.",
        name: "bind-task",
        now: "2026-05-23T11:00:00Z",
        taskId: "task-bind",
      });
      insertSession(database, { id: "session-worker-bind", name: "worker-bind", role: "worker" });
      insertSession(database, { id: "session-manager-bind", name: "manager-bind", role: "manager" });
    } finally {
      database.close();
    }

    const bound = runTypescriptRuntimeCommand({
      args: [
        "bind",
        "--task",
        "bind-task",
        "--worker",
        "worker-bind",
        "--manager",
        "manager-bind",
      ],
      cwd: root,
      env: {},
    });
    assert.equal(bound.exitCode, 0);
    assert.equal(bound.handled, true);
    const boundPayload = JSON.parse(bound.stdout ?? "{}") as {
      binding_id: string;
      manager: string;
      task: string;
      worker: string;
    };
    assert.match(boundPayload.binding_id, /^binding-/);
    assert.equal(boundPayload.manager, "manager-bind");
    assert.equal(boundPayload.task, "bind-task");
    assert.equal(boundPayload.worker, "worker-bind");

    const afterBind = openDatabaseSync(dbPath);
    try {
      const binding = afterBind.prepare("select state, task_id, worker_session_id, manager_session_id from bindings where id = ?")
        .get(boundPayload.binding_id) as {
          manager_session_id: string | null;
          state: string;
          task_id: string;
          worker_session_id: string | null;
        };
      assert.equal(binding.state, "active");
      assert.equal(binding.task_id, "task-bind");
      assert.equal(binding.worker_session_id, "session-worker-bind");
      assert.equal(binding.manager_session_id, "session-manager-bind");
      const event = afterBind.prepare("select task_id, payload_json from events where type = 'binding_created'")
        .get() as { payload_json: string; task_id: string };
      assert.equal(event.task_id, "task-bind");
      assert.deepEqual(JSON.parse(event.payload_json), {
        binding_id: boundPayload.binding_id,
        manager: "manager-bind",
        task: "bind-task",
        worker: "worker-bind",
      });
    } finally {
      afterBind.close();
    }

    assert.deepEqual(
      runTypescriptRuntimeCommand({
        args: ["unbind", "--path", dbPath, "--task", "bind-task"],
        cwd: root,
        env: {},
      }),
      { exitCode: 0, handled: false },
    );

    const unbound = runTypescriptRuntimeCommand({
      args: ["unbind", "--task", "bind-task"],
      cwd: root,
      env: {},
    });
    assert.equal(unbound.exitCode, 0);
    assert.equal(unbound.handled, true);
    assert.equal(unbound.stdout, "{\"task\": \"bind-task\", \"state\": \"ended\"}\n");
    assert.deepEqual(JSON.parse(unbound.stdout), { state: "ended", task: "bind-task" });

    const afterUnbind = openDatabaseSync(dbPath);
    try {
      const binding = afterUnbind.prepare("select state, ended_at from bindings where id = ?")
        .get(boundPayload.binding_id) as { ended_at: string | null; state: string };
      assert.equal(binding.state, "ended");
      assert.ok(binding.ended_at);
      const event = afterUnbind.prepare("select task_id, payload_json from events where type = 'binding_ended'")
        .get() as { payload_json: string; task_id: string };
      assert.equal(event.task_id, "task-bind");
      assert.deepEqual(JSON.parse(event.payload_json), { task: "bind-task" });
    } finally {
      afterUnbind.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("TypeScript runtime handles no-tmux create-disposable-binding by default", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-ts-disposable."));
  try {
    const dbPath = join(root, "workerctl.db");
    const sessionDir = join(root, "sessions");
    const created = runTypescriptRuntimeCommand({
      args: [
        "create-disposable-binding",
        "real-slice",
        "--goal",
        "Run a real no-tmux Ralph loop.",
        "--worker",
        "real-worker",
        "--manager",
        "real-manager",
        "--run-name",
        "real-slice-run",
        "--required-before-continue",
        "adversarial_check",
        "--session-dir",
        sessionDir,
        "--path",
        dbPath,
        "--json",
      ],
      cwd: root,
      env: {},
    });
    assert.equal(created.exitCode, 0, created.stderr);
    assert.equal(created.handled, true);
    const payload = JSON.parse(created.stdout ?? "{}") as {
      binding: { id: string };
      manager: {
        communication: { delivery_mode: string; poll_command: string; receive_style: string; session_kind: string };
        name: string;
        rollout_path: string;
        tmux_session: string | null;
      };
      replay_commands: string[];
      run: {
        metadata: {
          current_iteration: number;
          max_iterations: number;
          policy_record: boolean;
          required_before_continue: string[];
        };
        name: string;
        purpose: string;
        status: string;
      };
      task: { created: boolean; id: string; name: string; state: string };
      worker: {
        communication: { delivery_mode: string; poll_command: string; receive_style: string; session_kind: string };
        name: string;
        rollout_path: string;
        tmux_session: string | null;
      };
      worker_handoff: string;
    };
    assert.equal(payload.task.name, "real-slice");
    assert.equal(payload.task.created, true);
    assert.equal(payload.task.state, "managed");
    assert.equal(payload.worker.name, "real-worker");
    assert.equal(payload.manager.name, "real-manager");
    assert.equal(payload.worker.tmux_session, null);
    assert.equal(payload.manager.tmux_session, null);
    assert.equal(payload.worker.communication.session_kind, "codex_app");
    assert.equal(payload.manager.communication.session_kind, "codex_app");
    assert.equal(payload.worker.communication.receive_style, "pull");
    assert.equal(payload.manager.communication.receive_style, "pull");
    assert.equal(payload.worker.communication.delivery_mode, "pull_required");
    assert.equal(payload.manager.communication.delivery_mode, "pull_required");
    const quotedDbPath = `'${dbPath.replace(/'/g, "'\"'\"'")}'`;
    assert.equal(
      payload.worker.communication.poll_command,
      `conveyor worker-inbox 'real-slice' --consume-next --wait --timeout 60 --path ${quotedDbPath} --json`,
    );
    assert.equal(
      payload.manager.communication.poll_command,
      `conveyor manager-inbox 'real-slice' --consume-next --wait --timeout 60 --path ${quotedDbPath} --json`,
    );
    assert.equal(payload.run.name, "real-slice-run");
    assert.equal(payload.run.purpose, "ralph_loop");
    assert.equal(payload.run.status, "finished");
    assert.deepEqual(payload.run.metadata.required_before_continue, ["adversarial_check"]);
    assert.equal(payload.run.metadata.max_iterations, 2);
    assert.equal(payload.run.metadata.current_iteration, 1);
    assert.equal(payload.run.metadata.policy_record, true);
    assert.ok(payload.replay_commands.some((command) => command.includes("enqueue-continue-iteration")));
    assert.ok(payload.replay_commands.some((command) => command.includes("worker-inbox")));
    assert.ok(payload.replay_commands.some((command) => command.includes("loop-status")));
    assert.ok(payload.worker_handoff.includes("Keep polling your Conveyor worker inbox"));
    assert.ok(payload.worker_handoff.includes(payload.worker.communication.poll_command));

    for (const key of ["worker", "manager"] as const) {
      const rolloutLine = JSON.parse(readFileSync(payload[key].rollout_path, "utf8").split(/\r?\n/)[0] ?? "{}") as {
        payload: { cwd: string; id: string };
        type: string;
      };
      assert.equal(rolloutLine.type, "session_meta");
      assert.equal(rolloutLine.payload.cwd, root);
      assert.match(rolloutLine.payload.id, /^codex-real-/);
    }

    const database = openDatabaseSync(dbPath);
    try {
      const task = database.prepare("select id, name, goal, state from tasks where name = ?")
        .get("real-slice") as { goal: string; id: string; name: string; state: string };
      assert.equal(task.id, payload.task.id);
      assert.equal(task.goal, "Run a real no-tmux Ralph loop.");
      assert.equal(task.state, "managed");
      const sessions = database.prepare("select name, role, tmux_session, state from sessions order by role")
        .all() as Array<{ name: string; role: string; state: string; tmux_session: string | null }>;
      assert.deepEqual(sessions.map((session) => ({ ...session })), [
        { name: "real-manager", role: "manager", state: "active", tmux_session: null },
        { name: "real-worker", role: "worker", state: "active", tmux_session: null },
      ]);
      const binding = database.prepare("select id, task_id, state from bindings")
        .get() as { id: string; state: string; task_id: string };
      assert.equal(binding.id, payload.binding.id);
      assert.equal(binding.task_id, payload.task.id);
      assert.equal(binding.state, "active");
      const run = database.prepare("select name, purpose, status, metadata_json from runs")
        .get() as { metadata_json: string; name: string; purpose: string; status: string };
      assert.equal(run.name, "real-slice-run");
      assert.equal(run.purpose, "ralph_loop");
      assert.equal(run.status, "finished");
      const runMetadata = JSON.parse(run.metadata_json) as {
        policy_record: boolean;
        required_before_continue: string[];
      };
      assert.deepEqual(runMetadata.required_before_continue, ["adversarial_check"]);
      assert.equal(runMetadata.policy_record, true);
      const event = database.prepare("select task_id, payload_json from events where type = 'disposable_binding_created'")
        .get() as { payload_json: string; task_id: string };
      assert.equal(event.task_id, payload.task.id);
      assert.deepEqual(JSON.parse(event.payload_json), {
        binding_id: payload.binding.id,
        manager: "real-manager",
        run: "real-slice-run",
        worker: "real-worker",
      });
    } finally {
      database.close();
    }

    const templated = runTypescriptRuntimeCommand({
      args: [
        "create-disposable-binding",
        "templated-slice",
        "--worker",
        "templated-worker",
        "--manager",
        "templated-manager",
        "--template",
        "visual_diff_loop",
        "--max-iterations",
        "5",
        "--current-iteration",
        "2",
        "--seed-prompt-sha256",
        "seed-template",
        "--required-before-continue",
        "manual_review",
        "--run-name",
        "templated-run",
        "--path",
        dbPath,
        "--json",
      ],
      cwd: root,
      env: {},
    });
    assert.equal(templated.exitCode, 0, templated.stderr);
    assert.equal(templated.handled, true);
    const templatedPayload = JSON.parse(templated.stdout ?? "{}") as {
      replay_commands: string[];
      run: {
        metadata: {
          artifact_requirements: Record<string, unknown>;
          cleanup_policy: string;
          current_iteration: number;
          max_iterations: number;
          policy_record: boolean;
          recommended_tools: string[];
          required_before_continue: string[];
          seed_prompt_sha256: string;
          stop_conditions: string[];
          tags: string[];
          template: string;
        };
        name: string;
        status: string;
      };
    };
    assert.equal(templatedPayload.run.name, "templated-run");
    assert.equal(templatedPayload.run.status, "finished");
    assert.equal(templatedPayload.run.metadata.template, "visual_diff_loop");
    assert.equal(templatedPayload.run.metadata.max_iterations, 5);
    assert.equal(templatedPayload.run.metadata.current_iteration, 2);
    assert.equal(templatedPayload.run.metadata.cleanup_policy, "compact");
    assert.equal(templatedPayload.run.metadata.seed_prompt_sha256, "seed-template");
    assert.equal(templatedPayload.run.metadata.policy_record, true);
    assert.deepEqual(templatedPayload.run.metadata.stop_conditions, [
      "max_iterations",
      "required_evidence",
      "manager_accepts",
    ]);
    assert.deepEqual(templatedPayload.run.metadata.required_before_continue, [
      "reference_artifact",
      "candidate_screenshot",
      "visual_diff_report",
      "diff_below_threshold",
      "adversarial_check",
      "manual_review",
    ]);
    assert.deepEqual(templatedPayload.run.metadata.recommended_tools, ["browser", "playwright", "pixelmatch"]);
    assert.deepEqual(templatedPayload.run.metadata.tags, ["visual", "frontend", "qa"]);
    assert.ok("visual_diff_report" in templatedPayload.run.metadata.artifact_requirements);
    assert.ok(templatedPayload.replay_commands[0].includes("--template"));
    assert.ok(templatedPayload.replay_commands[0].includes("visual_diff_loop"));
    const unknownTemplate = runTypescriptRuntimeCommand({
      args: ["create-disposable-binding", "unknown-template", "--template", "not_real", "--path", dbPath],
      cwd: root,
      env: {},
    });
    assert.equal(unknownTemplate.exitCode, 2);
    assert.match(unknownTemplate.stderr ?? "", /Unknown loop template: not_real/);
    const partialTask = openDatabaseSync(dbPath);
    try {
      const row = partialTask.prepare("select id from tasks where name = 'unknown-template'").get();
      assert.equal(row, undefined);
    } finally {
      partialTask.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("TypeScript runtime handles state-only finish-task and stop-task by default", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-ts-lifecycle."));
  try {
    const dbPath = join(root, "workerctl.db");
    const finishCreated = runTypescriptRuntimeCommand({
      args: [
        "create-disposable-binding",
        "finish-slice",
        "--goal",
        "Finish a state-only lifecycle task.",
        "--worker",
        "finish-worker",
        "--manager",
        "finish-manager",
        "--run-name",
        "finish-run",
        "--required-before-continue",
        "ci_green",
        "--path",
        dbPath,
        "--json",
      ],
      cwd: root,
      env: {},
    });
    assert.equal(finishCreated.exitCode, 0, finishCreated.stderr);

    const finished = runTypescriptRuntimeCommand({
      args: [
        "finish-task",
        "finish-slice",
        "--reason",
        "QA complete.",
        "--path",
        dbPath,
      ],
      cwd: root,
      env: {},
    });
    assert.equal(finished.exitCode, 0, finished.stderr);
    assert.equal(finished.handled, true);
    const finishPayload = JSON.parse(finished.stdout ?? "{}") as {
      command_id: string;
      final_ack_audit: { missing: string[]; ok: boolean; require_acks: boolean };
      final_audit: { open_criteria: unknown[]; require_criteria_audit: boolean; total: number };
      final_decision_id: number;
      final_epilogue_audit: { ok: boolean; required_steps: string[] };
      finish: boolean;
      killed_manager: boolean;
      killed_worker: boolean;
      manager_decision: { decision_id: null; ok: boolean; warnings: string[] };
      manager_session: string;
      pre_stop_transcript_captures: unknown[];
      reason: string;
      stop_manager: boolean;
      stop_worker: boolean;
      task: string;
      worker: string;
      worker_session: string;
    };
    assert.equal(finishPayload.finish, true);
    assert.equal(finishPayload.task, "finish-slice");
    assert.equal(finishPayload.reason, "QA complete.");
    assert.equal(finishPayload.stop_manager, false);
    assert.equal(finishPayload.stop_worker, false);
    assert.equal(finishPayload.killed_manager, false);
    assert.equal(finishPayload.killed_worker, false);
    assert.deepEqual(finishPayload.pre_stop_transcript_captures, []);
    assert.equal(finishPayload.worker, "finish-worker");
    assert.equal(finishPayload.worker_session, "finish-worker");
    assert.equal(finishPayload.manager_session, "finish-manager");
    assert.deepEqual(finishPayload.manager_decision, {
      allowed_decisions: ["stop"],
      decision: null,
      decision_id: null,
      ok: false,
      warnings: ["missing_decision_id"],
    });
    assert.equal(finishPayload.final_audit.require_criteria_audit, false);
    assert.equal(finishPayload.final_audit.total, 0);
    assert.deepEqual(finishPayload.final_audit.open_criteria, []);
    assert.equal(finishPayload.final_ack_audit.require_acks, false);
    assert.equal(finishPayload.final_ack_audit.ok, false);
    assert.deepEqual(finishPayload.final_ack_audit.missing, ["worker", "manager"]);
    assert.equal(finishPayload.final_epilogue_audit.ok, true);
    assert.deepEqual(finishPayload.final_epilogue_audit.required_steps, []);

    const afterFinish = openDatabaseSync(dbPath);
    try {
      const task = afterFinish.prepare("select state from tasks where name = 'finish-slice'")
        .get() as { state: string };
      assert.equal(task.state, "done");
      const binding = afterFinish.prepare("select state, ended_at from bindings where task_id = (select id from tasks where name = 'finish-slice')")
        .get() as { ended_at: string | null; state: string };
      assert.equal(binding.state, "ended");
      assert.ok(binding.ended_at);
      const run = afterFinish.prepare("select status, ended_at from runs where name = 'finish-run'")
        .get() as { ended_at: string | null; status: string };
      assert.equal(run.status, "finished");
      assert.ok(run.ended_at);
      const command = afterFinish.prepare("select type, state, result_json from commands where id = ?")
        .get(finishPayload.command_id) as { result_json: string; state: string; type: string };
      assert.equal(command.type, "finish_task");
      assert.equal(command.state, "succeeded");
      assert.equal(JSON.parse(command.result_json).reason, "QA complete.");
      const decision = afterFinish.prepare("select decision, reason, payload_json from manager_decisions where id = ?")
        .get(finishPayload.final_decision_id) as { decision: string; payload_json: string; reason: string };
      assert.equal(decision.decision, "stop");
      assert.equal(decision.reason, "QA complete.");
      assert.equal(JSON.parse(decision.payload_json).source, "finish_task");
      const observation = afterFinish.prepare("select message from agent_observations where command_id = ?")
        .get(finishPayload.command_id) as { message: string };
      assert.equal(observation.message, "QA complete.");
      const eventTypes = afterFinish.prepare("select type from events where task_id = (select id from tasks where name = 'finish-slice') order by id")
        .all() as Array<{ type: string }>;
      assert.ok(eventTypes.some((event) => event.type === "finish_task_intent"));
      assert.ok(eventTypes.some((event) => event.type === "finish_task_criteria_audit"));
      assert.ok(eventTypes.some((event) => event.type === "finish_task_succeeded"));
      const telemetryTypes = afterFinish.prepare("select event_type from telemetry_events where task_id = (select id from tasks where name = 'finish-slice')")
        .all() as Array<{ event_type: string }>;
      assert.ok(telemetryTypes.some((event) => event.event_type === "command_attempted"));
      assert.ok(telemetryTypes.some((event) => event.event_type === "command_succeeded"));
      assert.ok(telemetryTypes.some((event) => event.event_type === "manager_decision_recorded"));
      assert.ok(telemetryTypes.some((event) => event.event_type === "task_finished"));
    } finally {
      afterFinish.close();
    }

    const stopCreated = runTypescriptRuntimeCommand({
      args: [
        "create-disposable-binding",
        "stop-slice",
        "--worker",
        "stop-worker",
        "--manager",
        "stop-manager",
        "--run-name",
        "stop-run",
        "--required-before-continue",
        "manual_review",
        "--path",
        dbPath,
        "--json",
      ],
      cwd: root,
      env: {},
    });
    assert.equal(stopCreated.exitCode, 0, stopCreated.stderr);
    const stopped = runTypescriptRuntimeCommand({
      args: ["stop-task", "stop-slice", "--reason", "Operator stopped.", "--path", dbPath],
      cwd: root,
      env: {},
    });
    assert.equal(stopped.exitCode, 0, stopped.stderr);
    const stopPayload = JSON.parse(stopped.stdout ?? "{}") as {
      command_id: string;
      final_decision_id: null;
      final_observation_id: null;
      finish: boolean;
      reason: string;
      stop_manager: boolean;
      stop_worker: boolean;
      task: string;
    };
    assert.equal(stopPayload.finish, false);
    assert.equal(stopPayload.final_decision_id, null);
    assert.equal(stopPayload.final_observation_id, null);
    assert.equal(stopPayload.reason, "Operator stopped.");
    assert.equal(stopPayload.stop_manager, true);
    assert.equal(stopPayload.stop_worker, false);
    assert.equal(stopPayload.task, "stop-slice");

    const afterStop = openDatabaseSync(dbPath);
    try {
      const task = afterStop.prepare("select state from tasks where name = 'stop-slice'")
        .get() as { state: string };
      assert.equal(task.state, "done");
      const run = afterStop.prepare("select status from runs where name = 'stop-run'")
        .get() as { status: string };
      assert.equal(run.status, "finished");
      const command = afterStop.prepare("select type, state from commands where id = ?")
        .get(stopPayload.command_id) as { state: string; type: string };
      assert.equal(command.type, "stop_task");
      assert.equal(command.state, "succeeded");
      const eventTypes = afterStop.prepare("select type from events where task_id = (select id from tasks where name = 'stop-slice')")
        .all() as Array<{ type: string }>;
      assert.ok(eventTypes.some((event) => event.type === "stop_task_intent"));
      assert.ok(eventTypes.some((event) => event.type === "stop_task_succeeded"));
      const telemetryTypes = afterStop.prepare("select event_type from telemetry_events where task_id = (select id from tasks where name = 'stop-slice')")
        .all() as Array<{ event_type: string }>;
      assert.ok(telemetryTypes.some((event) => event.event_type === "task_stopped"));
    } finally {
      afterStop.close();
    }

    const activeRunDb = openDatabaseSync(dbPath);
    try {
      const finishTaskId = createTaskSync(activeRunDb, {
        goal: "Close an active run on finish.",
        name: "active-run-finish",
      });
      const stopTaskId = createTaskSync(activeRunDb, {
        goal: "Close an active run on stop.",
        name: "active-run-stop",
      });
      const startedAt = new Date().toISOString();
      activeRunDb.prepare(`
        insert into runs(id, task_id, name, purpose, status, started_at, ended_at, metadata_json)
        values (?, ?, ?, 'ralph_loop', 'active', ?, null, ?)
      `).run("run-active-finish", finishTaskId, "active-run-finish-run", startedAt, "{}");
      activeRunDb.prepare(`
        insert into runs(id, task_id, name, purpose, status, started_at, ended_at, metadata_json)
        values (?, ?, ?, 'ralph_loop', 'active', ?, null, ?)
      `).run("run-active-stop", stopTaskId, "active-run-stop-run", startedAt, "{}");
    } finally {
      activeRunDb.close();
    }

    const activeFinish = runTypescriptRuntimeCommand({
      args: ["finish-task", "active-run-finish", "--reason", "Active run finished.", "--path", dbPath],
      cwd: root,
      env: {},
    });
    assert.equal(activeFinish.exitCode, 0, activeFinish.stderr);
    const activeStop = runTypescriptRuntimeCommand({
      args: ["stop-task", "active-run-stop", "--reason", "Active run stopped.", "--path", dbPath],
      cwd: root,
      env: {},
    });
    assert.equal(activeStop.exitCode, 0, activeStop.stderr);
    const activeRunCheck = openDatabaseSync(dbPath);
    try {
      const activeRuns = activeRunCheck.prepare("select name, status, ended_at from runs where name in ('active-run-finish-run', 'active-run-stop-run') order by name")
        .all() as Array<{ ended_at: string | null; name: string; status: string }>;
      assert.deepEqual(activeRuns.map((run) => ({ name: run.name, status: run.status })), [
        { name: "active-run-finish-run", status: "finished" },
        { name: "active-run-stop-run", status: "abandoned" },
      ]);
      assert.ok(activeRuns.every((run) => run.ended_at));
      const activeRunTelemetry = activeRunCheck.prepare(`
        select r.name, t.event_type
        from telemetry_events t
        join runs r on r.id = t.run_id
        where r.name in ('active-run-finish-run', 'active-run-stop-run')
        order by r.name, t.event_type
      `).all() as Array<{ event_type: string; name: string }>;
      assert.deepEqual(activeRunTelemetry.map((event) => ({ ...event })), [
        { name: "active-run-finish-run", event_type: "run_finished" },
        { name: "active-run-stop-run", event_type: "run_finished" },
      ]);
    } finally {
      activeRunCheck.close();
    }

    assert.deepEqual(
      runTypescriptRuntimeCommand({
        args: ["finish-task", "needs-json", "--json", "--path", dbPath],
        cwd: root,
        env: {},
      }),
      { exitCode: 0, handled: false },
    );
    const explicitLive = runTypescriptRuntimeCommand({
      args: ["--ts-runtime", "finish-task", "needs-live", "--stop-worker", "--path", dbPath],
      cwd: root,
      env: {},
    });
    assert.equal(explicitLive.exitCode, 2);
    assert.match(explicitLive.stderr ?? "", /Unknown task: needs-live/);
    const needsCapture = runTypescriptRuntimeCommand({
      args: ["finish-task", "needs-capture", "--capture-transcript-before-stop", "--path", dbPath],
      cwd: root,
      env: {},
    });
    assert.equal(needsCapture.exitCode, 2);
    assert.match(needsCapture.stderr ?? "", /Unknown task: needs-capture/);
    const needsWorkerStop = runTypescriptRuntimeCommand({
      args: ["stop-task", "needs-worker-stop", "--stop-worker", "--path", dbPath],
      cwd: root,
      env: {},
    });
    assert.equal(needsWorkerStop.exitCode, 2);
    assert.match(needsWorkerStop.stderr ?? "", /Unknown task: needs-worker-stop/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("TypeScript runtime handles finish-task final gates by default", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-ts-finish-gates."));
  try {
    const dbPath = join(root, "workerctl.db");
    const database = openDatabaseSync(dbPath);
    try {
      initializeDatabaseSync(database);
      const timestamp = new Date().toISOString();
      const criteriaTaskId = createTaskSync(database, {
        goal: "Finish only after criteria are audited.",
        name: "gate-criteria",
      });
      const ackTaskId = createTaskSync(database, {
        goal: "Finish only after acknowledgements exist.",
        name: "gate-acks",
      });
      const epilogueTaskId = createTaskSync(database, {
        goal: "Finish only after epilogue succeeds.",
        name: "gate-epilogue",
      });
      const proofTaskId = createTaskSync(database, {
        goal: "Finish only after adversarial proof exists.",
        name: "gate-proof",
      });
      const proofOkTaskId = createTaskSync(database, {
        goal: "Finish after structured adversarial proof exists.",
        name: "gate-proof-ok",
      });
      database.prepare("update tasks set state = 'managed', updated_at = ? where id in (?, ?, ?, ?, ?)")
        .run(timestamp, criteriaTaskId, ackTaskId, epilogueTaskId, proofTaskId, proofOkTaskId);
      database.prepare(`
        insert into acceptance_criteria(
          task_id, criterion, status, source, proof, rationale, evidence_json, created_at, updated_at
        )
        values (?, ?, 'accepted', 'manager_inferred', null, null, '{}', ?, ?)
      `).run(criteriaTaskId, "Run final regression tests", timestamp, timestamp);
      for (const role of ["worker", "manager"]) {
        database.prepare(`
          insert into task_acknowledgements(
            task_id, binding_id, role, payload_json, revision, manager_config_revision, created_at, correlation_id
          )
          values (?, null, ?, '{}', 1, null, ?, null)
        `).run(ackTaskId, role, timestamp);
      }
      database.prepare(`
        insert into manager_configs(
          task_id, supervision_mode, objective, guidelines_json, acceptance_criteria_json, reference_paths_json,
          permissions_json, tools_json, epilogues_json, nudge_on_completion, require_acks, revision, created_at, updated_at
        )
        values (?, 'guided', null, '[]', '[]', '[]', '{}', '[]', '["draft-pr"]', 'ask-operator', 0, 1, ?, ?)
      `).run(epilogueTaskId, timestamp, timestamp);
      database.prepare(`
        insert into epilogue_runs(
          task_id, step_name, state, started_at, finished_at, result_json, error, correlation_id
        )
        values (?, 'draft-pr', 'succeeded', ?, ?, '{"summary":"ready"}', null, 'corr-epilogue')
      `).run(epilogueTaskId, timestamp, timestamp);
      database.prepare(`
        insert into acceptance_criteria(
          task_id, criterion, status, source, proof, rationale, evidence_json, created_at, updated_at
        )
        values (?, ?, 'satisfied', 'manager_inferred', ?, null, ?, ?, ?)
      `).run(
        proofOkTaskId,
        "Adversarial proof recorded",
        "Tried to disprove the change.",
        JSON.stringify({
          check: "negative test",
          evidence_type: "adversarial_check",
          failure_mode: "Happy-path only verification.",
          result: "negative test passed",
        }),
        timestamp,
        timestamp,
      );
    } finally {
      database.close();
    }

    const criteriaFailure = runTypescriptRuntimeCommand({
      args: ["finish-task", "gate-criteria", "--require-criteria-audit", "--reason", "Done too early.", "--path", dbPath],
      cwd: root,
      env: {},
    });
    assert.equal(criteriaFailure.exitCode, 1);
    assert.match(criteriaFailure.stderr ?? "", /accepted acceptance criteria still open/);
    const proofFailure = runTypescriptRuntimeCommand({
      args: ["finish-task", "gate-proof", "--require-adversarial-proof", "--reason", "Done without proof.", "--path", dbPath],
      cwd: root,
      env: {},
    });
    assert.equal(proofFailure.exitCode, 1);
    assert.match(proofFailure.stderr ?? "", /adversarial proof is required/);

    const ackSuccess = runTypescriptRuntimeCommand({
      args: ["finish-task", "gate-acks", "--require-acks", "--reason", "Acks present.", "--path", dbPath],
      cwd: root,
      env: {},
    });
    assert.equal(ackSuccess.exitCode, 0, ackSuccess.stderr);
    const ackPayload = JSON.parse(ackSuccess.stdout ?? "{}") as {
      final_ack_audit: { missing: string[]; require_acks: boolean };
      finish: boolean;
    };
    assert.equal(ackPayload.finish, true);
    assert.equal(ackPayload.final_ack_audit.require_acks, true);
    assert.deepEqual(ackPayload.final_ack_audit.missing, []);

    const epilogueSuccess = runTypescriptRuntimeCommand({
      args: ["finish-task", "gate-epilogue", "--require-epilogue", "--reason", "Epilogue present.", "--path", dbPath],
      cwd: root,
      env: {},
    });
    assert.equal(epilogueSuccess.exitCode, 0, epilogueSuccess.stderr);
    const epiloguePayload = JSON.parse(epilogueSuccess.stdout ?? "{}") as {
      final_epilogue_audit: { missing_or_incomplete: string[]; require_epilogue: boolean; required_steps: string[] };
    };
    assert.equal(epiloguePayload.final_epilogue_audit.require_epilogue, true);
    assert.deepEqual(epiloguePayload.final_epilogue_audit.required_steps, ["draft-pr"]);
    assert.deepEqual(epiloguePayload.final_epilogue_audit.missing_or_incomplete, []);

    const proofSuccess = runTypescriptRuntimeCommand({
      args: ["finish-task", "gate-proof-ok", "--require-adversarial-proof", "--reason", "Proof exists.", "--path", dbPath],
      cwd: root,
      env: {},
    });
    assert.equal(proofSuccess.exitCode, 0, proofSuccess.stderr);
    const proofPayload = JSON.parse(proofSuccess.stdout ?? "{}") as { finish: boolean };
    assert.equal(proofPayload.finish, true);

    const afterGates = openDatabaseSync(dbPath);
    try {
      const criteriaTask = afterGates.prepare("select state from tasks where name = 'gate-criteria'")
        .get() as { state: string };
      assert.equal(criteriaTask.state, "managed");
      const failedCommand = afterGates.prepare("select state, result_json, error from commands where task_id = (select id from tasks where name = 'gate-criteria')")
        .get() as { error: string; result_json: string; state: string };
      assert.equal(failedCommand.state, "failed");
      assert.match(failedCommand.error, /accepted acceptance criteria still open/);
      const failedResult = JSON.parse(failedCommand.result_json) as {
        expected_failure: boolean;
        failure_stage: string;
        final_audit: { open_criteria: Array<{ criterion: string }> };
      };
      assert.equal(failedResult.expected_failure, true);
      assert.equal(failedResult.failure_stage, "final_criteria_audit");
      assert.deepEqual(failedResult.final_audit.open_criteria.map((criterion) => criterion.criterion), [
        "Run final regression tests",
      ]);
      const failedEvent = afterGates.prepare("select payload_json from events where type = 'finish_task_failed'")
        .get() as { payload_json: string };
      assert.equal(JSON.parse(failedEvent.payload_json).failure_stage, "final_criteria_audit");
      const proofCommands = afterGates.prepare("select count(*) as count from commands where task_id = (select id from tasks where name = 'gate-proof')")
        .get() as { count: number };
      assert.equal(proofCommands.count, 0);
      const doneTasks = afterGates.prepare("select name, state from tasks where name in ('gate-acks', 'gate-epilogue', 'gate-proof-ok') order by name")
        .all() as Array<{ name: string; state: string }>;
      assert.deepEqual(doneTasks.map((task) => ({ ...task })), [
        { name: "gate-acks", state: "done" },
        { name: "gate-epilogue", state: "done" },
        { name: "gate-proof-ok", state: "done" },
      ]);
    } finally {
      afterGates.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("TypeScript runtime handles deterministic session registry and discovery commands by default", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-ts-sessions."));
  try {
    mkdirSync(join(root, ".codex-workers"));
    const rolloutDir = join(root, ".codex", "sessions", "2026");
    mkdirSync(rolloutDir, { recursive: true });
    const workerRollout = join(rolloutDir, "rollout-worker.jsonl");
    const managerRollout = join(rolloutDir, "rollout-manager.jsonl");
    writeFileSync(workerRollout, `${JSON.stringify({
      payload: { cli_version: "1.2.3", cwd: "/worker-cwd", id: "codex-worker-a", originator: "codex" },
      type: "session_meta",
    })}\n`);
    writeFileSync(managerRollout, `${JSON.stringify({
      payload: { cli_version: "1.2.3", cwd: "/manager-cwd", id: "codex-manager-a", originator: "codex" },
      type: "session_meta",
    })}\n`);

    const pidOnlyFallback = runTypescriptRuntimeCommand({
      args: ["register-worker", "--name", "pid-only", "--pid", "555"],
      cwd: root,
      env: {},
    });
    assert.deepEqual(pidOnlyFallback, { exitCode: 0, handled: false });

    const worker = runTypescriptRuntimeCommand({
      args: [
        "register-worker",
        "--name",
        "worker-a",
        "--pid",
        "123",
        "--codex-session",
        workerRollout,
        "--tmux-session",
        "codex-worker-a",
      ],
      cwd: root,
      env: {},
    });
    assert.equal(worker.exitCode, 0);
    assert.equal(worker.handled, true);
    const workerPayload = JSON.parse(worker.stdout ?? "{}") as {
      codex_session_id: string;
      communication: { can_receive_push: boolean; delivery_mode: string; session_kind: string };
      cwd: string;
      name: string;
      pid: number;
      role: string;
      session_id: string;
      tmux_session: string | null;
    };
    assert.equal(workerPayload.codex_session_id, "codex-worker-a");
    assert.equal(workerPayload.cwd, "/worker-cwd");
    assert.equal(workerPayload.name, "worker-a");
    assert.equal(workerPayload.pid, 123);
    assert.equal(workerPayload.role, "worker");
    assert.match(workerPayload.session_id, /^session-/);
    assert.equal(workerPayload.tmux_session, "codex-worker-a");
    assert.deepEqual(workerPayload.communication, {
      can_receive_pull: true,
      can_receive_push: true,
      delivery_mode: "push",
      detection_source: "tmux_session",
      poll_command_template: "conveyor worker-inbox <task> --consume-next --wait --timeout 60 --json",
      receive_style: "push",
      requires_polling: false,
      session_kind: "tmux",
      tmux_session: "codex-worker-a",
    });

    const manager = runTypescriptRuntimeCommand({
      args: [
        "register-manager",
        "--name",
        "manager-a",
        "--pid",
        "456",
        "--codex-session",
        managerRollout,
        "--cwd",
        "/override-manager-cwd",
      ],
      cwd: root,
      env: {},
    });
    assert.equal(manager.exitCode, 0);
    assert.equal(manager.handled, true);
    const managerPayload = JSON.parse(manager.stdout ?? "{}") as {
      communication: { can_receive_push: boolean; delivery_mode: string; session_kind: string };
      cwd: string;
      name: string;
      role: string;
      tmux_session: string | null;
    };
    assert.equal(managerPayload.cwd, "/override-manager-cwd");
    assert.equal(managerPayload.name, "manager-a");
    assert.equal(managerPayload.role, "manager");
    assert.equal(managerPayload.tmux_session, null);
    assert.equal(managerPayload.communication.can_receive_push, false);
    assert.equal(managerPayload.communication.delivery_mode, "pull_required");
    assert.equal(managerPayload.communication.session_kind, "codex_app");

    const dbPath = defaultDbPath({ cwd: root, env: {} });
    const database = openDatabaseSync(dbPath);
    try {
      createTaskSync(database, {
        goal: "Exercise session discovery.",
        name: "session-task",
        now: "2026-06-04T10:00:00Z",
        taskId: "task-session",
      });
      const events = database.prepare("select type, payload_json from events where type = 'session_registered' order by id")
        .all() as Array<{ payload_json: string; type: string }>;
      assert.equal(events.length, 2);
      assert.deepEqual(events.map((event) => JSON.parse(event.payload_json).name), ["worker-a", "manager-a"]);
    } finally {
      database.close();
    }

    const sessions = runTypescriptRuntimeCommand({
      args: ["sessions", "--role", "worker", "--redact-identity-token"],
      cwd: root,
      env: {},
    });
    assert.equal(sessions.exitCode, 0);
    assert.equal(sessions.handled, true);
    const sessionRows = JSON.parse(sessions.stdout ?? "[]") as Array<{
      identity_token: string;
      name: string;
      role: string;
    }>;
    assert.deepEqual(sessionRows.map((session) => session.name), ["worker-a"]);
    assert.equal(sessionRows[0].role, "worker");
    assert.equal(sessionRows[0].identity_token, "[REDACTED]");

    const sessionsPathFallback = runTypescriptRuntimeCommand({
      args: ["sessions", "--path", dbPath],
      cwd: root,
      env: {},
    });
    assert.deepEqual(sessionsPathFallback, { exitCode: 0, handled: false });

    const discovered = runTypescriptRuntimeCommand({
      args: ["discover", "--limit", "5"],
      cwd: root,
      env: {},
    });
    assert.equal(discovered.exitCode, 0);
    const discoverPayload = JSON.parse(discovered.stdout ?? "{}") as {
      query: string;
      sessions: Array<{ name: string }>;
      suggestions: Array<{ command?: string; kind: string }>;
      tasks: Array<{ name: string }>;
    };
    assert.equal(discoverPayload.query, "");
    assert.deepEqual(discoverPayload.tasks.map((task) => task.name), ["session-task"]);
    assert.deepEqual(discoverPayload.sessions.map((session) => session.name), ["worker-a", "manager-a"]);
    assert.equal(discoverPayload.suggestions[0].kind, "bind");
    assert.equal(
      discoverPayload.suggestions[0].command,
      "conveyor bind --task 'session-task' --worker 'worker-a' --manager 'manager-a'",
    );

    const deregisterPathFallback = runTypescriptRuntimeCommand({
      args: ["deregister", "worker-a", "--path", dbPath],
      cwd: root,
      env: {},
    });
    assert.deepEqual(deregisterPathFallback, { exitCode: 0, handled: false });

    const deregistered = runTypescriptRuntimeCommand({
      args: ["deregister", "worker-a"],
      cwd: root,
      env: {},
    });
    assert.equal(deregistered.exitCode, 0);
    assert.equal(deregistered.handled, true);
    assert.equal(deregistered.stdout, "{\"name\": \"worker-a\", \"state\": \"gone\"}\n");

    const afterDeregister = openDatabaseSync(dbPath);
    try {
      const workerState = afterDeregister.prepare("select state from sessions where name = 'worker-a'")
        .get() as { state: string };
      assert.equal(workerState.state, "gone");
      const command = afterDeregister.prepare("select type, state, result_json from commands where type = 'deregister_session'")
        .get() as { result_json: string; state: string; type: string };
      assert.equal(command.state, "succeeded");
      assert.deepEqual(JSON.parse(command.result_json), {
        command_id: JSON.parse(command.result_json).command_id,
        name: "worker-a",
        state: "gone",
      });
      const event = afterDeregister.prepare("select command_id, payload_json from events where type = 'session_deregistered'")
        .get() as { command_id: string; payload_json: string };
      assert.ok(event.command_id);
      assert.deepEqual(JSON.parse(event.payload_json), { name: "worker-a" });
    } finally {
      afterDeregister.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("TypeScript runtime handles legacy start with bootstrap prompt and Codex passthrough args", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-ts-legacy-start."));
  const calls: string[][] = [];
  const runner: TmuxRunner = (args) => {
    calls.push(args);
    if (args.join(" ") === "tmux has-session -t qa-raw") {
      return { status: 1, stderr: "no session" };
    }
    return { status: 0, stdout: "" };
  };
  try {
    const stateRoot = join(root, "state");
    const env = { WORKERCTL_STATE_ROOT: stateRoot };

    const result = runTypescriptRuntimeCommand({
      args: [
        "start",
        "--dangerously-bypass-approvals-and-sandbox",
        "qa-raw",
        "--cwd",
        "~",
        "--sandbox",
        "danger-full-access",
        "--ask-for-approval",
        "never",
        "--",
        "--model",
        "gpt-5.4-mini",
      ],
      cwd: root,
      codexCommandResolver: () => "codex",
      env,
      tmuxRunner: runner,
    });

    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(result.handled, true);
    const payload = JSON.parse(result.stdout ?? "{}") as {
      attach_command: string;
      cwd: string;
      register_worker_command_template: string;
      session: string;
      start_manager_command_template: string;
      start_prompt_path: string;
      start_prompt_sent: boolean;
    };
    assert.equal(payload.session, "qa-raw");
    assert.equal(payload.attach_command, "tmux attach -t qa-raw");
    assert.equal(payload.cwd, homedir());
    assert.equal(payload.start_prompt_sent, true);
    assert.equal(payload.start_prompt_path, join(stateRoot, "artifacts", "start-prompts", "qa-raw.md"));
    assert.match(payload.register_worker_command_template, /register-worker --name <worker-name>/);
    assert.match(payload.start_manager_command_template, /-- '--dangerously-bypass-approvals-and-sandbox' '--sandbox'/);
    assert.match(payload.start_manager_command_template, /'--sandbox' 'danger-full-access' '--ask-for-approval' 'never'/);
    assert.match(payload.start_manager_command_template, /'--ask-for-approval' 'never' '--model' 'gpt-5.4-mini'/);
    const prompt = readFileSync(payload.start_prompt_path, "utf8");
    assert.match(prompt, /Agent Conveyor tmux session qa-raw/);
    assert.match(prompt, /worker-ack <task-name>/);
    assert.match(prompt, /goal_restatement/);
    assert.match(prompt, /proposed_criteria/);
    assert.match(prompt, /must-have and follow-up criteria/);
    assert.match(prompt, /ready_to_start/);
    assert.match(prompt, /Required fields:\n- worker name\n- manager name\n- task name\n- goal/);
    assert.match(prompt, /-- '--dangerously-bypass-approvals-and-sandbox' '--sandbox'/);
    assert.match(prompt, /'--sandbox' 'danger-full-access' '--ask-for-approval' 'never'/);
    assert.match(prompt, /'--ask-for-approval' 'never' '--model' 'gpt-5.4-mini'/);
    assert.deepEqual(calls[0], ["tmux", "-V"]);
    assert.deepEqual(calls[1], ["tmux", "has-session", "-t", "qa-raw"]);
    assert.deepEqual(calls[2].slice(0, 5), ["tmux", "new-session", "-d", "-s", "qa-raw"]);
    assert.match(calls[2][5] ?? "", /codex --cd/);
    assert.match(calls[2][5] ?? "", /--no-alt-screen/);
    assert.match(calls[2][5] ?? "", /'--dangerously-bypass-approvals-and-sandbox' '--sandbox'/);
    assert.match(calls[2][5] ?? "", /'--sandbox' 'danger-full-access' '--ask-for-approval' 'never'/);
    assert.match(calls[2][5] ?? "", /'--model' 'gpt-5.4-mini'/);
    assert.match(calls[2][5] ?? "", /\$\(cat/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("TypeScript runtime preserves legacy start help fallback without launching tmux", () => {
  const calls: string[][] = [];
  const runner: TmuxRunner = (args) => {
    calls.push(args);
    return { status: 0, stdout: "" };
  };

  const commandHelp = runTypescriptRuntimeCommand({
    args: ["start", "--help"],
    codexCommandResolver: () => "codex",
    cwd: "/tmp",
    tmuxRunner: runner,
  });
  assert.equal(commandHelp.handled, false);

  const sessionHelp = runTypescriptRuntimeCommand({
    args: ["start", "qa-help", "--help"],
    codexCommandResolver: () => "codex",
    cwd: "/tmp",
    tmuxRunner: runner,
  });
  assert.equal(sessionHelp.handled, false);
  assert.deepEqual(calls, []);
});

test("TypeScript runtime rejects non-create flags before legacy create/start-test launches", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-ts-create-options."));
  const calls: string[][] = [];
  const runner: TmuxRunner = (args) => {
    calls.push(args);
    return { status: 0, stdout: "" };
  };
  try {
    const repo = join(root, "repo");
    const env = { WORKERCTL_STATE_ROOT: join(root, "state") };
    mkdirSync(repo, { recursive: true });

    const createResult = runTypescriptRuntimeCommand({
      args: ["create", "bad-create-option", "--cwd", repo, "--current-task", "oops"],
      codexCommandResolver: () => "codex",
      cwd: root,
      env,
      tmuxRunner: runner,
    });
    assert.equal(createResult.handled, false);

    const startTestResult = runTypescriptRuntimeCommand({
      args: ["start-test", "bad-start-test-option", "--cwd", repo, "--busy-wait-seconds", "7"],
      codexCommandResolver: () => "codex",
      cwd: root,
      env,
      tmuxRunner: runner,
    });
    assert.equal(startTestResult.handled, false);
    assert.deepEqual(calls, []);
    assert.equal(existsSync(workerDir("bad-create-option", { cwd: root, env })), false);
    assert.equal(existsSync(workerDir("bad-start-test-option", { cwd: root, env })), false);
    assert.equal(existsSync(defaultDbPath({ cwd: root, env })), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("TypeScript runtime reports invalid legacy cwd as runtime failure without state side effects", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-ts-bad-cwd."));
  const calls: string[][] = [];
  const runner: TmuxRunner = (args) => {
    calls.push(args);
    return { status: 0, stdout: "" };
  };
  try {
    const env = { WORKERCTL_STATE_ROOT: join(root, "state") };
    const missing = join(root, "missing");

    const startResult = runTypescriptRuntimeCommand({
      args: ["start", "bad-cwd-start", "--cwd", missing],
      codexCommandResolver: () => "codex",
      cwd: root,
      env,
      tmuxRunner: runner,
    });
    assert.equal(startResult.exitCode, 1);
    assert.match(startResult.stderr ?? "", /Session cwd does not exist or is not a directory/);

    const createResult = runTypescriptRuntimeCommand({
      args: ["create", "bad-cwd-create", "--cwd", missing],
      codexCommandResolver: () => "codex",
      cwd: root,
      env,
      tmuxRunner: runner,
    });
    assert.equal(createResult.exitCode, 1);
    assert.match(createResult.stderr ?? "", /Worker cwd does not exist or is not a directory/);

    const startTestResult = runTypescriptRuntimeCommand({
      args: ["start-test", "bad-cwd-test", "--cwd", missing],
      codexCommandResolver: () => "codex",
      cwd: root,
      env,
      tmuxRunner: runner,
    });
    assert.equal(startTestResult.exitCode, 1);
    assert.match(startTestResult.stderr ?? "", /Worker cwd does not exist or is not a directory/);
    assert.deepEqual(calls, []);
    assert.equal(existsSync(workerDir("bad-cwd-create", { cwd: root, env })), false);
    assert.equal(existsSync(workerDir("bad-cwd-test", { cwd: root, env })), false);
    assert.equal(existsSync(defaultDbPath({ cwd: root, env })), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("TypeScript runtime preflights Codex and tmux before legacy start and create launches", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-ts-missing-codex."));
  const calls: string[][] = [];
  let tmuxMissing = false;
  const runner: TmuxRunner = (args) => {
    calls.push(args);
    if (tmuxMissing && args.join(" ") === "tmux -V") {
      return { status: 127, stderr: "tmux is not installed or is not available on PATH" };
    }
    return { status: 0, stdout: "" };
  };
  try {
    const repo = join(root, "repo");
    const env = { WORKERCTL_STATE_ROOT: join(root, "state") };
    mkdirSync(repo, { recursive: true });

    const startResult = runTypescriptRuntimeCommand({
      args: ["start", "missing-start", "--cwd", repo],
      codexCommandResolver: () => null,
      cwd: root,
      env,
      tmuxRunner: runner,
    });
    assert.equal(startResult.exitCode, 1);
    assert.match(startResult.stderr ?? "", /Required tool not found on PATH: codex/);

    const createResult = runTypescriptRuntimeCommand({
      args: ["create", "missing-create", "--cwd", repo],
      codexCommandResolver: () => null,
      cwd: root,
      env,
      tmuxRunner: runner,
    });
    assert.equal(createResult.exitCode, 1);
    assert.match(createResult.stderr ?? "", /Required tool not found on PATH: codex/);
    assert.deepEqual(calls, []);
    assert.equal(existsSync(workerDir("missing-create", { cwd: root, env })), false);
    assert.equal(existsSync(defaultDbPath({ cwd: root, env })), false);

    tmuxMissing = true;
    const missingTmuxResult = runTypescriptRuntimeCommand({
      args: ["create", "missing-tmux", "--cwd", repo],
      codexCommandResolver: () => "codex",
      cwd: root,
      env,
      tmuxRunner: runner,
    });
    assert.equal(missingTmuxResult.exitCode, 1);
    assert.match(missingTmuxResult.stderr ?? "", /Required tool not found on PATH: tmux/);
    assert.deepEqual(calls, [["tmux", "-V"]]);
    assert.equal(existsSync(workerDir("missing-tmux", { cwd: root, env })), false);
    assert.equal(existsSync(defaultDbPath({ cwd: root, env })), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("TypeScript runtime handles legacy create dual-write and tmux launch", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-ts-legacy-create."));
  const calls: string[][] = [];
  let spawned = false;
  const runner: TmuxRunner = (args) => {
    calls.push(args);
    if (args.join(" ") === "tmux has-session -t codex-db-create-dual-write") {
      return { status: spawned ? 0 : 1, stderr: spawned ? "" : "no session" };
    }
    if (args.join(" ") === "tmux list-panes -t codex-db-create-dual-write -F #{pane_id}") {
      return { status: 0, stdout: "%1\n" };
    }
    if (args.slice(0, 5).join(" ") === "tmux new-session -d -s codex-db-create-dual-write") {
      spawned = true;
      return { status: 0, stdout: "" };
    }
    return { status: 0, stdout: "" };
  };
  try {
    const repo = join(root, "repo");
    const env = { WORKERCTL_STATE_ROOT: join(root, "state") };
    mkdirSync(repo, { recursive: true });

    const result = runTypescriptRuntimeCommand({
      args: ["create", "db-create-dual-write", "--cwd", repo, "--task", "Write initial status."],
      codexCommandResolver: () => "codex",
      cwd: root,
      env,
      now: () => new Date("2026-06-05T01:02:03Z"),
      tmuxRunner: runner,
    });

    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(result.handled, true);
    assert.match(result.stdout ?? "", /created db-create-dual-write/);
    assert.match(result.stdout ?? "", /tmux session: codex-db-create-dual-write/);
    assert.match(result.stdout ?? "", /contract provided as initial Codex prompt/);

    const config = JSON.parse(readFileSync(configPath("db-create-dual-write", { cwd: root, env }), "utf8")) as {
      identity_token: string;
      tmux_pane_id: string;
      worker_id: string;
    };
    assert.match(config.identity_token, /^workerctl-/);
    assert.equal(config.tmux_pane_id, "%1");
    const contract = readFileSync(join(workerDir("db-create-dual-write", { cwd: root, env }), "contract.txt"), "utf8");
    assert.match(contract, new RegExp(config.identity_token));
    assert.match(contract, /Dispatcher inbox:/);
    assert.match(contract, /worker-inbox <task-name> --consume-next --wait --timeout 60 --json/);
    assert.match(contract, /dispatch_inbox_consumed/);
    assert.deepEqual(JSON.parse(readFileSync(statusPath("db-create-dual-write", { cwd: root, env }), "utf8")), {
      blocker: null,
      current_task: "Write initial status.",
      last_update: "2026-06-05T01:02:03Z",
      next_action: "Wait for manager instruction or begin assigned task.",
      state: "waiting",
    });
    assert.equal(readFileSync(transcriptPath("db-create-dual-write", { cwd: root, env }), "utf8"), "");
    const compatibilityEvents = readFileSync(eventsPath("db-create-dual-write", { cwd: root, env }), "utf8")
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as { type: string });
    assert.deepEqual(compatibilityEvents.map((event) => event.type), ["create"]);
    const database = openDatabaseSync(defaultDbPath({ cwd: root, env }));
    try {
      const worker = database.prepare("select id, state, tmux_pane_id, identity_token from workers where name = ?")
        .get("db-create-dual-write") as { id: string; identity_token: string; state: string; tmux_pane_id: string };
      assert.equal(worker.id, config.worker_id);
      assert.equal(worker.state, "active");
      assert.equal(worker.tmux_pane_id, "%1");
      assert.equal(worker.identity_token, config.identity_token);
      const status = database.prepare("select state, current_task from statuses where worker_id = ?")
        .get(worker.id) as { current_task: string; state: string };
      assert.equal(status.state, "waiting");
      assert.equal(status.current_task, "Write initial status.");
      const dbEvents = database.prepare("select type from events where worker_id = ? order by id")
        .all(worker.id) as Array<{ type: string }>;
      assert.deepEqual(dbEvents.map((event) => event.type), ["worker_create_recorded", "worker_tmux_started"]);
    } finally {
      database.close();
    }
    const launch = calls.find((call) => call.slice(0, 5).join(" ") === "tmux new-session -d -s codex-db-create-dual-write");
    assert.ok(launch);
    assert.match(launch[5] ?? "", /codex --cd/);
    assert.match(launch[5] ?? "", /\$\(cat/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("TypeScript runtime leaves legacy create worker candidate when tmux launch fails", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-ts-legacy-create-fail."));
  const runner: TmuxRunner = (args) => {
    if (args.join(" ") === "tmux has-session -t codex-db-create-fail") {
      return { status: 1, stderr: "no session" };
    }
    if (args.slice(0, 5).join(" ") === "tmux new-session -d -s codex-db-create-fail") {
      return { status: 1, stderr: "tmux refused launch" };
    }
    return { status: 0, stdout: "" };
  };
  try {
    const repo = join(root, "repo");
    const env = { WORKERCTL_STATE_ROOT: join(root, "state") };
    mkdirSync(repo, { recursive: true });

    const result = runTypescriptRuntimeCommand({
      args: ["create", "db-create-fail", "--cwd", repo, "--task", "Write initial status."],
      codexCommandResolver: () => "codex",
      cwd: root,
      env,
      now: () => new Date("2026-06-05T01:02:03Z"),
      tmuxRunner: runner,
    });

    assert.equal(result.exitCode, 2);
    assert.match(result.stderr ?? "", /tmux refused launch/);
    const database = openDatabaseSync(defaultDbPath({ cwd: root, env }));
    try {
      const worker = database.prepare("select state from workers where name = ?")
        .get("db-create-fail") as { state: string };
      assert.equal(worker.state, "candidate");
    } finally {
      database.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("TypeScript runtime handles legacy start-test preset with wait-ready and verify", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-ts-start-test."));
  const calls: string[][] = [];
  let spawned = false;
  const env = { WORKERCTL_STATE_ROOT: join(root, "state") };
  const runner: TmuxRunner = (args) => {
    calls.push(args);
    if (args.join(" ") === "tmux has-session -t codex-live-test") {
      return { status: spawned ? 0 : 1, stderr: spawned ? "" : "no session" };
    }
    if (args.join(" ") === "tmux list-panes -t codex-live-test -F #{pane_id}") {
      return { status: 0, stdout: "%2\n" };
    }
    if (args.slice(0, 5).join(" ") === "tmux new-session -d -s codex-live-test") {
      spawned = true;
      return { status: 0, stdout: "" };
    }
    if (args.join(" ") === "tmux capture-pane -p -S -80 -t codex-live-test") {
      writeFileSync(statusPath("live-test", { cwd: root, env }), `${JSON.stringify({
        blocker: null,
        current_task: "README checked",
        last_update: "2026-06-05T01:02:04Z",
        next_action: "report",
        state: "planning",
      }, null, 2)}\n`);
      return { status: 0, stdout: "OpenAI Codex\n› " };
    }
    return { status: 0, stdout: "" };
  };
  try {
    const repo = join(root, "repo");
    mkdirSync(repo, { recursive: true });

    const result = runTypescriptRuntimeCommand({
      args: ["start-test", "--cwd", repo, "--wait-ready-timeout", "1", "--verify-timeout", "1"],
      codexCommandResolver: () => "codex",
      cwd: root,
      env,
      now: () => new Date("2026-06-05T01:02:03Z"),
      sleepMilliseconds: () => {},
      tmuxRunner: runner,
    });

    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(result.handled, true);
    assert.match(result.stdout ?? "", /created live-test/);
    assert.match(result.stdout ?? "", /startup: ready \(Codex input prompt is visible\)/);
    assert.match(result.stdout ?? "", /verification: ok \(status update observed\)/);
    assert.match(result.stdout ?? "", /current task: README checked/);
    const contract = readFileSync(join(workerDir("live-test", { cwd: root, env }), "contract.txt"), "utf8");
    assert.match(contract, /Read README\.md and run conveyor update-status live-test/);
    const compatibilityEvents = readFileSync(eventsPath("live-test", { cwd: root, env }), "utf8")
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as { type: string });
    assert.deepEqual(compatibilityEvents.map((event) => event.type), ["create", "wait_ready", "verify"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("TypeScript runtime handles start-worker spawn and register with fake tmux", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-ts-start-worker."));
  const calls: string[][] = [];
  const runner: TmuxRunner = (args) => {
    calls.push(args);
    if (args.join(" ") === "tmux has-session -t codex-auto-foo") {
      return { status: 1, stderr: "no session" };
    }
    return { status: 0, stdout: "" };
  };
  try {
    const dbPath = join(root, "workerctl.db");
    const rolloutDir = join(root, ".codex", "sessions", "2026");
    mkdirSync(rolloutDir, { recursive: true });
    const rollout = join(rolloutDir, "rollout-worker.jsonl");
    writeFileSync(rollout, `${JSON.stringify({
      payload: { cwd: "/repo", id: "cuid-worker", originator: "codex-tui" },
      type: "session_meta",
    })}\n`);

    const result = runTypescriptRuntimeCommand({
      args: [
        "start-worker",
        "--name",
        "auto-foo",
        "--cwd",
        "/repo",
        "--task",
        "Do work",
        "--codex-profile",
        "yolo",
        "--accept-trust",
        "--timeout-seconds",
        "7",
        "--path",
        dbPath,
      ],
      codexCommandResolver: () => "/opt/test/bin/codex",
      cwd: root,
      discoverSpawnedCodexSession: (options) => {
        assert.equal(options.acceptTrust, true);
        assert.equal(options.timeoutSeconds, 7);
        assert.equal(options.tmuxSessionName, "codex-auto-foo");
        assert.ok(options.minimumSessionTimestamp instanceof Date);
        return {
          codex_session_id: "cuid-worker",
          codex_session_path: rollout,
          cwd: "/repo",
          native_pid: 99999,
          originator: "codex-tui",
        };
      },
      env: {},
      tmuxRunner: runner,
    });

    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(result.handled, true);
    const payload = JSON.parse(result.stdout ?? "{}") as {
      codex_session_id: string;
      codex_session_path: string;
      cwd: string;
      name: string;
      pid: number;
      role: string;
      session_id: string;
      tmux_session: string;
    };
    assert.equal(payload.name, "auto-foo");
    assert.equal(payload.role, "worker");
    assert.equal(payload.pid, 99999);
    assert.equal(payload.codex_session_id, "cuid-worker");
    assert.equal(payload.codex_session_path, rollout);
    assert.equal(payload.cwd, "/repo");
    assert.match(payload.session_id, /^session-/);
    assert.equal(payload.tmux_session, "codex-auto-foo");
    assert.equal(calls.length, 3);
    assert.deepEqual(calls[0], ["tmux", "has-session", "-t", "codex-auto-foo"]);
    assert.deepEqual(calls[1].slice(0, 7), ["tmux", "new-session", "-d", "-s", "codex-auto-foo", "-c", "/repo"]);
    const codexShell = calls[1][7] ?? "";
    assert.match(codexShell, /unset "\$name"/);
    assert.match(codexShell, /PNPM_SCRIPT_SRC_DIR/);
    assert.match(codexShell, /exec \/opt\/test\/bin\/codex --sandbox danger-full-access --ask-for-approval never 'Do work'/);
    assert.deepEqual(calls[2], ["tmux", "send-keys", "-t", "codex-auto-foo", "Enter"]);

    const database = openDatabaseSync(dbPath);
    try {
      const session = database.prepare("select name, role, pid, codex_session_id, tmux_session from sessions where name = 'auto-foo'")
        .get() as { codex_session_id: string; name: string; pid: number; role: string; tmux_session: string };
      assert.equal(session.codex_session_id, "cuid-worker");
      assert.equal(session.name, "auto-foo");
      assert.equal(session.pid, 99999);
      assert.equal(session.role, "worker");
      assert.equal(session.tmux_session, "codex-auto-foo");
      const event = database.prepare("select payload_json from events where type = 'session_registered'")
        .get() as { payload_json: string };
      assert.deepEqual(JSON.parse(event.payload_json), {
        codex_session_id: "cuid-worker",
        name: "auto-foo",
        pid: 99999,
        role: "worker",
        session_id: payload.session_id,
        via: "start-worker",
      });
    } finally {
      database.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("TypeScript runtime handles start-manager bootstrap with seeded manager config", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-ts-start-manager."));
  const calls: string[][] = [];
  const runner: TmuxRunner = (args) => {
    calls.push(args);
    if (args.join(" ") === "tmux has-session -t codex-auto-mgr") {
      return { status: 1, stderr: "no session" };
    }
    return { status: 0, stdout: "" };
  };
  try {
    const dbPath = join(root, "workerctl.db");
    const rolloutDir = join(root, ".codex", "sessions", "2026");
    mkdirSync(rolloutDir, { recursive: true });
    const rollout = join(rolloutDir, "rollout-manager.jsonl");
    writeFileSync(rollout, `${JSON.stringify({
      payload: { cwd: "/repo", id: "cuid-manager", originator: "codex-tui" },
      type: "session_meta",
    })}\n`);
    const database = openDatabaseSync(dbPath);
    try {
      initializeDatabaseSync(database);
      createTaskSync(database, {
        goal: "Ship the support queue reporter",
        name: "late-task",
        taskId: "task-late",
      });
      database.prepare(`
        insert into manager_configs(
          task_id, supervision_mode, objective, guidelines_json, acceptance_criteria_json, reference_paths_json,
          permissions_json, tools_json, epilogues_json, nudge_on_completion, require_acks, revision, created_at, updated_at
        )
        values (?, 'strict', ?, '[]', ?, '[]', '{}', ?, '[]', 'ask-operator', 0, 1, ?, ?)
      `).run(
        "task-late",
        "Verify the reporter with pytest evidence.",
        JSON.stringify(["pytest passes"]),
        JSON.stringify(["pytest"]),
        "2026-06-04T14:00:00Z",
        "2026-06-04T14:00:00Z",
      );
    } finally {
      database.close();
    }

    const result = runTypescriptRuntimeCommand({
      args: [
        "start-manager",
        "--name",
        "auto-mgr",
        "--cwd",
        "/repo",
        "--task",
        "late-task",
        "--worker",
        "late-worker",
        "--path",
        dbPath,
      ],
      codexCommandResolver: () => "codex",
      cwd: root,
      discoverSpawnedCodexSession: () => ({
        codex_session_id: "cuid-manager",
        codex_session_path: rollout,
        cwd: "/repo",
        native_pid: 88888,
        originator: "codex-tui",
      }),
      env: {},
      tmuxRunner: runner,
    });

    assert.equal(result.exitCode, 0, result.stderr);
    const payload = JSON.parse(result.stdout ?? "{}") as { name: string; role: string; tmux_session: string };
    assert.equal(payload.name, "auto-mgr");
    assert.equal(payload.role, "manager");
    assert.equal(payload.tmux_session, "codex-auto-mgr");
    assert.deepEqual(calls[0], ["tmux", "has-session", "-t", "codex-auto-mgr"]);
    const codexShell = calls[1][7] ?? "";
    assert.match(codexShell, /You are a Codex manager session/);
    assert.match(codexShell, /Task: late-task/);
    assert.match(codexShell, /Task goal: Ship the support queue reporter/);
    assert.match(codexShell, /Worker session: late-worker/);
    assert.match(codexShell, /Manager config has already been recorded/);
    assert.match(codexShell, /cycle late-task/);
    assert.match(codexShell, /Expected tools: pytest\./);
    assert.match(codexShell, /finish-task late-task --reason "Accepted criteria satisfied" --require-criteria-audit/);

    const after = openDatabaseSync(dbPath);
    try {
      const session = after.prepare("select role, pid, tmux_session from sessions where name = 'auto-mgr'")
        .get() as { pid: number; role: string; tmux_session: string };
      assert.equal(session.pid, 88888);
      assert.equal(session.role, "manager");
      assert.equal(session.tmux_session, "codex-auto-mgr");
    } finally {
      after.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("TypeScript runtime handles legacy open dry-run and prior open guard", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-ts-open."));
  const calls: string[][] = [];
  const runner: TmuxRunner = (args) => {
    calls.push(args);
    if (args.join(" ") === "tmux has-session -t codex-worker-open") {
      return { status: 0, stdout: "" };
    }
    return { status: 1, stderr: "unexpected tmux command" };
  };
  try {
    const name = "worker-open";
    const workerDir = join(root, ".codex-workers", name);
    mkdirSync(workerDir, { recursive: true });
    writeFileSync(configPath(name, { cwd: root, env: {} }), `${JSON.stringify({
      name,
      tmux_session: "codex-worker-open",
    })}\n`);

    const dryRun = runTypescriptRuntimeCommand({
      args: ["open", name, "--terminal", "ghostty", "--dry-run"],
      cwd: root,
      env: {},
      tmuxRunner: runner,
    });
    assert.equal(dryRun.exitCode, 0, dryRun.stderr);
    assert.equal(dryRun.handled, true);
    assert.deepEqual(JSON.parse(dryRun.stdout ?? "{}"), {
      attach_command: "tmux attach -t codex-worker-open",
      command: ["open", "-na", "Ghostty.app", "--args", "-e", "tmux", "attach", "-t", "codex-worker-open"],
      dry_run: true,
      force: false,
      name,
      terminal: "ghostty",
      tmux_session: "codex-worker-open",
    });
    assert.deepEqual(calls, [["tmux", "has-session", "-t", "codex-worker-open"]]);
    assert.equal(existsSync(eventsPath(name, { cwd: root, env: {} })), false);

    writeFileSync(eventsPath(name, { cwd: root, env: {} }), `${JSON.stringify({
      terminal: "ghostty",
      time: "2026-06-04T01:00:00Z",
      type: "open_attempt",
    })}\n`);
    const guarded = runTypescriptRuntimeCommand({
      args: ["open", name, "--terminal", "ghostty", "--dry-run"],
      cwd: root,
      env: {},
      tmuxRunner: runner,
    });
    assert.equal(guarded.exitCode, 1);
    assert.match(guarded.stderr ?? "", /terminal launch attempted/);
    assert.match(guarded.stderr ?? "", /--force/);

    const forced = runTypescriptRuntimeCommand({
      args: ["open", name, "--terminal", "ghostty", "--dry-run", "--force"],
      cwd: root,
      env: {},
      tmuxRunner: runner,
    });
    assert.equal(forced.exitCode, 0, forced.stderr);
    const forcedPayload = JSON.parse(forced.stdout ?? "{}") as { force: boolean };
    assert.equal(forcedPayload.force, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("TypeScript runtime handles open-worker and open-manager dry-run from session binding", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-ts-open-session."));
  const calls: string[][] = [];
  const runner: TmuxRunner = (args) => {
    calls.push(args);
    if (
      args.join(" ") === "tmux has-session -t codex-open-worker"
      || args.join(" ") === "tmux has-session -t codex-open-manager"
    ) {
      return { status: 0, stdout: "" };
    }
    return { status: 1, stderr: "unexpected tmux command" };
  };
  try {
    const dbPath = join(root, "workerctl.db");
    const database = openDatabaseSync(dbPath);
    try {
      initializeDatabaseSync(database);
      createTaskSync(database, {
        goal: "Open the bound terminals.",
        name: "task-open",
        taskId: "task-open-id",
      });
      insertSession(database, {
        id: "session-worker-open",
        name: "open-worker-session",
        role: "worker",
        tmuxSession: "codex-open-worker",
      });
      insertSession(database, {
        id: "session-manager-open",
        name: "open-manager-session",
        role: "manager",
        tmuxSession: "codex-open-manager",
      });
      bindSessionsSync(database, {
        bindingId: "binding-open",
        managerSessionName: "open-manager-session",
        taskName: "task-open",
        workerSessionName: "open-worker-session",
      });
    } finally {
      database.close();
    }

    const worker = runTypescriptRuntimeCommand({
      args: ["open-worker", "task-open", "--terminal", "terminal", "--dry-run", "--path", dbPath],
      cwd: root,
      env: {},
      tmuxRunner: runner,
    });
    assert.equal(worker.exitCode, 0, worker.stderr);
    assert.deepEqual(JSON.parse(worker.stdout ?? "{}"), {
      attach_command: "tmux attach -t codex-open-worker",
      command: [
        "osascript",
        "-e",
        "tell application \"Terminal\" to activate",
        "-e",
        "tell application \"Terminal\" to do script \"tmux attach -t codex-open-worker\"",
      ],
      dry_run: true,
      task: "task-open",
      terminal: "terminal",
      tmux_session: "codex-open-worker",
      worker: "open-worker-session",
    });

    const manager = runTypescriptRuntimeCommand({
      args: ["open-manager", "task-open", "--terminal", "terminal", "--dry-run", "--path", dbPath],
      cwd: root,
      env: {},
      tmuxRunner: runner,
    });
    assert.equal(manager.exitCode, 0, manager.stderr);
    assert.deepEqual(JSON.parse(manager.stdout ?? "{}"), {
      attach_command: "tmux attach -t codex-open-manager",
      command: [
        "osascript",
        "-e",
        "tell application \"Terminal\" to activate",
        "-e",
        "tell application \"Terminal\" to do script \"tmux attach -t codex-open-manager\"",
      ],
      dry_run: true,
      manager: "open-manager-session",
      task: "task-open",
      terminal: "terminal",
      tmux_session: "codex-open-manager",
    });
    assert.deepEqual(calls, [
      ["tmux", "has-session", "-t", "codex-open-worker"],
      ["tmux", "has-session", "-t", "codex-open-manager"],
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("TypeScript runtime handles legacy stop with optional message and compatibility events", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-ts-stop-legacy."));
  const calls: string[][] = [];
  const runningSessions = new Set(["codex-stop-legacy"]);
  const runner: TmuxRunner = (args) => {
    calls.push(args);
    if (args[0] === "tmux" && args[1] === "has-session") {
      const target = args.at(-1) ?? "";
      return { status: runningSessions.has(target) ? 0 : 1, stderr: "no session" };
    }
    return { status: 0, stdout: "" };
  };
  try {
    const name = "stop-legacy";
    mkdirSync(join(root, ".codex-workers", name), { recursive: true });
    writeFileSync(configPath(name, { cwd: root, env: {} }), `${JSON.stringify({
      name,
      tmux_session: "codex-stop-legacy",
    })}\n`);

    const stopped = runTypescriptRuntimeCommand({
      args: ["stop", name, "--message", "wrap it up"],
      cwd: root,
      env: {},
      tmuxRunner: runner,
    });
    assert.equal(stopped.exitCode, 0, stopped.stderr);
    assert.equal(stopped.handled, true);
    assert.equal(stopped.stdout, "stopped stop-legacy\n");
    assert.deepEqual(calls, [
      ["tmux", "has-session", "-t", "codex-stop-legacy"],
      ["tmux", "has-session", "-t", "codex-stop-legacy"],
      ["tmux", "set-buffer", "-b", "workerctl-stop-legacy", "wrap it up"],
      ["tmux", "paste-buffer", "-b", "workerctl-stop-legacy", "-t", "codex-stop-legacy"],
      ["tmux", "send-keys", "-t", "codex-stop-legacy", "C-m"],
      ["tmux", "delete-buffer", "-b", "workerctl-stop-legacy"],
      ["tmux", "has-session", "-t", "codex-stop-legacy"],
      ["tmux", "kill-session", "-t", "codex-stop-legacy"],
    ]);
    const legacyEvents = readFileSync(eventsPath(name, { cwd: root, env: {} }), "utf8")
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.deepEqual(legacyEvents.map((event) => event.type), ["stop_message", "stop"]);
    assert.equal(legacyEvents[0].message, "wrap it up");
    assert.equal(legacyEvents[1].killed_session, true);

    const idleName = "stop-idle";
    mkdirSync(join(root, ".codex-workers", idleName), { recursive: true });
    writeFileSync(configPath(idleName, { cwd: root, env: {} }), `${JSON.stringify({
      name: idleName,
      tmux_session: "codex-stop-idle",
    })}\n`);
    calls.length = 0;
    const idle = runTypescriptRuntimeCommand({
      args: ["stop", idleName],
      cwd: root,
      env: {},
      tmuxRunner: runner,
    });
    assert.equal(idle.exitCode, 0, idle.stderr);
    assert.equal(idle.stdout, "stop-idle was not running\n");
    assert.deepEqual(calls, [["tmux", "has-session", "-t", "codex-stop-idle"]]);
    const idleEvents = readFileSync(eventsPath(idleName, { cwd: root, env: {} }), "utf8")
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.deepEqual(idleEvents, [{ killed_session: false, time: idleEvents[0].time, type: "stop" }]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("TypeScript runtime handles session-backed stop and marks the registered session gone", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-ts-stop-session."));
  const calls: string[][] = [];
  const runner: TmuxRunner = (args) => {
    calls.push(args);
    if (args.join(" ") === "tmux has-session -t manager-stop-tmux") {
      return { status: 0, stdout: "" };
    }
    if (args.join(" ") === "tmux kill-session -t manager-stop-tmux") {
      return { status: 0, stdout: "" };
    }
    return { status: 1, stderr: "unexpected tmux command" };
  };
  try {
    const dbPath = defaultDbPath({ cwd: root, env: {} });
    const database = openDatabaseSync(dbPath);
    try {
      initializeDatabaseSync(database);
      insertSession(database, {
        id: "session-stop-manager",
        name: "session-stop-manager",
        role: "manager",
        tmuxPaneId: "%9",
        tmuxSession: "manager-stop-tmux",
      });
    } finally {
      database.close();
    }

    const stopped = runTypescriptRuntimeCommand({
      args: ["stop", "session-stop-manager"],
      cwd: root,
      env: {},
      now: () => new Date("2026-06-04T12:34:56.000Z"),
      tmuxRunner: runner,
    });
    assert.equal(stopped.exitCode, 0, stopped.stderr);
    assert.equal(stopped.handled, true);
    assert.equal(stopped.stdout, "stopped session-stop-manager\n");
    assert.deepEqual(calls, [
      ["tmux", "has-session", "-t", "manager-stop-tmux"],
      ["tmux", "kill-session", "-t", "manager-stop-tmux"],
    ]);

    const after = openDatabaseSync(dbPath);
    try {
      const session = after.prepare("select state, last_heartbeat_at from sessions where name = ?")
        .get("session-stop-manager") as { last_heartbeat_at: string; state: string };
      assert.equal(session.state, "gone");
      assert.equal(session.last_heartbeat_at, "2026-06-04T12:34:56Z");
      const event = after.prepare("select payload_json from events where type = 'session_stopped'")
        .get() as { payload_json: string };
      assert.deepEqual(JSON.parse(event.payload_json), {
        killed_session: true,
        role: "manager",
        session: "session-stop-manager",
        target: "manager-stop-tmux",
      });
    } finally {
      after.close();
    }
    const compatibilityEvents = readFileSync(eventsPath("session-stop-manager", { cwd: root, env: {} }), "utf8")
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.deepEqual(compatibilityEvents, [{
      killed_session: true,
      lookup_source: "session",
      role: "manager",
      target: "manager-stop-tmux",
      time: compatibilityEvents[0].time,
      type: "stop",
    }]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("TypeScript runtime pair dry-run keeps Python default dispatch and accepts json", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-ts-pair-dry-run."));
  try {
    const dbPath = join(root, "workerctl.db");
    const result = runTypescriptRuntimeCommand({
      args: [
        "pair",
        "--task",
        "pair-task",
        "--worker-name",
        "pair-worker",
        "--manager-name",
        "pair-manager",
        "--path",
        dbPath,
        "--dry-run",
        "--json",
      ],
      env: {},
    });

    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(result.handled, true);
    const payload = JSON.parse(result.stdout ?? "{}") as {
      dispatch_command: string[];
      ensure_dispatch: boolean;
      manager: string;
      task: string;
      worker: string;
    };
    assert.equal(payload.ensure_dispatch, true);
    assert.equal(payload.manager, "pair-manager");
    assert.equal(payload.task, "pair-task");
    assert.equal(payload.worker, "pair-worker");
    assert.deepEqual(payload.dispatch_command.slice(0, 4), [
      join(process.cwd(), "scripts", "workerctl"),
      "dispatch",
      "--watch",
      "--dispatcher-id",
    ]);
    assert.ok(payload.dispatch_command.includes("dispatch-pair"));
    assert.ok(payload.dispatch_command.includes(dbPath));

    const withoutDispatch = runTypescriptRuntimeCommand({
      args: [
        "pair",
        "--task",
        "pair-task",
        "--worker-name",
        "pair-worker",
        "--manager-name",
        "pair-manager",
        "--path",
        dbPath,
        "--dry-run",
        "--no-dispatch",
      ],
      env: {},
    });
    assert.equal(withoutDispatch.exitCode, 0, withoutDispatch.stderr);
    const withoutDispatchPayload = JSON.parse(withoutDispatch.stdout ?? "{}") as {
      dispatch_command: string[] | null;
      ensure_dispatch: boolean;
    };
    assert.equal(withoutDispatchPayload.ensure_dispatch, false);
    assert.equal(withoutDispatchPayload.dispatch_command, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("TypeScript runtime handles pair spawn bind run and dispatch with fake runners", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-ts-pair."));
  const calls: string[][] = [];
  const dispatches: Array<{ command: string[]; cwd: string }> = [];
  const runner: TmuxRunner = (args) => {
    calls.push(args);
    if (args.join(" ") === "tmux has-session -t codex-pair-worker") {
      return { status: 1, stderr: "no worker session" };
    }
    if (args.join(" ") === "tmux has-session -t codex-pair-manager") {
      return { status: 1, stderr: "no manager session" };
    }
    return { status: 0, stdout: "" };
  };
  try {
    const dbPath = join(root, "workerctl.db");
    const rolloutDir = join(root, ".codex", "sessions", "2026");
    mkdirSync(rolloutDir, { recursive: true });
    const workerRollout = join(rolloutDir, "rollout-worker.jsonl");
    const managerRollout = join(rolloutDir, "rollout-manager.jsonl");
    writeFileSync(workerRollout, `${JSON.stringify({
      payload: { cwd: "/repo", id: "codex-worker", originator: "codex-tui" },
      type: "session_meta",
    })}\n`);
    writeFileSync(managerRollout, `${JSON.stringify({
      payload: { cwd: "/repo", id: "codex-manager", originator: "codex-tui" },
      type: "session_meta",
    })}\n`);

    const result = runTypescriptRuntimeCommand({
      args: [
        "pair",
        "--task",
        "pair-task",
        "--worker-name",
        "pair-worker",
        "--manager-name",
        "pair-manager",
        "--task-goal",
        "Build a thing",
        "--task-prompt",
        "Do the worker part",
        "--manager-permit",
        "verification.run_pytest",
        "--manager-tool",
        "verification.run_tests",
        "--manager-tool",
        "verification.run_tests",
        "--manager-epilogue",
        "draft-pr",
        "--manager-epilogue",
        "draft-pr",
        "--manager-nudge-on-completion",
        "auto-proceed",
        "--manager-require-acks",
        "--manager-allow-pr",
        "--manager-allow-merge-green",
        "--manager-allow-worker-compact-clear",
        "--manager-permissions-json",
        JSON.stringify({ context: ["fetch_prs"], "repo.push_branch": true }),
        "--dispatcher-id",
        "dispatch-pair-test",
        "--cwd",
        "/repo",
        "--path",
        dbPath,
        "--timeout-seconds",
        "9",
        "--accept-trust",
      ],
      codexCommandResolver: () => "codex",
      cwd: root,
      discoverSpawnedCodexSession: (options) => {
        assert.equal(options.acceptTrust, true);
        assert.equal(options.timeoutSeconds, 9);
        if (options.tmuxSessionName === "codex-pair-worker") {
          return {
            codex_session_id: "codex-worker",
            codex_session_path: workerRollout,
            cwd: "/repo",
            native_pid: 11111,
            originator: "codex-tui",
          };
        }
        assert.equal(options.tmuxSessionName, "codex-pair-manager");
        return {
          codex_session_id: "codex-manager",
          codex_session_path: managerRollout,
          cwd: "/repo",
          native_pid: 22222,
          originator: "codex-tui",
        };
      },
      dispatchRunner: (command: string[], options: { cwd: string }) => {
        dispatches.push({ command, cwd: options.cwd });
        return { pid: 33333 };
      },
      env: {},
      tmuxRunner: runner,
    });

    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(result.handled, true);
    const payload = JSON.parse(result.stdout ?? "{}") as {
      binding_id: string;
      dispatch: { command: string[]; ensure: boolean; pid: number; started: boolean };
      dispatch_command: string[];
      ensure_dispatch: boolean;
      manager: { name: string; pid: number; role: string; tmux_session: string };
      manager_config_seeded: boolean;
      manager_config_seeded_by_pair: boolean;
      run_id: string;
      task: { created: boolean; id: string; name: string };
      worker: { name: string; pid: number; role: string; tmux_session: string };
    };
    assert.equal(payload.task.name, "pair-task");
    assert.equal(payload.task.created, true);
    assert.match(payload.task.id, /^task-/);
    assert.equal(payload.worker.name, "pair-worker");
    assert.equal(payload.worker.role, "worker");
    assert.equal(payload.worker.pid, 11111);
    assert.equal(payload.worker.tmux_session, "codex-pair-worker");
    assert.equal(payload.manager.name, "pair-manager");
    assert.equal(payload.manager.role, "manager");
    assert.equal(payload.manager.pid, 22222);
    assert.equal(payload.manager.tmux_session, "codex-pair-manager");
    assert.match(payload.binding_id, /^binding-/);
    assert.match(payload.run_id, /^run-/);
    assert.equal(payload.manager_config_seeded, true);
    assert.equal(payload.manager_config_seeded_by_pair, true);
    assert.equal(payload.ensure_dispatch, true);
    assert.equal(payload.dispatch.ensure, true);
    assert.equal(payload.dispatch.started, true);
    assert.equal(payload.dispatch.pid, 33333);
    assert.deepEqual(payload.dispatch.command, payload.dispatch_command);
    assert.deepEqual(dispatches, [{
      command: payload.dispatch_command,
      cwd: process.cwd(),
    }]);
    assert.deepEqual(payload.dispatch_command.slice(0, 4), [
      join(process.cwd(), "scripts", "workerctl"),
      "dispatch",
      "--watch",
      "--dispatcher-id",
    ]);
    assert.ok(payload.dispatch_command.includes("dispatch-pair-test"));
    assert.ok(payload.dispatch_command.includes("--path"));
    assert.ok(payload.dispatch_command.includes(dbPath));

    assert.deepEqual(calls.filter((args) => args[0] === "tmux" && args[1] === "send-keys"), [
      ["tmux", "send-keys", "-t", "codex-pair-worker", "Enter"],
      ["tmux", "send-keys", "-t", "codex-pair-manager", "Enter"],
    ]);
    const workerShell = calls.find((args) => args[1] === "new-session" && args.includes("codex-pair-worker"))?.at(-1) ?? "";
    const managerShell = calls.find((args) => args[1] === "new-session" && args.includes("codex-pair-manager"))?.at(-1) ?? "";
    assert.match(workerShell, /Do the worker part/);
    assert.match(workerShell, /worker-ack pair-task --from-stdin/);
    assert.match(managerShell, /You are a Codex manager session/);
    assert.match(managerShell, /Task: pair-task/);
    assert.match(managerShell, /Task goal: Build a thing/);
    assert.match(managerShell, /Worker session: pair-worker/);
    assert.match(managerShell, /Manager config has already been recorded/);

    const database = openDatabaseSync(dbPath);
    try {
      const task = database.prepare("select id, name, goal from tasks where name = ?")
        .get("pair-task") as { goal: string; id: string; name: string };
      assert.equal(task.id, payload.task.id);
      assert.equal(task.goal, "Build a thing");
      const binding = database.prepare("select task_id, state from bindings where id = ?")
        .get(payload.binding_id) as { state: string; task_id: string };
      assert.equal(binding.task_id, payload.task.id);
      assert.equal(binding.state, "active");
      const run = database.prepare("select task_id, status, metadata_json from runs where id = ?")
        .get(payload.run_id) as { metadata_json: string; status: string; task_id: string };
      assert.equal(run.task_id, payload.task.id);
      assert.equal(run.status, "active");
      assert.deepEqual(JSON.parse(run.metadata_json), {
        binding_id: payload.binding_id,
        manager: "pair-manager",
        manager_config_seeded: true,
        manager_config_seeded_by_pair: true,
        source: "pair",
        worker: "pair-worker",
      });
      const managerConfig = database.prepare(`
        select permissions_json, tools_json, epilogues_json, nudge_on_completion, require_acks
        from manager_configs
        where task_id = ?
      `).get(payload.task.id) as {
        epilogues_json: string;
        nudge_on_completion: string;
        permissions_json: string;
        require_acks: number;
        tools_json: string;
      };
      assert.deepEqual(JSON.parse(managerConfig.permissions_json), {
        communication: [],
        context: ["fetch_prs"],
        repo: ["merge_green_pr", "open_pr", "push_branch"],
        verification: ["run_pytest"],
        worker_session: ["clear", "compact"],
      });
      assert.deepEqual(JSON.parse(managerConfig.tools_json), ["verification.run_tests"]);
      assert.deepEqual(JSON.parse(managerConfig.epilogues_json), ["draft-pr"]);
      assert.equal(managerConfig.nudge_on_completion, "auto-proceed");
      assert.equal(managerConfig.require_acks, 1);
      const eventTypes = database.prepare("select event_type from telemetry_events where task_id = ? order by rowid")
        .all(payload.task.id)
        .map((row) => (row as { event_type: string }).event_type);
      assert.deepEqual(eventTypes, [
        "pair_started",
        "pair_task_resolved",
        "pair_manager_config_seeded",
        "pair_worker_spawned",
        "pair_manager_spawned",
        "pair_binding_created",
        "pair_run_created",
      ]);
    } finally {
      database.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("TypeScript runtime records pair failure telemetry after partial spawn", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-ts-pair-failure."));
  const calls: string[][] = [];
  const runner: TmuxRunner = (args) => {
    calls.push(args);
    if (args.join(" ") === "tmux has-session -t codex-pair-worker") {
      return { status: 1, stderr: "no worker session" };
    }
    if (args.join(" ") === "tmux has-session -t codex-pair-manager") {
      return { status: 1, stderr: "no manager session" };
    }
    return { status: 0, stdout: "" };
  };
  try {
    const dbPath = join(root, "workerctl.db");
    const rolloutDir = join(root, ".codex", "sessions", "2026");
    mkdirSync(rolloutDir, { recursive: true });
    const workerRollout = join(rolloutDir, "rollout-worker.jsonl");
    writeFileSync(workerRollout, `${JSON.stringify({
      payload: { cwd: "/repo", id: "codex-worker", originator: "codex-tui" },
      type: "session_meta",
    })}\n`);

    const result = runTypescriptRuntimeCommand({
      args: [
        "pair",
        "--task",
        "pair-task",
        "--worker-name",
        "pair-worker",
        "--manager-name",
        "pair-manager",
        "--task-goal",
        "Build a thing",
        "--cwd",
        "/repo",
        "--path",
        dbPath,
      ],
      codexCommandResolver: () => "codex",
      cwd: root,
      discoverSpawnedCodexSession: (options) => {
        assert.equal(options.timeoutSeconds, 60);
        if (options.tmuxSessionName === "codex-pair-worker") {
          return {
            codex_session_id: "codex-worker",
            codex_session_path: workerRollout,
            cwd: "/repo",
            native_pid: 11111,
            originator: "codex-tui",
          };
        }
        throw new Error("manager rollout did not appear");
      },
      env: {},
      tmuxRunner: runner,
    });

    assert.equal(result.exitCode, 1);
    assert.match(result.stderr ?? "", /manager rollout did not appear/);
    assert.equal(calls.filter((args) => args[1] === "new-session").length, 2);

    const database = openDatabaseSync(dbPath);
    try {
      const task = database.prepare("select id from tasks where name = ?").get("pair-task") as { id: string };
      const sessions = database.prepare("select name, role from sessions order by registered_at")
        .all() as Array<{ name: string; role: string }>;
      assert.deepEqual(sessions.map((session) => `${session.role}:${session.name}`), ["worker:pair-worker"]);
      const events = database.prepare(`
        select event_type, severity, attributes_json
        from telemetry_events
        where task_id = ?
        order by rowid
      `).all(task.id) as Array<{ attributes_json: string; event_type: string; severity: string }>;
      assert.deepEqual(events.map((event) => event.event_type), [
        "pair_started",
        "pair_task_resolved",
        "pair_manager_config_seeded",
        "pair_worker_spawned",
        "pair_failed",
      ]);
      const failure = events.at(-1);
      const failureAttributes = JSON.parse(failure?.attributes_json ?? "{}") as Record<string, unknown>;
      assert.equal(failure?.severity, "error");
      assert.deepEqual(failureAttributes, {
        binding_created: false,
        error: failureAttributes.error,
        error_type: "Error",
        manager_spawned: false,
        run_created: false,
        worker_spawned: true,
      });
      assert.match(String(failureAttributes.error), /manager rollout did not appear/);
    } finally {
      database.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("TypeScript runtime pair reuses a recent matching dispatch heartbeat", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-ts-pair-heartbeat."));
  const calls: string[][] = [];
  const dispatches: string[][] = [];
  const runner: TmuxRunner = (args) => {
    calls.push(args);
    if (args.join(" ") === "tmux has-session -t codex-pair-worker") {
      return { status: 1, stderr: "no worker session" };
    }
    if (args.join(" ") === "tmux has-session -t codex-pair-manager") {
      return { status: 1, stderr: "no manager session" };
    }
    return { status: 0, stdout: "" };
  };
  try {
    const dbPath = join(root, "workerctl.db");
    const rolloutDir = join(root, ".codex", "sessions", "2026");
    mkdirSync(rolloutDir, { recursive: true });
    const workerRollout = join(rolloutDir, "rollout-worker.jsonl");
    const managerRollout = join(rolloutDir, "rollout-manager.jsonl");
    writeFileSync(workerRollout, `${JSON.stringify({
      payload: { cwd: "/repo", id: "codex-worker", originator: "codex-tui" },
      type: "session_meta",
    })}\n`);
    writeFileSync(managerRollout, `${JSON.stringify({
      payload: { cwd: "/repo", id: "codex-manager", originator: "codex-tui" },
      type: "session_meta",
    })}\n`);

    const database = openDatabaseSync(dbPath);
    try {
      initializeDatabaseSync(database);
      database.prepare(`
        insert into telemetry_events(
          id, run_id, task_id, timestamp, actor, event_type, severity,
          summary, correlation_json, attributes_json
        )
        values (?, null, null, ?, 'dispatch', 'dispatch_watch_heartbeat', 'info', ?, ?, ?)
      `).run(
        "heartbeat-pair",
        "2026-06-04T12:00:00.000Z",
        "Dispatch watch heartbeat.",
        JSON.stringify({ dispatcher_id: "dispatch-pair-test", iteration: 12 }),
        JSON.stringify({ dry_run: false, processed_count: 0 }),
      );
      database.prepare(`
        insert into telemetry_events(
          id, run_id, task_id, timestamp, actor, event_type, severity,
          summary, correlation_json, attributes_json
        )
        values (?, null, null, ?, 'dispatch', 'dispatch_watch_heartbeat', 'info', ?, ?, ?)
      `).run(
        "heartbeat-other",
        "2026-06-04T12:00:04.000Z",
        "Dispatch watch heartbeat.",
        JSON.stringify({ dispatcher_id: "other-dispatcher", iteration: 99 }),
        JSON.stringify({ dry_run: false, processed_count: 0 }),
      );
    } finally {
      database.close();
    }

    const result = runTypescriptRuntimeCommand({
      args: [
        "pair",
        "--task",
        "pair-task",
        "--worker-name",
        "pair-worker",
        "--manager-name",
        "pair-manager",
        "--task-goal",
        "Build a thing",
        "--dispatcher-id",
        "dispatch-pair-test",
        "--cwd",
        "/repo",
        "--path",
        dbPath,
      ],
      codexCommandResolver: () => "codex",
      cwd: root,
      discoverSpawnedCodexSession: (options) => {
        if (options.tmuxSessionName === "codex-pair-worker") {
          return {
            codex_session_id: "codex-worker",
            codex_session_path: workerRollout,
            cwd: "/repo",
            native_pid: 11111,
            originator: "codex-tui",
          };
        }
        return {
          codex_session_id: "codex-manager",
          codex_session_path: managerRollout,
          cwd: "/repo",
          native_pid: 22222,
          originator: "codex-tui",
        };
      },
      dispatchRunner: (command) => {
        dispatches.push(command);
        return { pid: 33333 };
      },
      env: {},
      now: () => new Date("2026-06-04T12:00:05.000Z"),
      tmuxRunner: runner,
    });

    assert.equal(result.exitCode, 0, result.stderr);
    const payload = JSON.parse(result.stdout ?? "{}") as {
      dispatch: { ensure: boolean; pid: number | null; started: boolean };
      ensure_dispatch: boolean;
    };
    assert.equal(payload.ensure_dispatch, true);
    assert.equal(payload.dispatch.ensure, true);
    assert.equal(payload.dispatch.started, false);
    assert.equal(payload.dispatch.pid, null);
    assert.deepEqual(dispatches, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("TypeScript runtime default start-worker discovery polls process tree before register", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-ts-start-discovery."));
  const calls: string[][] = [];
  let lsofAttempts = 0;
  const runner: TmuxRunner = (args) => {
    calls.push(args);
    if (args.join(" ") === "tmux has-session -t codex-poll-worker") {
      return { status: 1, stderr: "no session" };
    }
    if (args.join(" ") === "tmux list-panes -t codex-poll-worker -F #{pane_pid}") {
      return { status: 0, stdout: "101\n" };
    }
    return { status: 0, stdout: "" };
  };
  try {
    const dbPath = join(root, "workerctl.db");
    const rolloutDir = join(root, ".codex", "sessions", "2026");
    mkdirSync(rolloutDir, { recursive: true });
    const rollout = join(rolloutDir, "rollout-polled.jsonl");
    writeFileSync(rollout, `${JSON.stringify({
      payload: {
        cwd: "/repo",
        id: "cuid-polled",
        originator: "codex-tui",
        timestamp: "2026-06-04T14:00:05.000Z",
      },
      type: "session_meta",
    })}\n`);

    const result = runTypescriptRuntimeCommand({
      args: [
        "start-worker",
        "--name",
        "poll-worker",
        "--cwd",
        "/repo",
        "--task",
        "Poll work",
        "--timeout-seconds",
        "1",
        "--path",
        dbPath,
      ],
      childrenForPid: (pid) => (pid === 101 ? [202] : []),
      cwd: root,
      env: {},
      lsofForPid: (pid) => {
        if (pid !== 202) {
          throw new Error(`no rollout for ${pid}`);
        }
        lsofAttempts += 1;
        if (lsofAttempts === 1) {
          throw new Error("native process has not opened rollout yet");
        }
        return `codex ${pid} neon txt REG 1,2 3 4 ${rollout}\n`;
      },
      now: () => new Date("2026-06-04T14:00:00.000Z"),
      sleepMilliseconds: () => {},
      tmuxRunner: runner,
    });

    assert.equal(result.exitCode, 0, result.stderr);
    const payload = JSON.parse(result.stdout ?? "{}") as { codex_session_id: string; name: string; pid: number };
    assert.equal(payload.name, "poll-worker");
    assert.equal(payload.pid, 202);
    assert.equal(payload.codex_session_id, "cuid-polled");
    assert.equal(lsofAttempts, 2);
    assert.deepEqual(calls[0], ["tmux", "has-session", "-t", "codex-poll-worker"]);
    assert.deepEqual(calls[1].slice(0, 7), ["tmux", "new-session", "-d", "-s", "codex-poll-worker", "-c", "/repo"]);
    assert.deepEqual(calls[2], ["tmux", "list-panes", "-t", "codex-poll-worker", "-F", "#{pane_pid}"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("TypeScript runtime refuses start-worker duplicate session before tmux spawn", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-ts-start-duplicate."));
  const calls: string[][] = [];
  const runner: TmuxRunner = (args) => {
    calls.push(args);
    return { status: 0, stdout: "" };
  };
  try {
    const dbPath = join(root, "workerctl.db");
    const database = openDatabaseSync(dbPath);
    try {
      initializeDatabaseSync(database);
      insertSession(database, {
        id: "session-taken-id",
        name: "taken",
        role: "worker",
      });
    } finally {
      database.close();
    }

    const result = runTypescriptRuntimeCommand({
      args: ["start-worker", "--name", "taken", "--path", dbPath],
      cwd: root,
      env: {},
      tmuxRunner: runner,
    });

    assert.equal(result.exitCode, 1);
    assert.match(result.stderr ?? "", /a session named "taken" is already registered/);
    assert.deepEqual(calls, []);
    const after = openDatabaseSync(dbPath);
    try {
      const eventCount = after.prepare("select count(*) as count from events where type = 'session_registered'")
        .get() as { count: number };
      assert.equal(eventCount.count, 0);
    } finally {
      after.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("TypeScript runtime handles classify ingest and tail by default", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-ts-ingest."));
  try {
    mkdirSync(join(root, ".codex-workers"));
    const rolloutDir = join(root, ".codex", "sessions", "2026");
    mkdirSync(rolloutDir, { recursive: true });
    const rollout = join(rolloutDir, "rollout-tail.jsonl");
    writeFileSync(rollout, [
      JSON.stringify({
        payload: { cli_version: "1.2.3", cwd: root, id: "codex-tail", originator: "codex" },
        timestamp: "2026-06-04T12:00:00Z",
        type: "session_meta",
      }),
      "{not-json}",
      JSON.stringify({
        payload: {
          message: "hello\nthere",
          nested: { content: "" },
          output: "screen",
          type: "user_message",
        },
        timestamp: "2026-06-04T12:01:00Z",
        type: "event_msg",
      }),
      JSON.stringify({
        payload: { text: "model line\n", type: "assistant_message" },
        timestamp: "2026-06-04T12:02:00Z",
        type: "response_item",
      }),
      JSON.stringify({
        payload: { content: "complete", type: "task_complete" },
        timestamp: "2026-06-04T12:03:00Z",
        type: "event_msg",
      }),
    ].join("\n") + "\n");

    const classified = runTypescriptRuntimeCommand({
      args: ["classify", "--text", "OpenAI Codex\n›"],
      cwd: root,
      env: {},
    });
    assert.equal(classified.exitCode, 0);
    assert.equal(classified.handled, true);
    assert.deepEqual(JSON.parse(classified.stdout ?? "{}"), {
      busy_wait: null,
      busy_wait_seconds: 90,
      startup: "ready",
      startup_reason: "Codex input prompt is visible",
      status_age_seconds: 90,
    });

    const classifyInput = join(root, "capture.txt");
    writeFileSync(classifyInput, "Starting MCP servers\n");
    const classifiedFile = runTypescriptRuntimeCommand({
      args: ["classify", "--file", classifyInput, "--status-age-seconds", "120", "--busy-wait-seconds", "60"],
      cwd: root,
      env: {},
    });
    const classifiedFilePayload = JSON.parse(classifiedFile.stdout ?? "{}") as {
      busy_wait: { pattern: string; recommended_action: string } | null;
      startup: string;
    };
    assert.equal(classifiedFile.exitCode, 0);
    assert.equal(classifiedFilePayload.startup, "starting");
    assert.deepEqual(classifiedFilePayload.busy_wait, {
      pattern: "mcp_startup",
      reason: "terminal shows Codex waiting on MCP server startup",
      recommended_action: "inspect_or_interrupt",
    });

    assert.deepEqual(
      runTypescriptRuntimeCommand({
        args: ["classify"],
        cwd: root,
        env: {},
      }),
      { exitCode: 0, handled: false },
    );

    const registered = runTypescriptRuntimeCommand({
      args: [
        "register-worker",
        "--name",
        "worker-tail",
        "--pid",
        "789",
        "--codex-session",
        rollout,
      ],
      cwd: root,
      env: {},
    });
    assert.equal(registered.exitCode, 0);

    const ingested = runTypescriptRuntimeCommand({
      args: ["ingest", "worker-tail"],
      cwd: root,
      env: {},
    });
    assert.equal(ingested.exitCode, 0);
    assert.equal(ingested.handled, true);
    const ingestPayload = JSON.parse(ingested.stdout ?? "{}") as {
      new_events: number;
      new_offset: number;
      session: string;
      skipped_lines: number;
    };
    assert.equal(ingestPayload.session, "worker-tail");
    assert.equal(ingestPayload.new_events, 4);
    assert.equal(ingestPayload.skipped_lines, 1);
    assert.ok(ingestPayload.new_offset > 0);

    const redactedTail = runTypescriptRuntimeCommand({
      args: ["tail", "worker-tail", "--subtype", "user_message", "--limit", "10"],
      cwd: root,
      env: {},
    });
    assert.equal(redactedTail.exitCode, 0);
    assert.equal(redactedTail.handled, true);
    const redactedEvents = JSON.parse(redactedTail.stdout ?? "[]") as Array<{
      payload: Record<string, unknown>;
      subtype: string;
    }>;
    assert.equal(redactedEvents.length, 1);
    assert.equal(redactedEvents[0].subtype, "user_message");
    assert.deepEqual(redactedEvents[0].payload, {
      message_byte_count: 11,
      message_line_count: 2,
      message_redacted: true,
      nested: {
        content_byte_count: 0,
        content_line_count: 0,
        content_redacted: true,
      },
      output_byte_count: 6,
      output_line_count: 1,
      output_redacted: true,
      type: "user_message",
    });

    const rawTail = runTypescriptRuntimeCommand({
      args: ["tail", "worker-tail", "--limit", "2", "--include-content"],
      cwd: root,
      env: {},
    });
    assert.equal(rawTail.exitCode, 0);
    const rawEvents = JSON.parse(rawTail.stdout ?? "[]") as Array<{
      byte_offset: number;
      payload: Record<string, unknown>;
      subtype: string | null;
      type: string;
    }>;
    assert.deepEqual(rawEvents.map((event) => event.subtype), ["task_complete", null]);
    assert.deepEqual(rawEvents.map((event) => event.type), ["event_msg", "response_item"]);
    assert.equal(rawEvents[0].payload.content, "complete");
    assert.equal(rawEvents[1].payload.text, "model line\n");
    assert.ok(rawEvents[0].byte_offset > rawEvents[1].byte_offset);

    const dbPath = defaultDbPath({ cwd: root, env: {} });
    const database = openDatabaseSync(dbPath);
    try {
      const telemetry = database.prepare(`
        select event_type, correlation_json, attributes_json
        from telemetry_events
        where event_type = 'codex_events_tail_read'
        order by timestamp desc
        limit 1
      `).get() as { attributes_json: string; correlation_json: string; event_type: string };
      assert.equal(telemetry.event_type, "codex_events_tail_read");
      assert.deepEqual(JSON.parse(telemetry.correlation_json), {
        session: "worker-tail",
        session_id: JSON.parse(registered.stdout ?? "{}").session_id,
      });
      assert.deepEqual(JSON.parse(telemetry.attributes_json), {
        limit: 2,
        returned_count: 2,
        subtype: null,
      });
    } finally {
      database.close();
    }

    assert.deepEqual(
      runTypescriptRuntimeCommand({
        args: ["ingest", "worker-tail", "--path", dbPath],
        cwd: root,
        env: {},
      }),
      { exitCode: 0, handled: false },
    );
    assert.deepEqual(
      runTypescriptRuntimeCommand({
        args: ["tail", "worker-tail", "--path", dbPath],
        cwd: root,
        env: {},
      }),
      { exitCode: 0, handled: false },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("TypeScript runtime handles events update-status and transcript commands by default", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-ts-events."));
  try {
    mkdirSync(join(root, ".codex-workers"));
    mkdirSync(join(root, ".codex-workers", "worker-status"), { recursive: true });
    writeFileSync(configPath("worker-status", { cwd: root, env: {} }), `${JSON.stringify({
      cwd: "/repo",
      identity_token: "worker-token",
      tmux_pane_id: "%1",
      tmux_session: "codex-worker-status",
    }, null, 2)}\n`);

    const updated = runTypescriptRuntimeCommand({
      args: [
        "update-status",
        "worker-status",
        "--state",
        "editing",
        "--current-task",
        "Port deterministic commands.",
        "--next-action",
        "Run transcript tests.",
        "--blocker",
        "none",
      ],
      cwd: root,
      env: {},
    });
    assert.equal(updated.exitCode, 0);
    assert.equal(updated.handled, true);
    const updatedPayload = JSON.parse(updated.stdout ?? "{}") as {
      blocker: string;
      current_task: string;
      last_update: string;
      next_action: string;
      state: string;
    };
    assert.deepEqual(
      {
        blocker: updatedPayload.blocker,
        current_task: updatedPayload.current_task,
        next_action: updatedPayload.next_action,
        state: updatedPayload.state,
      },
      {
        blocker: "none",
        current_task: "Port deterministic commands.",
        next_action: "Run transcript tests.",
        state: "editing",
      },
    );
    assert.match(updatedPayload.last_update, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    assert.deepEqual(JSON.parse(readFileSync(statusPath("worker-status", { cwd: root, env: {} }), "utf8")), updatedPayload);

    writeFileSync(eventsPath("worker-status", { cwd: root, env: {} }), "{bad-json}\n", { flag: "a" });
    writeFileSync(
      eventsPath("worker-status", { cwd: root, env: {} }),
      `${JSON.stringify({ time: "2026-06-04T12:00:00Z", type: "note", value: 1 })}\n`,
      { flag: "a" },
    );
    const events = runTypescriptRuntimeCommand({
      args: ["events", "worker-status", "--type", "status_updated", "--limit", "1"],
      cwd: root,
      env: {},
    });
    assert.equal(events.exitCode, 0);
    assert.equal(events.handled, true);
    assert.equal(events.stderr, "workerctl: 1 malformed event line(s) skipped\n");
    const eventLines = (events.stdout ?? "").trim().split("\n");
    assert.equal(eventLines.length, 1);
    assert.deepEqual(JSON.parse(eventLines[0]), {
      blocker: "none",
      current_task: "Port deterministic commands.",
      next_action: "Run transcript tests.",
      state: "editing",
      time: updatedPayload.last_update,
      type: "status_updated",
    });

    const dbPath = defaultDbPath({ cwd: root, env: {} });
    const database = openDatabaseSync(dbPath);
    try {
      const worker = database.prepare("select id, cwd, tmux_session, tmux_pane_id, identity_token, state from workers where name = ?")
        .get("worker-status") as {
          cwd: string;
          id: string;
          identity_token: string;
          state: string;
          tmux_pane_id: string;
          tmux_session: string;
        };
      assert.equal(worker.cwd, "/repo");
      assert.equal(worker.tmux_session, "codex-worker-status");
      assert.equal(worker.tmux_pane_id, "%1");
      assert.equal(worker.identity_token, "worker-token");
      assert.equal(worker.state, "active");
      const status = database.prepare("select state, current_task, next_action, blocker from statuses where worker_id = ?")
        .get(worker.id) as {
          blocker: string;
          current_task: string;
          next_action: string;
          state: string;
        };
      assert.deepEqual(Object.fromEntries(Object.entries(status)), {
        blocker: "none",
        current_task: "Port deterministic commands.",
        next_action: "Run transcript tests.",
        state: "editing",
      });

      createTaskSync(database, {
        goal: "Exercise transcript commands.",
        name: "transcript-task",
        now: "2026-06-04T12:00:00Z",
        taskId: "task-transcript",
      });
      const captureWorker1 = insertTerminalCapture(database, "task-transcript", "worker", "2026-06-04T12:01:00Z", "old\nworker");
      const captureWorker2 = insertTerminalCapture(database, "task-transcript", "worker", "2026-06-04T12:02:00Z", "new\nworker\n");
      const captureManager = insertTerminalCapture(database, "task-transcript", "manager", "2026-06-04T12:03:00Z", "manager");
      insertTranscriptSegment(database, {
        capturedAt: "2026-06-04T12:01:00Z",
        role: "worker",
        segmentId: captureWorker1,
        text: "old\nworker",
      });
      insertTranscriptSegment(database, {
        capturedAt: "2026-06-04T12:02:00Z",
        role: "worker",
        segmentId: captureWorker2,
        text: "new\nworker\n",
      });
      insertTranscriptSegment(database, {
        capturedAt: "2026-06-04T12:03:00Z",
        role: "manager",
        segmentId: captureManager,
        text: null,
      });
    } finally {
      database.close();
    }

    const transcriptJson = runTypescriptRuntimeCommand({
      args: ["transcript-show", "transcript-task", "--json"],
      cwd: root,
      env: {},
    });
    assert.equal(transcriptJson.exitCode, 0);
    const transcriptPayload = JSON.parse(transcriptJson.stdout ?? "{}") as {
      segments: Array<Record<string, unknown>>;
      task: { id: string; name: string; state: string };
    };
    assert.deepEqual(transcriptPayload.task, {
      id: "task-transcript",
      name: "transcript-task",
      state: "candidate",
    });
    assert.deepEqual(
      transcriptPayload.segments.map((segment) => ({
        byteCount: segment.segment_text_byte_count,
        hasText: Object.hasOwn(segment, "segment_text"),
        lineCount: segment.segment_text_line_count,
        redacted: segment.segment_text_redacted,
        role: segment.role,
      })),
      [
        { byteCount: 10, hasText: false, lineCount: 2, redacted: true, role: "worker" },
        { byteCount: 11, hasText: false, lineCount: 2, redacted: true, role: "worker" },
        { byteCount: undefined, hasText: false, lineCount: undefined, redacted: undefined, role: "manager" },
      ],
    );

    const transcriptText = runTypescriptRuntimeCommand({
      args: ["transcript-show", "transcript-task", "--role", "worker", "--limit", "1"],
      cwd: root,
      env: {},
    });
    assert.equal(transcriptText.exitCode, 0);
    assert.match(transcriptText.stdout ?? "", /worker transcript segment 2 12:02:00/);
    assert.match(transcriptText.stdout ?? "", /\[content redacted: 2 lines, 11 bytes\]/);

    const transcriptRaw = runTypescriptRuntimeCommand({
      args: ["transcript-show", "transcript-task", "--role", "worker", "--limit", "1", "--json", "--include-content"],
      cwd: root,
      env: {},
    });
    const rawPayload = JSON.parse(transcriptRaw.stdout ?? "{}") as { segments: Array<{ segment_text: string }> };
    assert.equal(rawPayload.segments[0].segment_text, "new\nworker\n");

    const dryPrune = runTypescriptRuntimeCommand({
      args: ["transcript-prune", "transcript-task", "--keep-latest", "1", "--dry-run"],
      cwd: root,
      env: {},
    });
    assert.deepEqual(JSON.parse(dryPrune.stdout ?? "{}"), {
      dry_run: true,
      keep_latest: 1,
      pruned_count: 0,
      would_prune_count: 1,
    });

    const pruned = runTypescriptRuntimeCommand({
      args: ["transcript-prune", "transcript-task", "--keep-latest", "1"],
      cwd: root,
      env: {},
    });
    assert.deepEqual(JSON.parse(pruned.stdout ?? "{}"), {
      dry_run: false,
      keep_latest: 1,
      pruned_count: 1,
      would_prune_count: 1,
    });
    const afterPrune = openDatabaseSync(dbPath);
    try {
      const prunedSegment = afterPrune.prepare("select segment_text, retention_class, segment_kind from transcript_segments where id = 1")
        .get() as { retention_class: string; segment_kind: string; segment_text: string | null };
      assert.deepEqual(Object.fromEntries(Object.entries(prunedSegment)), {
        retention_class: "cold",
        segment_kind: "metadata",
        segment_text: null,
      });
      const event = afterPrune.prepare("select task_id, payload_json from events where type = 'transcript_segments_pruned'")
        .get() as { payload_json: string; task_id: string };
      assert.equal(event.task_id, "task-transcript");
      assert.deepEqual(JSON.parse(event.payload_json), { keep_latest: 1, segment_ids: [1] });
    } finally {
      afterPrune.close();
    }

    assert.deepEqual(
      runTypescriptRuntimeCommand({
        args: ["transcript-prune", "transcript-task", "--role", "all"],
        cwd: root,
        env: {},
      }),
      { exitCode: 0, handled: false },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("TypeScript runtime handles live finish-task stop and strict decisions with fake tmux", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-ts-lifecycle-live."));
  const calls: string[][] = [];
  const runner: TmuxRunner = (args) => {
    calls.push(args);
    const command = args.join(" ");
    if (command === "tmux has-session -t session-live-worker" || command === "tmux has-session -t session-live-manager") {
      return { status: 0, stdout: "" };
    }
    if (command === "tmux list-panes -t session-live-worker -F #{pane_id}") {
      return { status: 0, stdout: "%11\n" };
    }
    if (command === "tmux list-panes -t session-live-manager -F #{pane_id}") {
      return { status: 0, stdout: "%22\n" };
    }
    if (command === "tmux capture-pane -p -t session-live-worker -S -33") {
      return { status: 0, stdout: "worker before stop\nmore worker\n" };
    }
    if (command === "tmux capture-pane -p -t session-live-manager -S -33") {
      return { status: 0, stdout: "manager before stop\nmore manager\n" };
    }
    if (command === "tmux set-buffer -b workerctl-session-live-worker final note") {
      return { status: 0, stdout: "" };
    }
    if (command === "tmux paste-buffer -b workerctl-session-live-worker -t session-live-worker:%11") {
      return { status: 0, stdout: "" };
    }
    if (command === "tmux send-keys -t session-live-worker:%11 C-m") {
      return { status: 0, stdout: "" };
    }
    if (command === "tmux delete-buffer -b workerctl-session-live-worker") {
      return { status: 0, stdout: "" };
    }
    if (command === "tmux kill-session -t session-live-worker" || command === "tmux kill-session -t session-live-manager") {
      return { status: 0, stdout: "" };
    }
    return { status: 1, stderr: `unexpected tmux command: ${command}` };
  };
  try {
    const dbPath = join(root, "workerctl.db");
    const database = openDatabaseSync(dbPath);
    let decisionId: number;
    try {
      initializeDatabaseSync(database);
      const taskId = createTaskSync(database, {
        goal: "Finish with live cleanup.",
        name: "live-finish",
        now: "2026-06-04T13:00:00Z",
        taskId: "task-live-finish",
      });
      insertSession(database, {
        id: "session-live-worker-id",
        name: "live-worker",
        role: "worker",
        tmuxPaneId: "%11",
        tmuxSession: "session-live-worker",
      });
      insertSession(database, {
        id: "session-live-manager-id",
        name: "live-manager",
        role: "manager",
        tmuxPaneId: "%22",
        tmuxSession: "session-live-manager",
      });
      bindSessionsSync(database, {
        bindingId: "binding-live-finish",
        managerSessionName: "live-manager",
        taskName: "live-finish",
        workerSessionName: "live-worker",
      });
      const decision = database.prepare(`
        insert into manager_decisions(task_id, manager_id, manager_cycle_id, decision, reason, created_at, payload_json)
        values (?, null, null, 'stop', 'Approved stop.', ?, '{}')
      `).run(taskId, new Date().toISOString());
      decisionId = Number(decision.lastInsertRowid);
    } finally {
      database.close();
    }

    const result = runTypescriptRuntimeCommand({
      args: [
        "finish-task",
        "live-finish",
        "--stop-manager",
        "--stop-worker",
        "--message",
        "final note",
        "--capture-transcript-before-stop",
        "--capture-transcript-lines",
        "33",
        "--require-transcript-segment",
        "--decision-id",
        String(decisionId),
        "--strict-decisions",
        "--reason",
        "Live cleanup complete.",
        "--path",
        dbPath,
      ],
      cwd: root,
      env: {},
      tmuxRunner: runner,
    });

    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(result.handled, true);
    const payload = JSON.parse(result.stdout ?? "{}") as {
      killed_manager: boolean;
      killed_worker: boolean;
      manager_decision: { ok: boolean; warnings: string[] };
      manager_session: string;
      pre_stop_transcript_captures: Array<{ role: string; transcript_segment: { line_count: number } | null }>;
      stop_manager: boolean;
      stop_worker: boolean;
      worker_session: string;
    };
    assert.equal(payload.stop_manager, true);
    assert.equal(payload.stop_worker, true);
    assert.equal(payload.killed_manager, true);
    assert.equal(payload.killed_worker, true);
    assert.equal(payload.worker_session, "live-worker");
    assert.equal(payload.manager_session, "live-manager");
    assert.equal(payload.manager_decision.ok, true);
    assert.deepEqual(payload.manager_decision.warnings, []);
    assert.deepEqual(
      payload.pre_stop_transcript_captures.map((capture) => ({
        line_count: capture.transcript_segment?.line_count,
        role: capture.role,
      })),
      [
        { line_count: 2, role: "worker" },
        { line_count: 2, role: "manager" },
      ],
    );
    assert.deepEqual(calls, [
      ["tmux", "has-session", "-t", "session-live-worker"],
      ["tmux", "list-panes", "-t", "session-live-worker", "-F", "#{pane_id}"],
      ["tmux", "capture-pane", "-p", "-t", "session-live-worker", "-S", "-33"],
      ["tmux", "has-session", "-t", "session-live-manager"],
      ["tmux", "list-panes", "-t", "session-live-manager", "-F", "#{pane_id}"],
      ["tmux", "capture-pane", "-p", "-t", "session-live-manager", "-S", "-33"],
      ["tmux", "has-session", "-t", "session-live-worker"],
      ["tmux", "set-buffer", "-b", "workerctl-session-live-worker", "final note"],
      ["tmux", "paste-buffer", "-b", "workerctl-session-live-worker", "-t", "session-live-worker:%11"],
      ["tmux", "send-keys", "-t", "session-live-worker:%11", "C-m"],
      ["tmux", "delete-buffer", "-b", "workerctl-session-live-worker"],
      ["tmux", "kill-session", "-t", "session-live-worker"],
      ["tmux", "kill-session", "-t", "session-live-manager"],
    ]);

    const after = openDatabaseSync(dbPath);
    try {
      const states = after.prepare("select name, state from sessions order by name")
        .all() as Array<{ name: string; state: string }>;
      assert.deepEqual(states.map((state) => ({ ...state })), [
        { name: "live-manager", state: "gone" },
        { name: "live-worker", state: "gone" },
      ]);
      const task = after.prepare("select state from tasks where name = 'live-finish'")
        .get() as { state: string };
      assert.equal(task.state, "done");
      const captureCount = after.prepare("select count(*) as count from terminal_captures where task_id = 'task-live-finish'")
        .get() as { count: number };
      assert.equal(captureCount.count, 2);
      const eventTypes = after.prepare("select type from events where task_id = 'task-live-finish' order by id")
        .all() as Array<{ type: string }>;
      assert.ok(eventTypes.some((event) => event.type === "finish_task_pre_stop_transcript_captured"));
      assert.ok(eventTypes.some((event) => event.type === "finish_task_succeeded"));
    } finally {
      after.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("TypeScript runtime records failed live lifecycle side effects without completing task", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-ts-lifecycle-fail."));
  const calls: string[][] = [];
  const runner: TmuxRunner = (args) => {
    calls.push(args);
    if (args.join(" ") === "tmux kill-session -t session-fail-manager") {
      return { status: 1, stderr: "manager still busy" };
    }
    return { status: 0, stdout: "" };
  };
  try {
    const dbPath = join(root, "workerctl.db");
    const database = openDatabaseSync(dbPath);
    try {
      initializeDatabaseSync(database);
      createTaskSync(database, {
        goal: "Stay active if stop side effects fail.",
        name: "fail-stop",
        taskId: "task-fail-stop",
      });
      insertSession(database, {
        id: "session-fail-worker-id",
        name: "fail-worker",
        role: "worker",
      });
      insertSession(database, {
        id: "session-fail-manager-id",
        name: "fail-manager",
        role: "manager",
        tmuxSession: "session-fail-manager",
      });
      bindSessionsSync(database, {
        bindingId: "binding-fail-stop",
        managerSessionName: "fail-manager",
        taskName: "fail-stop",
        workerSessionName: "fail-worker",
      });
    } finally {
      database.close();
    }

    const result = runTypescriptRuntimeCommand({
      args: ["stop-task", "fail-stop", "--reason", "Stop failed live manager.", "--path", dbPath],
      cwd: root,
      env: {},
      tmuxRunner: runner,
    });

    assert.equal(result.exitCode, 1);
    assert.match(result.stderr ?? "", /tmux kill-session -t session-fail-manager failed: manager still busy/);
    assert.deepEqual(calls, [
      ["tmux", "kill-session", "-t", "session-fail-manager"],
    ]);

    const after = openDatabaseSync(dbPath);
    try {
      const task = after.prepare("select state from tasks where name = 'fail-stop'")
        .get() as { state: string };
      assert.equal(task.state, "candidate");
      const binding = after.prepare("select state from bindings where id = 'binding-fail-stop'")
        .get() as { state: string };
      assert.equal(binding.state, "active");
      const managerSession = after.prepare("select state from sessions where name = 'fail-manager'")
        .get() as { state: string };
      assert.equal(managerSession.state, "active");
      const command = after.prepare(`
        select state, result_json, error
        from commands
        where task_id = 'task-fail-stop'
      `).get() as { error: string; result_json: string; state: string };
      assert.equal(command.state, "failed");
      assert.match(command.error, /tmux kill-session -t session-fail-manager failed: manager still busy/);
      const commandResult = JSON.parse(command.result_json) as {
        expected_failure: boolean;
        failure_stage: string;
        stop_manager: boolean;
        stop_worker: boolean;
      };
      assert.equal(commandResult.expected_failure, true);
      assert.equal(commandResult.failure_stage, "live_lifecycle_side_effects");
      assert.equal(commandResult.stop_manager, true);
      assert.equal(commandResult.stop_worker, false);
      const failedEvent = after.prepare("select payload_json from events where type = 'stop_task_failed'")
        .get() as { payload_json: string };
      const failedPayload = JSON.parse(failedEvent.payload_json) as { failure_stage: string };
      assert.equal(failedPayload.failure_stage, "live_lifecycle_side_effects");
    } finally {
      after.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("TypeScript runtime rejects strict stop-task decision before mutating state", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-ts-lifecycle-strict."));
  const calls: string[][] = [];
  const runner: TmuxRunner = (args) => {
    calls.push(args);
    return { status: 0, stdout: "" };
  };
  try {
    const dbPath = join(root, "workerctl.db");
    const database = openDatabaseSync(dbPath);
    try {
      initializeDatabaseSync(database);
      createTaskSync(database, {
        goal: "Reject missing strict decision.",
        name: "strict-stop",
        taskId: "task-strict-stop",
      });
      insertSession(database, {
        id: "session-strict-worker-id",
        name: "strict-worker",
        role: "worker",
        tmuxSession: "session-strict-worker",
      });
      insertSession(database, {
        id: "session-strict-manager-id",
        name: "strict-manager",
        role: "manager",
        tmuxSession: "session-strict-manager",
      });
      bindSessionsSync(database, {
        bindingId: "binding-strict-stop",
        managerSessionName: "strict-manager",
        taskName: "strict-stop",
        workerSessionName: "strict-worker",
      });
    } finally {
      database.close();
    }

    const result = runTypescriptRuntimeCommand({
      args: ["stop-task", "strict-stop", "--strict-decisions", "--path", dbPath],
      cwd: root,
      env: {},
      tmuxRunner: runner,
    });

    assert.equal(result.exitCode, 1);
    assert.match(result.stderr ?? "", /strict manager decision validation failed/);
    assert.deepEqual(calls, []);
    const after = openDatabaseSync(dbPath);
    try {
      const task = after.prepare("select state from tasks where name = 'strict-stop'")
        .get() as { state: string };
      assert.equal(task.state, "candidate");
      const commandCount = after.prepare("select count(*) as count from commands")
        .get() as { count: number };
      assert.equal(commandCount.count, 0);
      const binding = after.prepare("select state from bindings where id = 'binding-strict-stop'")
        .get() as { state: string };
      assert.equal(binding.state, "active");
    } finally {
      after.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("TypeScript runtime handles live capture status and idle-check with a fake tmux runner", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-ts-live."));
  const calls: string[][] = [];
  const runner: TmuxRunner = (args) => {
    calls.push(args);
    const command = args.join(" ");
    if (command === "tmux has-session -t codex-worker-live") {
      return { status: 0, stdout: "" };
    }
    if (command === "tmux capture-pane -p -S -42 -t codex-worker-live") {
      return { status: 0, stdout: "OpenAI Codex\nPress enter to confirm\n" };
    }
    if (command === "tmux list-panes -t codex-worker-live -F #{pane_id}") {
      return { status: 0, stdout: "%1\n" };
    }
    if (command === "tmux has-session -t custom-session") {
      return { status: 0, stdout: "" };
    }
    if (command === "tmux capture-pane -p -S -5 -t custom-session") {
      return { status: 0, stdout: "session output\n" };
    }
    if (command === "tmux list-panes -t custom-session -F #{pane_id}") {
      return { status: 0, stdout: "%9\n" };
    }
    return { status: 1, stderr: `unexpected tmux command: ${command}` };
  };
  const now = () => new Date("2026-06-04T12:10:00Z");
  try {
    mkdirSync(join(root, ".codex-workers", "worker-live"), { recursive: true });
    writeFileSync(configPath("worker-live", { cwd: root, env: {} }), `${JSON.stringify({
      cwd: "/repo",
      identity_token: "worker-token",
      startup: "ready",
      startup_reason: "Codex input prompt is visible",
      startup_recommended_action: "none",
      tmux_session: "codex-worker-live",
    }, null, 2)}\n`);
    writeFileSync(statusPath("worker-live", { cwd: root, env: {} }), `${JSON.stringify({
      blocker: null,
      current_task: "Watch terminal.",
      last_update: "2026-06-04T12:00:00Z",
      next_action: "Respond if prompted.",
      state: "editing",
    }, null, 2)}\n`);

    const captured = runTypescriptRuntimeCommand({
      args: ["capture", "worker-live", "--lines", "42"],
      cwd: root,
      env: {},
      now,
      tmuxRunner: runner,
    });
    assert.equal(captured.exitCode, 0);
    assert.equal(captured.handled, true);
    const output = "OpenAI Codex\nPress enter to confirm";
    assert.deepEqual(JSON.parse(captured.stdout ?? "{}"), {
      byte_count: Buffer.byteLength(output),
      content_redacted: true,
      history_lines: 42,
      line_count: 2,
      name: "worker-live",
      sha256: createHash("sha256").update(output).digest("hex"),
      transcript_path: join(root, ".codex-workers", "worker-live", "transcript.txt"),
    });
    assert.equal(readFileSync(join(root, ".codex-workers", "worker-live", "transcript.txt"), "utf8"), `${output}\n`);
    assert.deepEqual(JSON.parse(readFileSync(join(root, ".codex-workers", "worker-live", "capture-meta.json"), "utf8")), {
      captured_at: "2026-06-04T12:10:00Z",
      changed_at: "2026-06-04T12:10:00Z",
      history_lines: 42,
      sha256: createHash("sha256").update(output).digest("hex"),
    });
    assert.deepEqual(calls.slice(0, 3), [
      ["tmux", "has-session", "-t", "codex-worker-live"],
      ["tmux", "capture-pane", "-p", "-S", "-42", "-t", "codex-worker-live"],
      ["tmux", "list-panes", "-t", "codex-worker-live", "-F", "#{pane_id}"],
    ]);

    const database = openDatabaseSync(defaultDbPath({ cwd: root, env: {} }));
    try {
      const capture = database.prepare(`
        select transcript_captures.content, transcript_captures.capture_kind,
               transcript_captures.history_lines, transcript_captures.line_count,
               workers.tmux_pane_id
        from transcript_captures
        join workers on workers.id = transcript_captures.worker_id
      `).get() as {
        capture_kind: string;
        content: string;
        history_lines: number;
        line_count: number;
        tmux_pane_id: string;
      };
      assert.deepEqual(Object.fromEntries(Object.entries(capture)), {
        capture_kind: "changed",
        content: output,
        history_lines: 42,
        line_count: 2,
        tmux_pane_id: "%1",
      });
    } finally {
      database.close();
    }

    const callCountBeforeStatus = calls.length;
    const status = runTypescriptRuntimeCommand({
      args: ["status", "worker-live", "--no-refresh"],
      cwd: root,
      env: {},
      now,
      tmuxRunner: runner,
    });
    assert.equal(status.exitCode, 0);
    const statusPayload = JSON.parse(status.stdout ?? "{}") as Record<string, unknown>;
    assert.deepEqual(statusPayload, {
      blocker: null,
      current_task: "Watch terminal.",
      name: "worker-live",
      next_action: "Respond if prompted.",
      running: true,
      startup: "ready",
      startup_reason: "Codex input prompt is visible",
      startup_recommended_action: "none",
      state: "editing",
      status_last_update: "2026-06-04T12:00:00Z",
      terminal_capture_error: null,
      terminal_captured_at: "2026-06-04T12:10:00Z",
      terminal_changed_at: "2026-06-04T12:10:00Z",
      tmux_session: "codex-worker-live",
    });
    assert.deepEqual(calls.slice(callCountBeforeStatus), [
      ["tmux", "has-session", "-t", "codex-worker-live"],
    ]);

    const idle = runTypescriptRuntimeCommand({
      args: [
        "idle-check",
        "worker-live",
        "--no-refresh",
        "--lines",
        "42",
        "--status-stale-seconds",
        "60",
        "--terminal-stale-seconds",
        "60",
        "--busy-wait-seconds",
        "60",
      ],
      cwd: root,
      env: {},
      now,
      tmuxRunner: runner,
    });
    const idlePayload = JSON.parse(idle.stdout ?? "{}") as Record<string, unknown>;
    assert.deepEqual(
      {
        busy_wait_pattern: idlePayload.busy_wait_pattern,
        health: idlePayload.health,
        reason: idlePayload.reason,
        recommended_action: idlePayload.recommended_action,
        running: idlePayload.running,
        status_age_seconds: idlePayload.status_age_seconds,
        terminal_age_seconds: idlePayload.terminal_age_seconds,
        terminal_fresh: idlePayload.terminal_fresh,
      },
      {
        busy_wait_pattern: "enter_to_confirm",
        health: "busy_wait",
        reason: "terminal is waiting for Enter confirmation",
        recommended_action: "inspect_or_confirm",
        running: true,
        status_age_seconds: 600,
        terminal_age_seconds: 0,
        terminal_fresh: true,
      },
    );

    const sessionDb = openDatabaseSync(defaultDbPath({ cwd: root, env: {} }));
    try {
      insertSession(sessionDb, {
        id: "session-live-id",
        name: "session-live",
        role: "worker",
        tmuxSession: "custom-session",
      });
    } finally {
      sessionDb.close();
    }
    const callCountBeforeSessionCapture = calls.length;
    const sessionCapture = runTypescriptRuntimeCommand({
      args: ["capture", "session-live", "--lines", "5", "--include-content"],
      cwd: root,
      env: {},
      now,
      tmuxRunner: runner,
    });
    assert.equal(sessionCapture.stdout, "session output\n");
    assert.deepEqual(calls.slice(callCountBeforeSessionCapture, callCountBeforeSessionCapture + 3), [
      ["tmux", "has-session", "-t", "custom-session"],
      ["tmux", "capture-pane", "-p", "-S", "-5", "-t", "custom-session"],
      ["tmux", "list-panes", "-t", "custom-session", "-F", "#{pane_id}"],
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("TypeScript runtime captures session-bound worker transcript segments with fake tmux", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-ts-transcript-capture."));
  const dbPath = join(root, "workerctl.db");
  const calls: string[][] = [];
  const workerOutputs = [
    "line one\nline two",
    "line one\nline two",
    "line one\nline two\nline three",
    "line one\nline two\nline three",
    "line one\nline two\nline three\nline four",
  ];
  const managerOutputs = [
    "manager line one\nmanager line two",
    "manager line one\nmanager line two\nmanager line three",
  ];
  const runner: TmuxRunner = (args) => {
    calls.push(args);
    const command = args.join(" ");
    if (command === "tmux has-session -t session-worker" || command === "tmux has-session -t session-manager") {
      return { status: 0, stdout: "" };
    }
    if (command === "tmux list-panes -t session-worker -F #{pane_id}") {
      return { status: 0, stdout: "%1\n" };
    }
    if (command === "tmux list-panes -t session-manager -F #{pane_id}") {
      return { status: 0, stdout: "%2\n" };
    }
    if (command === "tmux capture-pane -p -t session-worker -S -80") {
      return { status: 0, stdout: workerOutputs.shift() ?? "" };
    }
    if (command === "tmux capture-pane -p -t session-manager -S -80") {
      return { status: 0, stdout: managerOutputs.shift() ?? "" };
    }
    return { status: 1, stderr: `unexpected tmux command: ${command}` };
  };
  const now = () => new Date("2026-06-04T12:30:00Z");
  try {
    const database = openDatabaseSync(dbPath);
    try {
      initializeDatabaseSync(database);
      createTaskSync(database, {
        goal: "Capture transcript evidence.",
        name: "capture-task",
        now: "2026-06-04T12:00:00Z",
        taskId: "task-capture",
      });
      insertSession(database, {
        id: "session-worker-capture",
        name: "worker-capture",
        role: "worker",
        tmuxPaneId: "%1",
        tmuxSession: "session-worker",
      });
      insertSession(database, {
        id: "session-manager-capture",
        name: "manager-capture",
        role: "manager",
        tmuxPaneId: "%2",
        tmuxSession: "session-manager",
      });
      bindSessionsSync(database, {
        bindingId: "binding-capture",
        managerSessionName: "manager-capture",
        now: "2026-06-04T12:00:30Z",
        taskName: "capture-task",
        workerSessionName: "worker-capture",
      });
    } finally {
      database.close();
    }

    const first = runTypescriptRuntimeCommand({
      args: ["transcript-capture", "capture-task", "--role", "worker", "--json", "--path", dbPath, "--lines", "80"],
      env: {},
      now,
      tmuxRunner: runner,
    });
    assert.equal(first.exitCode, 0);
    assert.equal(first.handled, true);
    const firstPayload = JSON.parse(first.stdout ?? "{}") as {
      captures: Array<{
        capture: Record<string, unknown>;
        transcript_segment: Record<string, unknown>;
        worker: Record<string, unknown>;
      }>;
    };
    assert.equal(firstPayload.captures[0]?.capture.output, undefined);
    assert.equal(firstPayload.captures[0]?.capture.output_redacted, true);
    assert.equal(firstPayload.captures[0]?.capture.output_line_count, 2);
    assert.equal(firstPayload.captures[0]?.transcript_segment.segment_kind, "reset");
    assert.equal(firstPayload.captures[0]?.transcript_segment.line_count, 2);
    assert.equal(firstPayload.captures[0]?.worker.tmux_pane_id, "%1");

    const duplicate = runTypescriptRuntimeCommand({
      args: ["transcript-capture", "capture-task", "--role", "worker", "--json", "--path", dbPath, "--lines", "80"],
      env: {},
      now,
      tmuxRunner: runner,
    });
    assert.equal(duplicate.exitCode, 0);
    assert.equal(JSON.parse(duplicate.stdout ?? "{}").captures[0].transcript_segment, null);

    const appended = runTypescriptRuntimeCommand({
      args: [
        "transcript-capture",
        "capture-task",
        "--role",
        "worker",
        "--json",
        "--include-content",
        "--path",
        dbPath,
        "--lines",
        "80",
      ],
      env: {},
      now,
      tmuxRunner: runner,
    });
    assert.equal(appended.exitCode, 0);
    const appendedPayload = JSON.parse(appended.stdout ?? "{}") as {
      captures: Array<{ capture: Record<string, unknown>; transcript_segment: Record<string, unknown> }>;
    };
    assert.equal(appendedPayload.captures[0]?.capture.output, "line one\nline two\nline three");
    assert.equal(appendedPayload.captures[0]?.transcript_segment.segment_kind, "segment");
    assert.equal(appendedPayload.captures[0]?.transcript_segment.line_count, 1);

    const required = runTypescriptRuntimeCommand({
      args: [
        "transcript-capture",
        "capture-task",
        "--role",
        "worker",
        "--json",
        "--require-segment",
        "--path",
        dbPath,
        "--lines",
        "80",
      ],
      env: {},
      now,
      tmuxRunner: runner,
    });
    assert.equal(required.exitCode, 2);
    assert.match(required.stderr ?? "", /no non-empty transcript segment captured for role\(s\): worker/);

    const managerCapture = runTypescriptRuntimeCommand({
      args: ["transcript-capture", "capture-task", "--role", "manager", "--json", "--path", dbPath, "--lines", "80"],
      env: {},
      now,
      tmuxRunner: runner,
    });
    assert.equal(managerCapture.exitCode, 0);
    const managerPayload = JSON.parse(managerCapture.stdout ?? "{}") as {
      captures: Array<{ manager: Record<string, unknown>; transcript_segment: Record<string, unknown> }>;
    };
    assert.equal(managerPayload.captures[0]?.manager.tmux_pane_id, "%2");
    assert.equal(managerPayload.captures[0]?.transcript_segment.segment_kind, "reset");

    const allText = runTypescriptRuntimeCommand({
      args: ["transcript-capture", "capture-task", "--role", "all", "--path", dbPath, "--lines", "80"],
      env: {},
      now,
      tmuxRunner: runner,
    });
    assert.equal(allText.exitCode, 0);
    assert.match(allText.stdout ?? "", /worker: capture \d+ segment \d+ \(segment, 1 lines\)/);
    assert.match(allText.stdout ?? "", /manager: capture \d+ segment \d+ \(segment, 1 lines\)/);

    assert.deepEqual(calls, [
      ["tmux", "has-session", "-t", "session-worker"],
      ["tmux", "list-panes", "-t", "session-worker", "-F", "#{pane_id}"],
      ["tmux", "capture-pane", "-p", "-t", "session-worker", "-S", "-80"],
      ["tmux", "has-session", "-t", "session-worker"],
      ["tmux", "list-panes", "-t", "session-worker", "-F", "#{pane_id}"],
      ["tmux", "capture-pane", "-p", "-t", "session-worker", "-S", "-80"],
      ["tmux", "has-session", "-t", "session-worker"],
      ["tmux", "list-panes", "-t", "session-worker", "-F", "#{pane_id}"],
      ["tmux", "capture-pane", "-p", "-t", "session-worker", "-S", "-80"],
      ["tmux", "has-session", "-t", "session-worker"],
      ["tmux", "list-panes", "-t", "session-worker", "-F", "#{pane_id}"],
      ["tmux", "capture-pane", "-p", "-t", "session-worker", "-S", "-80"],
      ["tmux", "has-session", "-t", "session-manager"],
      ["tmux", "list-panes", "-t", "session-manager", "-F", "#{pane_id}"],
      ["tmux", "capture-pane", "-p", "-t", "session-manager", "-S", "-80"],
      ["tmux", "has-session", "-t", "session-worker"],
      ["tmux", "list-panes", "-t", "session-worker", "-F", "#{pane_id}"],
      ["tmux", "capture-pane", "-p", "-t", "session-worker", "-S", "-80"],
      ["tmux", "has-session", "-t", "session-manager"],
      ["tmux", "list-panes", "-t", "session-manager", "-F", "#{pane_id}"],
      ["tmux", "capture-pane", "-p", "-t", "session-manager", "-S", "-80"],
    ]);

    const verifyDb = openDatabaseSync(dbPath);
    try {
      const segmentRows = verifyDb.prepare(`
        select segment_kind, segment_text from transcript_segments order by id
      `).all() as Array<{ segment_kind: string; segment_text: string | null }>;
      assert.deepEqual(segmentRows.map((row) => Object.fromEntries(Object.entries(row))), [
        { segment_kind: "reset", segment_text: "line one\nline two" },
        { segment_kind: "segment", segment_text: "line three" },
        { segment_kind: "reset", segment_text: "manager line one\nmanager line two" },
        { segment_kind: "segment", segment_text: "line four" },
        { segment_kind: "segment", segment_text: "manager line three" },
      ]);
      const telemetryRows = verifyDb.prepare(`
        select event_type from telemetry_events order by id
      `).all() as Array<{ event_type: string }>;
      assert.equal(telemetryRows.filter((row) => row.event_type === "terminal_capture_recorded").length, 7);
      assert.equal(telemetryRows.filter((row) => row.event_type === "transcript_segment_recorded").length, 5);
      const observation = verifyDb.prepare(`
        select count(*) as count from agent_observations where observation_type = 'capture'
      `).get() as { count: number };
      assert.equal(observation.count, 7);
    } finally {
      verifyDb.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("TypeScript runtime captures legacy worker and manager transcript paths with fake tmux", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-ts-transcript-legacy."));
  const dbPath = join(root, "workerctl.db");
  const stateRoot = join(root, "state");
  const env = { WORKERCTL_STATE_ROOT: stateRoot };
  const calls: string[][] = [];
  const runner: TmuxRunner = (args) => {
    calls.push(args);
    const command = args.join(" ");
    if (command === "tmux has-session -t codex-legacy-worker" || command === "tmux has-session -t codex-legacy-manager") {
      return { status: 0, stdout: "" };
    }
    if (command === "tmux list-panes -t codex-legacy-worker -F #{pane_id}") {
      return { status: 0, stdout: "%10\n" };
    }
    if (command === "tmux list-panes -t codex-legacy-manager -F #{pane_id}") {
      return { status: 0, stdout: "%20\n" };
    }
    if (command === "tmux capture-pane -p -S -80 -t codex-legacy-worker") {
      return { status: 0, stdout: "legacy worker line\nlegacy worker next\n" };
    }
    if (command === "tmux capture-pane -p -t codex-legacy-manager -S -80") {
      return { status: 0, stdout: "legacy manager line\nlegacy manager next" };
    }
    return { status: 1, stderr: `unexpected tmux command: ${command}` };
  };
  const now = () => new Date("2026-06-04T13:00:00Z");
  try {
    mkdirSync(join(stateRoot, "legacy-worker"), { recursive: true });
    writeFileSync(configPath("legacy-worker", { env }), `${JSON.stringify({
      cwd: root,
      identity_token: "token-legacy-worker",
      tmux_pane_id: "%10",
      tmux_session: "codex-legacy-worker",
    }, null, 2)}\n`);

    const database = openDatabaseSync(dbPath);
    try {
      initializeDatabaseSync(database);
      createTaskSync(database, {
        goal: "Capture legacy transcript evidence.",
        name: "legacy-task",
        now: "2026-06-04T12:50:00Z",
        taskId: "task-legacy",
      });
      insertLegacyWorker(database, {
        identityToken: "token-legacy-worker",
        name: "legacy-worker",
        paneId: "%10",
        workerId: "worker-legacy-id",
      });
      insertLegacyManager(database, {
        managerId: "manager-legacy-id",
        name: "legacy-manager",
        paneId: "%20",
        taskId: "task-legacy",
      });
      database.prepare(`
        insert into bindings(id, task_id, worker_id, manager_id, state, created_at)
        values ('binding-legacy', 'task-legacy', 'worker-legacy-id', 'manager-legacy-id', 'active', '2026-06-04T12:51:00Z')
      `).run();
    } finally {
      database.close();
    }

    const result = runTypescriptRuntimeCommand({
      args: ["transcript-capture", "legacy-task", "--role", "all", "--json", "--include-content", "--path", dbPath, "--lines", "80"],
      env,
      now,
      tmuxRunner: runner,
    });

    assert.equal(result.exitCode, 0);
    assert.equal(result.handled, true);
    const payload = JSON.parse(result.stdout ?? "{}") as {
      captures: Array<{
        binding_id: string | null;
        capture: Record<string, unknown>;
        manager?: Record<string, unknown>;
        role: "manager" | "worker";
        transcript_segment: Record<string, unknown>;
        worker?: Record<string, unknown>;
      }>;
    };
    const workerCapture = payload.captures.find((capture) => capture.role === "worker");
    const managerCapture = payload.captures.find((capture) => capture.role === "manager");
    assert.equal(workerCapture?.binding_id, "binding-legacy");
    assert.equal(workerCapture?.worker?.id, "worker-legacy-id");
    assert.equal(workerCapture?.worker?.tmux_pane_id, "%10");
    assert.equal(workerCapture?.capture.output, "legacy worker line\nlegacy worker next");
    assert.equal(workerCapture?.transcript_segment.segment_kind, "reset");
    assert.equal(managerCapture?.manager?.id, "manager-legacy-id");
    assert.equal(managerCapture?.manager?.tmux_pane_id, "%20");
    assert.equal(managerCapture?.capture.output, "legacy manager line\nlegacy manager next");
    assert.equal(managerCapture?.transcript_segment.segment_kind, "reset");

    assert.deepEqual(calls, [
      ["tmux", "has-session", "-t", "codex-legacy-worker"],
      ["tmux", "list-panes", "-t", "codex-legacy-worker", "-F", "#{pane_id}"],
      ["tmux", "has-session", "-t", "codex-legacy-worker"],
      ["tmux", "capture-pane", "-p", "-S", "-80", "-t", "codex-legacy-worker"],
      ["tmux", "has-session", "-t", "codex-legacy-manager"],
      ["tmux", "list-panes", "-t", "codex-legacy-manager", "-F", "#{pane_id}"],
      ["tmux", "capture-pane", "-p", "-t", "codex-legacy-manager", "-S", "-80"],
    ]);

    const verifyDb = openDatabaseSync(dbPath);
    try {
      const captures = verifyDb.prepare(`
        select role, worker_id, manager_id, tmux_session, tmux_pane_id from terminal_captures order by id
      `).all() as Array<{
        manager_id: string | null;
        role: string;
        tmux_pane_id: string | null;
        tmux_session: string;
        worker_id: string | null;
      }>;
      assert.deepEqual(captures.map((row) => Object.fromEntries(Object.entries(row))), [
        {
          manager_id: null,
          role: "worker",
          tmux_pane_id: "%10",
          tmux_session: "codex-legacy-worker",
          worker_id: "worker-legacy-id",
        },
        {
          manager_id: "manager-legacy-id",
          role: "manager",
          tmux_pane_id: "%20",
          tmux_session: "codex-legacy-manager",
          worker_id: null,
        },
      ]);
      const eventRows = verifyDb.prepare(`
        select type, worker_id, manager_id from events where type like '%_terminal_captured' order by id
      `).all() as Array<{ manager_id: string | null; type: string; worker_id: string | null }>;
      assert.deepEqual(eventRows.map((row) => Object.fromEntries(Object.entries(row))), [
        { manager_id: null, type: "worker_terminal_captured", worker_id: "worker-legacy-id" },
        { manager_id: "manager-legacy-id", type: "manager_terminal_captured", worker_id: null },
      ]);
      const observations = verifyDb.prepare(`
        select role, worker_id, manager_id from agent_observations order by id
      `).all() as Array<{ manager_id: string | null; role: string; worker_id: string | null }>;
      assert.deepEqual(observations.map((row) => Object.fromEntries(Object.entries(row))), [
        { manager_id: null, role: "worker", worker_id: "worker-legacy-id" },
        { manager_id: "manager-legacy-id", role: "manager", worker_id: null },
      ]);
      const manager = verifyDb.prepare(`
        select last_capture_sha256, last_seen_at from managers where id = 'manager-legacy-id'
      `).get() as { last_capture_sha256: string | null; last_seen_at: string | null };
      assert.equal(manager.last_seen_at, "2026-06-04T13:00:00Z");
      assert.equal(manager.last_capture_sha256, createHash("sha256").update("legacy manager line\nlegacy manager next").digest("hex"));
      const legacyCapture = verifyDb.prepare(`
        select worker_id, content, line_count from transcript_captures
      `).get() as { content: string | null; line_count: number; worker_id: string };
      assert.equal(legacyCapture.worker_id, "worker-legacy-id");
      assert.equal(legacyCapture.content, "legacy worker line\nlegacy worker next");
      assert.equal(legacyCapture.line_count, 2);
    } finally {
      verifyDb.close();
    }
    assert.equal(readFileSync(join(stateRoot, "legacy-worker", "transcript.txt"), "utf8"), "legacy worker line\nlegacy worker next\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("TypeScript runtime handles migrated audit replay and subset export commands by default", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-ts-cli."));
  try {
    const dbPath = join(root, "workerctl.db");
    const outputDir = join(root, "export");
    const database = openDatabaseSync(dbPath);
    try {
      seedCliTask(database);
    } finally {
      database.close();
    }

    const audit = runTypescriptRuntimeCommand({
      args: ["audit", "cli-task", "--json", "--path", dbPath],
      env: {},
    });
    assert.equal(audit.exitCode, 0);
    assert.equal(audit.handled, true);
    assert.equal(JSON.parse(audit.stdout ?? "{}").task.name, "cli-task");

    const replay = runTypescriptRuntimeCommand({
      args: ["--ts-runtime", "replay", "cli-task", "--json", "--path", dbPath],
      env: {},
    });
    assert.equal(replay.exitCode, 0);
    const replayPayload = JSON.parse(replay.stdout ?? "{}") as {
      entries: Array<{ source: string }>;
      task: { name: string };
    };
    assert.equal(replayPayload.task.name, "cli-task");
    assert.deepEqual(replayPayload.entries.map((entry) => entry.source), [
      "events",
      "commands",
      "correlation_chains",
      "command_attempts",
      "routed_notifications",
    ]);

    const exported = runTypescriptRuntimeCommand({
      args: ["export-task", "cli-task", "--output", outputDir, "--path", dbPath],
      env: {},
    });
    assert.equal(exported.exitCode, 0);
    assert.equal(JSON.parse(exported.stdout ?? "{}").export_dir, outputDir);
    assert.equal(existsSync(join(outputDir, "manifest.json")), true);
    const manifest = JSON.parse(readFileSync(join(outputDir, "manifest.json"), "utf8")) as {
      files: string[];
    };
    assert.deepEqual(manifest.files, [
      "task-status.json",
      "audit.json",
      "acceptance-criteria.json",
      "commands.json",
      "command-attempts.json",
      "routed-notifications.json",
      "manager-decisions.json",
      "correlation-chains.json",
    ]);

    const defaultUnsupportedZip = runTypescriptRuntimeCommand({
      args: ["export-task", "cli-task", "--zip", "--path", dbPath],
      env: {},
    });
    assert.deepEqual(defaultUnsupportedZip, { exitCode: 0, handled: false });

    const unsupportedZip = runTypescriptRuntimeCommand({
      args: ["--ts-runtime", "export-task", "cli-task", "--zip", "--path", dbPath],
      env: {},
    });
    assert.equal(unsupportedZip.exitCode, 2);
    assert.match(unsupportedZip.stderr ?? "", /migrated audit subset only/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function seedCliTask(database: DatabaseSync): void {
  initializeDatabaseSync(database);
  createTaskSync(database, {
    goal: "Exercise TypeScript CLI runtime.",
    name: "cli-task",
    now: "2026-05-23T10:00:00Z",
    taskId: "task-cli",
  });
  insertSession(database, { id: "session-worker", name: "worker-a", role: "worker" });
  insertSession(database, { id: "session-manager", name: "manager-a", role: "manager" });
  bindSessionsSync(database, {
    bindingId: "binding-cli",
    managerSessionName: "manager-a",
    now: "2026-05-23T10:00:30Z",
    taskName: "cli-task",
    workerSessionName: "worker-a",
  });
  insertRalphLoopRun(database, {
    currentIteration: 1,
    maxIterations: 3,
    requiredBeforeContinue: ["ci_green"],
    runId: "run-cli",
    taskId: "task-cli",
  });
  recordLoopEvidenceSync(database, {
    correlationId: "cli-ci",
    evidenceType: "ci_green",
    iteration: 1,
    loopRunId: "run-cli",
    now: "2026-05-23T10:01:00Z",
    proof: "CI is green.",
    status: "green",
    task: "cli-task",
  });
  createCommandSync(database, {
    commandId: "command-cli",
    commandType: "continue_iteration",
    correlationId: "corr-cli",
    now: "2026-05-23T10:02:00Z",
    payload: {
      message: "Run iteration 2.",
      ralph_loop: { requested_iteration: 2, run_id: "run-cli" },
    },
    taskId: "task-cli",
  });
  const claimed = claimNextDispatchCommandSync(database, {
    commandTypes: ["continue_iteration"],
    dispatcherId: "dispatch-cli",
    now: "2026-05-23T10:02:01Z",
  });
  assert.ok(claimed);
  executeDispatchCommandSync(database, {
    claimed,
    dispatcherId: "dispatch-cli",
    now: "2026-05-23T10:02:02Z",
  });
}

function insertSession(
  database: DatabaseSync,
  options: {
    id: string;
    name: string;
    role: "manager" | "worker";
    tmuxPaneId?: string | null;
    tmuxSession?: string | null;
  },
): void {
  database.prepare(`
    insert into sessions(
      id, name, role, identity_token, codex_session_path, codex_session_id,
      cwd, registered_at, state, tmux_session, tmux_pane_id
    )
    values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    options.id,
    options.name,
    options.role,
    `${options.id}-token`,
    `/tmp/${options.id}.jsonl`,
    `${options.id}-codex`,
    "/repo",
    "2026-05-23T10:00:00Z",
    "active",
    options.tmuxSession ?? null,
    options.tmuxPaneId ?? null,
  );
}

function insertLegacyWorker(
  database: DatabaseSync,
  options: { identityToken: string; name: string; paneId: string; workerId: string },
): void {
  database.prepare(`
    insert into workers(
      id, name, tmux_session, tmux_pane_id, identity_token, cwd, state, created_at, updated_at
    )
    values (?, ?, ?, ?, ?, '/repo', 'active', '2026-06-04T12:50:00Z', '2026-06-04T12:50:00Z')
  `).run(
    options.workerId,
    options.name,
    `codex-${options.name}`,
    options.paneId,
    options.identityToken,
  );
}

function insertLegacyManager(
  database: DatabaseSync,
  options: { managerId: string; name: string; paneId: string; taskId: string },
): void {
  database.prepare(`
    insert into managers(
      id, name, task_id, tmux_session, tmux_pane_id, state, codex_args_json, started_at
    )
    values (?, ?, ?, ?, ?, 'ready', '[]', '2026-06-04T12:50:30Z')
  `).run(
    options.managerId,
    options.name,
    options.taskId,
    `codex-${options.name}`,
    options.paneId,
  );
}

function insertTerminalCapture(
  database: DatabaseSync,
  taskId: string,
  role: "manager" | "worker",
  capturedAt: string,
  content: string,
): number {
  const result = database.prepare(`
    insert into terminal_captures(
      task_id, role, tmux_session, captured_at, history_lines, content_sha256,
      content, byte_count, line_count, classifier_json, source
    )
    values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    taskId,
    role,
    `codex-${role}`,
    capturedAt,
    200,
    `${role}-sha`,
    content,
    Buffer.byteLength(content),
    pythonSplitlinesCountForTest(content),
    "{}",
    "test",
  );
  return Number(result.lastInsertRowid);
}

function insertTranscriptSegment(
  database: DatabaseSync,
  options: {
    capturedAt: string;
    role: "manager" | "worker";
    segmentId: number;
    text: string | null;
  },
): number {
  const result = database.prepare(`
    insert into transcript_segments(
      task_id, role, source_capture_id, previous_capture_id, captured_at,
      content_sha256, segment_text, segment_start_line, segment_end_line,
      byte_count, line_count, retention_class, segment_kind, created_at
    )
    values (?, ?, ?, null, ?, ?, ?, ?, ?, ?, ?, 'hot', ?, ?)
  `).run(
    "task-transcript",
    options.role,
    options.segmentId,
    options.capturedAt,
    `${options.role}-segment-sha-${options.segmentId}`,
    options.text,
    options.text === null ? null : 1,
    options.text === null ? null : pythonSplitlinesCountForTest(options.text),
    Buffer.byteLength(options.text ?? ""),
    pythonSplitlinesCountForTest(options.text ?? ""),
    options.text === null ? "metadata" : "segment",
    options.capturedAt,
  );
  return Number(result.lastInsertRowid);
}

function pythonSplitlinesCountForTest(value: string): number {
  if (value.length === 0) {
    return 0;
  }
  const lineBreaks = value.match(/\r\n|\r|\n/g)?.length ?? 0;
  return lineBreaks + (/(?:\r\n|\r|\n)$/.test(value) ? 0 : 1);
}

function insertRalphLoopRun(
  database: DatabaseSync,
  options: {
    currentIteration: number;
    maxIterations: number;
    requiredBeforeContinue: string[];
    runId: string;
    taskId: string;
  },
): void {
  database.prepare(`
    insert into runs(id, task_id, name, purpose, status, started_at, ended_at, metadata_json)
    values (?, ?, ?, 'ralph_loop', 'finished', ?, ?, ?)
  `).run(
    options.runId,
    options.taskId,
    `${options.taskId}-ralph-loop`,
    "2026-05-23T10:00:45Z",
    "2026-05-23T10:00:45Z",
    JSON.stringify({
      cleanup_policy: "clear",
      current_iteration: options.currentIteration,
      kind: "ralph_loop",
      max_iterations: options.maxIterations,
      policy_record: true,
      preset: null,
      required_before_continue: options.requiredBeforeContinue,
      seed_prompt_sha256: null,
      stop_conditions: ["max_iterations", "required_evidence"],
    }),
  );
}
