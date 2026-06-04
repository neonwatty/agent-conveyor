import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
    tmuxSession?: string | null;
  },
): void {
  database.prepare(`
    insert into sessions(
      id, name, role, identity_token, codex_session_path, codex_session_id,
      cwd, registered_at, state, tmux_session
    )
    values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
