import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { DatabaseSync } from "node:sqlite";

import { runTypescriptRuntimeCommand } from "./typescript-runtime.js";
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
import { defaultDbPath } from "../state/files.js";

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
  },
): void {
  database.prepare(`
    insert into sessions(
      id, name, role, identity_token, codex_session_path, codex_session_id,
      cwd, registered_at, state
    )
    values (?, ?, ?, ?, ?, ?, ?, ?, ?)
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
  );
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
