import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { DatabaseSync } from "node:sqlite";

import { classifyBusyWait, classifyStartupOutput } from "./classify.js";
import { taskAuditSync } from "./audit.js";
import { exportTaskAuditSubsetSync } from "./export.js";
import { replayEntriesFromAudit } from "./replay.js";
import {
  claimableDispatchCommandsSync,
  claimNextDispatchCommandSync,
  createCommandSync,
  finishCommandAttemptSync,
  markCommandAttemptSideEffectStartedSync,
  recoverStaleDispatchClaimsSync,
} from "./commands.js";
import { discoverSession, findNativeCodexPid, findRolloutPathForPid, findRolloutPathInLsof, readSessionMeta } from "./codex-session.js";
import { checkDispatchRequiredPermissionSync, executeDispatchCommandSync, resolveDispatchCommandRouteSync } from "./dispatch.js";
import { inferState, ingestSessionSync, parseJsonlEventsWithStats } from "./ingest.js";
import { managerConfigPermissionAllowed, managerConfigSync } from "./manager-config.js";
import { normalizeManagerPermissions } from "./manager-permissions.js";
import {
  acceptanceCriteriaForTaskSync,
  recordAdversarialLoopEvidenceSync,
  recordLoopEvidenceSync,
  recordVisualDiffLoopEvidenceSync,
} from "./loop-evidence.js";
import {
  consumeNextSessionInboxItemSync,
  deliveryModeForTargetSessionSync,
  finishRoutedNotificationSync,
  insertRoutedNotificationSync,
  routedNotificationsSync,
  sessionInboxSync,
} from "./notifications.js";
import {
  activeBindingForTaskSync,
  bindSessionsSync,
  createTaskSync,
  latestSessionBindingForTaskSync,
  listTasksSync,
  unbindTaskSync,
} from "./tasks.js";
import {
  capturePaneArgs,
  hasSessionArgs,
  listPanesArgs,
  sendTextCommandSequence,
  sendTextToSessionWithRunner,
  sendTextWithRunner,
  sessionTmuxTarget,
  tmuxSession,
  tmuxTarget,
} from "./tmux.js";
import type { TmuxRunner } from "./tmux.js";
import { writePngRgba } from "./visual-diff.js";
import { initializeDatabaseSync, openDatabaseSync } from "../state/database.js";

test("tmux command builders preserve Python argument order", () => {
  assert.equal(tmuxSession("worker-a"), "codex-worker-a");
  assert.equal(tmuxTarget("worker-a"), "codex-worker-a");
  assert.deepEqual(hasSessionArgs("worker-a"), ["tmux", "has-session", "-t", "codex-worker-a"]);
  assert.deepEqual(listPanesArgs("codex-worker-a"), ["tmux", "list-panes", "-t", "codex-worker-a", "-F", "#{pane_id}"]);
  assert.deepEqual(capturePaneArgs("codex-worker-a", 80), ["tmux", "capture-pane", "-p", "-S", "-80", "-t", "codex-worker-a"]);
  assert.deepEqual(sendTextCommandSequence("worker-a", "hello"), [
    ["tmux", "set-buffer", "-b", "workerctl-worker-a", "hello"],
    ["tmux", "paste-buffer", "-b", "workerctl-worker-a", "-t", "codex-worker-a"],
    ["tmux", "send-keys", "-t", "codex-worker-a", "C-m"],
    ["tmux", "delete-buffer", "-b", "workerctl-worker-a"],
  ]);
});

test("session tmux target includes pane id when present", () => {
  assert.equal(sessionTmuxTarget({ tmux_session: "codex-a", tmux_pane_id: "%5" }), "codex-a:%5");
  assert.equal(sessionTmuxTarget({ tmux_session: "codex-a", tmux_pane_id: null }), "codex-a");
  assert.throws(() => sessionTmuxTarget({ tmux_session: null }), /session has no tmux_session/);
});

test("tmux send text runner checks liveness and deletes paste buffer after success", () => {
  const calls: Array<{ args: string[]; check: boolean | undefined }> = [];
  const sleeps: number[] = [];
  const runner: TmuxRunner = (args, options) => {
    calls.push({ args, check: options?.check });
    return { status: 0 };
  };

  sendTextWithRunner("worker-a", "hello", runner, { sleep: (milliseconds) => sleeps.push(milliseconds) });

  assert.deepEqual(sleeps, [100]);
  assert.deepEqual(calls, [
    { args: ["tmux", "has-session", "-t", "codex-worker-a"], check: false },
    { args: ["tmux", "set-buffer", "-b", "workerctl-worker-a", "hello"], check: true },
    { args: ["tmux", "paste-buffer", "-b", "workerctl-worker-a", "-t", "codex-worker-a"], check: true },
    { args: ["tmux", "send-keys", "-t", "codex-worker-a", "C-m"], check: true },
    { args: ["tmux", "delete-buffer", "-b", "workerctl-worker-a"], check: false },
  ]);
});

test("tmux send text runner normalizes permission errors and still deletes paste buffer", () => {
  const calls: string[][] = [];
  const runner: TmuxRunner = (args) => {
    calls.push(args);
    if (args[1] === "paste-buffer") {
      return { status: 1, stderr: "permission denied" };
    }
    return { status: 0 };
  };

  assert.throws(
    () => sendTextWithRunner("worker-a", "hello", runner),
    /tmux access was denied by the operating system or sandbox/,
  );
  assert.deepEqual(calls, [
    ["tmux", "has-session", "-t", "codex-worker-a"],
    ["tmux", "set-buffer", "-b", "workerctl-worker-a", "hello"],
    ["tmux", "paste-buffer", "-b", "workerctl-worker-a", "-t", "codex-worker-a"],
    ["tmux", "delete-buffer", "-b", "workerctl-worker-a"],
  ]);
});

test("session-keyed tmux send records side-effect progress and pane target", () => {
  const calls: string[][] = [];
  const audit = {};
  let callbackCount = 0;
  const runner: TmuxRunner = (args) => {
    calls.push(args);
    return { status: 0 };
  };

  const result = sendTextToSessionWithRunner(
    { name: "worker-a", tmux_pane_id: "%5", tmux_session: "codex-worker-a" },
    "hello",
    runner,
    {
      now: () => "2026-05-08T10:00:00Z",
      sideEffectAudit: audit,
      sideEffectStartedCallback: () => {
        callbackCount += 1;
      },
    },
  );

  assert.equal(callbackCount, 1);
  assert.deepEqual(result, {
    dry_run: false,
    session: "worker-a",
    side_effect_completed: true,
    side_effect_started: true,
    target: "codex-worker-a:%5",
    text: "hello",
    time: "2026-05-08T10:00:00Z",
  });
  assert.deepEqual(audit, {
    side_effect_completed: true,
    side_effect_started: true,
    target: "codex-worker-a:%5",
  });
  assert.deepEqual(calls, [
    ["tmux", "has-session", "-t", "codex-worker-a"],
    ["tmux", "set-buffer", "-b", "workerctl-session-worker-a", "hello"],
    ["tmux", "paste-buffer", "-b", "workerctl-session-worker-a", "-t", "codex-worker-a:%5"],
    ["tmux", "send-keys", "-t", "codex-worker-a:%5", "C-m"],
    ["tmux", "delete-buffer", "-b", "workerctl-session-worker-a"],
  ]);
});

test("Codex session helpers parse rollout metadata and lsof output", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-rollout."));
  try {
    const rollout = join(root, "rollout-a.jsonl");
    writeFileSync(rollout, `${JSON.stringify({
      payload: { cli_version: "1.2.3", cwd: "/repo", id: "session-a", originator: "codex" },
      type: "session_meta",
    })}\n`);

    assert.deepEqual(readSessionMeta(rollout), {
      cli_version: "1.2.3",
      cwd: "/repo",
      id: "session-a",
      originator: "codex",
    });
    assert.equal(findNativeCodexPid(123, [456]), 456);
    assert.equal(findNativeCodexPid(123, []), 123);
    assert.equal(
      findRolloutPathInLsof(`codex 456 user txt REG /Users/me/.codex/sessions/2026/rollout-session-a.jsonl\n`, 456),
      "/Users/me/.codex/sessions/2026/rollout-session-a.jsonl",
    );
    assert.equal(
      findRolloutPathForPid(456, () => `codex 456 user txt REG /Users/me/.codex/sessions/2026/rollout-session-a.jsonl\n`),
      "/Users/me/.codex/sessions/2026/rollout-session-a.jsonl",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Codex session discovery walks to native pid, rollout, and session metadata", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-discover."));
  try {
    const sessionsDir = join(root, ".codex", "sessions", "2026");
    mkdirSync(sessionsDir, { recursive: true });
    const rollout = join(sessionsDir, "rollout-session-a.jsonl");
    writeFileSync(rollout, `${JSON.stringify({
      payload: {
        cli_version: "1.2.3",
        cwd: "/repo",
        id: "session-a",
        originator: "codex",
      },
      type: "session_meta",
    })}\n`);

    const result = discoverSession({
      childrenForPid: (pid) => (pid === 123 ? [456] : []),
      lsofForPid: (pid) => `codex ${pid} user txt REG ${rollout}\n`,
      pid: 123,
    });

    assert.deepEqual(result, {
      cli_version: "1.2.3",
      codex_session_id: "session-a",
      codex_session_path: rollout,
      cwd: "/repo",
      native_pid: 456,
      originator: "codex",
      pid: 123,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("JSONL ingest parser tracks offsets, skips malformed lines, and ignores partial writes", () => {
  const content = Buffer.from([
    `${JSON.stringify({ payload: { type: "task_started" }, timestamp: "2026-05-08T10:00:00Z", type: "event_msg" })}\n`,
    "not-json\n",
    `${JSON.stringify(["array"])}\n`,
    `${JSON.stringify({ payload: { type: "task_complete" }, type: "event_msg" })}`,
  ].join(""));

  const result = parseJsonlEventsWithStats(content, { startOffset: 10 });

  assert.equal(result.skipped, 2);
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].byte_offset, 10);
  assert.equal(result.events[0].type, "event_msg");
  assert.equal(result.events[0].subtype, "task_started");
  assert.equal(inferState(result.events[0]), "busy");
});

test("DB-backed ingest persists events, offset, heartbeat, and telemetry", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-ingest-db."));
  try {
    const dbPath = join(root, "workerctl.db");
    const rollout = join(root, "rollout-session-a.jsonl");
    const firstLine = `${JSON.stringify({
      payload: { type: "task_started" },
      timestamp: "2026-05-08T10:00:00Z",
      type: "event_msg",
    })}\n`;
    const malformed = "not-json\n";
    const secondLine = `${JSON.stringify({
      payload: { type: "task_complete" },
      timestamp: "2026-05-08T10:01:00Z",
      type: "event_msg",
    })}\n`;
    const partialLine = JSON.stringify({
      payload: { type: "user_message" },
      timestamp: "2026-05-08T10:02:00Z",
      type: "event_msg",
    });
    writeFileSync(rollout, firstLine + malformed + secondLine + partialLine);

    const database = openDatabaseSync(dbPath);
    try {
      initializeDatabaseSync(database);
      database.prepare(`
        insert into sessions(
          id, name, role, identity_token, codex_session_path, codex_session_id,
          cwd, registered_at, state
        )
        values (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        "session-a",
        "worker-a",
        "worker",
        "token-a",
        rollout,
        "codex-session-a",
        "/repo",
        "2026-05-08T09:00:00Z",
        "active",
      );

      const firstResult = ingestSessionSync(database, {
        now: "2026-05-08T10:03:00Z",
        sessionName: "worker-a",
      });
      assert.deepEqual(firstResult, {
        new_events: 2,
        new_offset: Buffer.byteLength(firstLine + malformed + secondLine),
        skipped_lines: 1,
      });
      assert.equal(
        (database.prepare("select count(*) as count from codex_events").get() as { count: number }).count,
        2,
      );
      const sessionState = database.prepare(`
        select last_heartbeat_at, last_ingest_offset
        from sessions
        where id = 'session-a'
      `).get() as { last_heartbeat_at: string; last_ingest_offset: number };
      assert.equal(sessionState.last_heartbeat_at, "2026-05-08T10:03:00Z");
      assert.equal(sessionState.last_ingest_offset, Buffer.byteLength(firstLine + malformed + secondLine));
      assert.equal(
        (database.prepare("select json_extract(attributes_json, '$.skipped_lines') as skipped from telemetry_events").get() as { skipped: number }).skipped,
        1,
      );

      const secondResult = ingestSessionSync(database, {
        now: "2026-05-08T10:04:00Z",
        sessionName: "worker-a",
      });
      assert.equal(secondResult.new_events, 0);
      assert.equal(secondResult.new_offset, firstResult.new_offset);

      writeFileSync(rollout, firstLine + malformed + secondLine + `${partialLine}\n`);
      const thirdResult = ingestSessionSync(database, {
        now: "2026-05-08T10:05:00Z",
        sessionName: "worker-a",
      });
      assert.equal(thirdResult.new_events, 1);
      assert.equal(thirdResult.new_offset, Buffer.byteLength(firstLine + malformed + secondLine + `${partialLine}\n`));
      assert.equal(
        (database.prepare("select count(*) as count from codex_events").get() as { count: number }).count,
        3,
      );
    } finally {
      database.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("DB-backed ingest refuses shrunk rollout offsets", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-ingest-shrink."));
  try {
    const dbPath = join(root, "workerctl.db");
    const rollout = join(root, "rollout-session-a.jsonl");
    writeFileSync(rollout, "{}\n");
    const database = openDatabaseSync(dbPath);
    try {
      initializeDatabaseSync(database);
      database.prepare(`
        insert into sessions(
          id, name, role, identity_token, codex_session_path, codex_session_id,
          cwd, registered_at, state, last_ingest_offset
        )
        values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        "session-a",
        "worker-a",
        "worker",
        "token-a",
        rollout,
        "codex-session-a",
        "/repo",
        "2026-05-08T09:00:00Z",
        "active",
        999,
      );
      assert.throws(
        () => ingestSessionSync(database, { sessionName: "worker-a" }),
        /rollout file shrank/,
      );
    } finally {
      database.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("task lifecycle helpers create tasks, emit events, and list budget shape", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-tasks."));
  try {
    const database = openDatabaseSync(join(root, "workerctl.db"));
    try {
      initializeDatabaseSync(database);
      const taskId = createTaskSync(database, {
        goal: "Finish auth refactor.",
        name: "auth-refactor",
        now: "2026-05-08T10:00:00Z",
        summary: "Middleware replaced.",
        taskId: "task-auth",
      });
      database.prepare(`
        insert into tasks(id, name, goal, summary, state, created_at, updated_at)
        values (?, ?, ?, ?, ?, ?, ?)
      `).run("task-done", "done-task", "Already done.", null, "done", "2026-05-08T10:01:00Z", "2026-05-08T10:01:00Z");
      database.prepare(`
        insert into budgets(task_id, max_nudges, nudges_used, expires_at)
        values (?, ?, ?, ?)
      `).run("task-auth", 5, 2, "2026-05-09T10:00:00Z");

      assert.equal(taskId, "task-auth");
      assert.deepEqual(listTasksSync(database), [
        {
          budget: {
            expires_at: "2026-05-09T10:00:00Z",
            max_nudges: 5,
            nudges_remaining: 3,
            nudges_used: 2,
          },
          created_at: "2026-05-08T10:00:00Z",
          goal: "Finish auth refactor.",
          id: "task-auth",
          name: "auth-refactor",
          state: "candidate",
          summary: "Middleware replaced.",
          updated_at: "2026-05-08T10:00:00Z",
        },
        {
          budget: null,
          created_at: "2026-05-08T10:01:00Z",
          goal: "Already done.",
          id: "task-done",
          name: "done-task",
          state: "done",
          summary: null,
          updated_at: "2026-05-08T10:01:00Z",
        },
      ]);
      assert.deepEqual(listTasksSync(database, { activeOnly: true }).map((task) => task.id), ["task-auth"]);
      const event = database.prepare("select type, actor, task_id, payload_json from events where task_id = ?").get("task-auth") as {
        actor: string;
        payload_json: string;
        task_id: string;
        type: string;
      };
      assert.equal(event.actor, "workerctl");
      assert.equal(event.task_id, "task-auth");
      assert.equal(event.type, "task_created");
      assert.equal(event.payload_json, JSON.stringify({
        goal: "Finish auth refactor.",
        name: "auth-refactor",
        summary: "Middleware replaced.",
      }));
    } finally {
      database.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("task lifecycle helpers match Python create/list task shape", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-tasks-python."));
  try {
    const dbPath = join(root, "workerctl.db");
    const database = openDatabaseSync(dbPath);
    initializeDatabaseSync(database);
    createTaskSync(database, {
      goal: "Finish auth refactor.",
      name: "auth-refactor",
      now: "2026-05-08T10:00:00Z",
      summary: "Middleware replaced.",
      taskId: "task-auth",
    });
    database.close();

    const python = spawnSync("python3", ["-c", `
import json
from pathlib import Path
from workerctl import db
conn = db.connect(Path(${JSON.stringify(dbPath)}))
try:
    print(json.dumps(db.list_tasks(conn), sort_keys=True))
finally:
    conn.close()
`], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    assert.equal(python.status, 0, python.stderr);

    const readDatabase = openDatabaseSync(dbPath);
    try {
      assert.deepEqual(JSON.parse(python.stdout), listTasksSync(readDatabase));
    } finally {
      readDatabase.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("session binding helpers create active bindings and enforce role/state constraints", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-bindings."));
  try {
    const database = openDatabaseSync(join(root, "workerctl.db"));
    try {
      initializeDatabaseSync(database);
      createTaskSync(database, {
        goal: "Finish auth refactor.",
        name: "auth-refactor",
        now: "2026-05-08T10:00:00Z",
        taskId: "task-auth",
      });
      insertSession(database, { id: "session-w1", name: "w1", role: "worker" });
      insertSession(database, { id: "session-m1", name: "m1", role: "manager" });
      insertSession(database, { id: "session-w2", name: "w2", role: "worker" });

      const bindingId = bindSessionsSync(database, {
        bindingId: "binding-auth",
        managerSessionName: "m1",
        now: "2026-05-08T10:01:00Z",
        taskName: "auth-refactor",
        workerSessionName: "w1",
      });

      assert.equal(bindingId, "binding-auth");
      assert.deepEqual(activeBindingForTaskSync(database, "auth-refactor"), {
        binding_id: "binding-auth",
        created_at: "2026-05-08T10:01:00Z",
        manager_session_id: "session-m1",
        manager_session_name: "m1",
        state: "active",
        task_id: "task-auth",
        worker_session_id: "session-w1",
        worker_session_name: "w1",
      });
      assert.throws(
        () => bindSessionsSync(database, {
          managerSessionName: "m1",
          taskName: "auth-refactor",
          workerSessionName: "w2",
        }),
        /already has an active binding/,
      );
      assert.throws(
        () => bindSessionsSync(database, {
          managerSessionName: "w1",
          taskName: "auth-refactor",
          workerSessionName: "w2",
        }),
        /expected "manager"/,
      );

      database.prepare("update bindings set state = 'ending' where id = ?").run("binding-auth");
      assert.equal(activeBindingForTaskSync(database, "auth-refactor").state, "ending");
      unbindTaskSync(database, { now: "2026-05-08T10:02:00Z", taskName: "auth-refactor" });
      assert.throws(() => activeBindingForTaskSync(database, "auth-refactor"), /no active session-based binding/);
      assert.deepEqual(latestSessionBindingForTaskSync(database, "auth-refactor"), {
        binding_id: "binding-auth",
        created_at: "2026-05-08T10:01:00Z",
        ended_at: "2026-05-08T10:02:00Z",
        manager_session_id: "session-m1",
        manager_session_name: "m1",
        state: "ended",
        task_id: "task-auth",
        worker_session_id: "session-w1",
        worker_session_name: "w1",
      });
    } finally {
      database.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("session binding helper matches Python active binding shape", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-bindings-python."));
  try {
    const dbPath = join(root, "workerctl.db");
    const database = openDatabaseSync(dbPath);
    initializeDatabaseSync(database);
    createTaskSync(database, {
      goal: "Finish auth refactor.",
      name: "auth-refactor",
      now: "2026-05-08T10:00:00Z",
      taskId: "task-auth",
    });
    insertSession(database, { id: "session-w1", name: "w1", role: "worker" });
    insertSession(database, { id: "session-m1", name: "m1", role: "manager" });
    bindSessionsSync(database, {
      bindingId: "binding-auth",
      managerSessionName: "m1",
      now: "2026-05-08T10:01:00Z",
      taskName: "auth-refactor",
      workerSessionName: "w1",
    });
    const tsBinding = activeBindingForTaskSync(database, "auth-refactor");
    database.close();

    const python = spawnSync("python3", ["-c", `
import json
from pathlib import Path
from workerctl import db
conn = db.connect(Path(${JSON.stringify(dbPath)}))
try:
    print(json.dumps(db.active_binding_for_task(conn, task_name="auth-refactor"), sort_keys=True))
finally:
    conn.close()
`], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    assert.equal(python.status, 0, python.stderr);
    assert.deepEqual(JSON.parse(python.stdout), tsBinding);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("command queue helpers create, claim once, and emit telemetry", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-commands."));
  try {
    const dbPath = join(root, "workerctl.db");
    const database = openDatabaseSync(dbPath);
    try {
      initializeDatabaseSync(database);
      createTaskSync(database, {
        goal: "Run QA.",
        name: "qa-task",
        now: "2026-05-23T10:00:00Z",
        taskId: "task-claim",
      });
      const commandId = createCommandSync(database, {
        commandId: "command-claim",
        commandType: "notify_manager",
        correlationId: "corr-command",
        now: "2000-01-01T00:00:00Z",
        payload: { message: "check worker" },
        requiredPermission: "communication.notify_operator",
        taskId: "task-claim",
      });
      const claimable = claimableDispatchCommandsSync(database, {
        commandTypes: ["notify_manager"],
        now: "2026-05-23T10:00:59Z",
      });

      const claimed = claimNextDispatchCommandSync(database, {
        commandTypes: ["notify_manager"],
        dispatcherId: "dispatch-a",
        leaseSeconds: 30,
        now: "2026-05-23T10:01:00Z",
      });
      const second = claimNextDispatchCommandSync(database, {
        commandTypes: ["notify_manager"],
        dispatcherId: "dispatch-b",
        now: "2026-05-23T10:01:01Z",
      });

      assert.equal(commandId, "command-claim");
      assert.equal(claimable.length, 1);
      assert.equal(claimable[0]?.id, "command-claim");
      assert.equal(claimable[0]?.state, "pending");
      assert.equal(second, null);
      assert.equal(claimed?.command.id, "command-claim");
      assert.equal(claimed?.command.state, "attempted");
      assert.equal(claimed?.command.claimed_by, "dispatch-a");
      assert.equal(claimed?.command.correlation_id, "corr-command");
      assert.equal(claimed?.command.attempts, 1);
      assert.equal(claimed?.command.claim_expires_at, "2026-05-23T10:01:30Z");
      assert.deepEqual(claimed?.command.payload, { message: "check worker" });
      assert.equal(claimed?.command.required_permission, "communication.notify_operator");
      assert.equal(claimed?.attempt.state, "running");
      assert.equal(claimed?.attempt.dispatcher_id, "dispatch-a");
      const telemetry = database.prepare("select event_type, actor, severity from telemetry_events order by timestamp, event_type").all() as Array<{
        actor: string;
        event_type: string;
        severity: string;
      }>;
      assert.deepEqual(
        telemetry.map((row) => ({ actor: row.actor, event_type: row.event_type, severity: row.severity })),
        [
          { actor: "workerctl", event_type: "command_created", severity: "info" },
          { actor: "dispatch", event_type: "dispatch_command_claimed", severity: "info" },
        ],
      );
    } finally {
      database.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("command queue finish records command state, attempt state, side effects, and telemetry severity", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-command-finish."));
  try {
    const database = openDatabaseSync(join(root, "workerctl.db"));
    try {
      initializeDatabaseSync(database);
      createTaskSync(database, {
        goal: "Run QA.",
        name: "qa-task",
        now: "2026-05-23T10:00:00Z",
        taskId: "task-attempt",
      });
      createCommandSync(database, {
        commandId: "command-attempt",
        commandType: "continue_iteration",
        now: "2026-05-23T10:00:30Z",
        payload: { message: "continue" },
        taskId: "task-attempt",
      });
      const claimed = claimNextDispatchCommandSync(database, {
        commandTypes: ["continue_iteration"],
        dispatcherId: "dispatch-a",
        now: "2026-05-23T10:01:00Z",
      });
      assert.ok(claimed);

      const attempt = finishCommandAttemptSync(database, {
        attemptId: claimed.attempt.id,
        error: "missing_required_evidence",
        now: "2026-05-23T10:01:01Z",
        result: { reason: "missing_required_evidence", target_worker_notified: false },
        sideEffectCompleted: false,
        sideEffectStarted: false,
        state: "blocked",
      });
      assert.deepEqual(attempt, {
        command_id: "command-attempt",
        correlation_id: claimed.command.correlation_id,
        dispatcher_id: "dispatch-a",
        error: "missing_required_evidence",
        finished_at: "2026-05-23T10:01:01Z",
        id: claimed.attempt.id,
        result: { reason: "missing_required_evidence", target_worker_notified: false },
        side_effect_completed: false,
        side_effect_started: false,
        started_at: "2026-05-23T10:01:00Z",
        state: "blocked",
      });
      const commandState = database.prepare("select state, error, result_json from commands where id = ?").get("command-attempt") as {
        error: string;
        result_json: string;
        state: string;
      };
      assert.deepEqual(
        { error: commandState.error, result_json: commandState.result_json, state: commandState.state },
        {
          error: "missing_required_evidence",
          result_json: JSON.stringify({ reason: "missing_required_evidence", target_worker_notified: false }),
          state: "blocked",
        },
      );
      assert.throws(
        () => finishCommandAttemptSync(database, {
          attemptId: claimed.attempt.id,
          error: "late failure",
          now: "2026-05-23T10:01:02Z",
          state: "failed",
        }),
        /is not running/,
      );
      const blockedTelemetry = (database.prepare(`
          select event_type, severity
          from telemetry_events
          where event_type in ('dispatch_command_blocked', 'dispatch_command_failed')
        `).all() as Array<{ event_type: string; severity: string }>).map((row) => ({
        event_type: row.event_type,
        severity: row.severity,
      }));
      assert.deepEqual(
        blockedTelemetry,
        [{ event_type: "dispatch_command_blocked", severity: "warning" }],
      );
    } finally {
      database.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("command queue stale claim recovery requeues abandoned claims before side effects", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-command-requeue."));
  try {
    const database = openDatabaseSync(join(root, "workerctl.db"));
    try {
      initializeDatabaseSync(database);
      createTaskSync(database, {
        goal: "Run QA.",
        name: "qa-task",
        now: "2026-05-23T10:00:00Z",
        taskId: "task-requeue",
      });
      createCommandSync(database, {
        commandId: "command-requeue",
        commandType: "notify_manager",
        maxAttempts: 2,
        now: "2026-05-23T10:00:00Z",
        payload: { message: "retry me" },
        taskId: "task-requeue",
      });
      const claimed = claimNextDispatchCommandSync(database, {
        commandTypes: ["notify_manager"],
        dispatcherId: "stale-dispatch",
        leaseSeconds: 1,
        now: "2026-05-23T10:00:00Z",
      });
      assert.ok(claimed);

      const recovered = recoverStaleDispatchClaimsSync(database, {
        commandTypes: ["notify_manager"],
        dispatcherId: "dispatch-recover",
        now: "2026-05-23T10:00:01Z",
      });
      const command = database.prepare("select state, error, claimed_by, claim_expires_at from commands where id = ?").get("command-requeue") as {
        claim_expires_at: string | null;
        claimed_by: string | null;
        error: string | null;
        state: string;
      };
      const attempt = database.prepare("select state, error, side_effect_started from command_attempts where id = ?").get(claimed.attempt.id) as {
        error: string;
        side_effect_started: number;
        state: string;
      };

      assert.deepEqual(recovered, [
        {
          attempt_id: claimed.attempt.id,
          command_id: "command-requeue",
          command_type: "notify_manager",
          error: "stale dispatch claim abandoned before side effect started",
          side_effect_started: false,
          state: "requeued",
        },
      ]);
      assert.deepEqual(
        {
          claim_expires_at: command.claim_expires_at,
          claimed_by: command.claimed_by,
          error: command.error,
          state: command.state,
        },
        { claim_expires_at: null, claimed_by: null, error: null, state: "pending" },
      );
      assert.deepEqual(
        { error: attempt.error, side_effect_started: Boolean(attempt.side_effect_started), state: attempt.state },
        {
          error: "stale dispatch claim abandoned before side effect started",
          side_effect_started: false,
          state: "abandoned",
        },
      );
    } finally {
      database.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("command queue stale claim recovery fails claims after side effects started", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-command-stale-failed."));
  try {
    const database = openDatabaseSync(join(root, "workerctl.db"));
    try {
      initializeDatabaseSync(database);
      createTaskSync(database, {
        goal: "Run QA.",
        name: "qa-task",
        now: "2026-05-23T10:00:00Z",
        taskId: "task-stale-failed",
      });
      createCommandSync(database, {
        commandId: "command-stale-failed",
        commandType: "notify_manager",
        now: "2026-05-23T10:00:00Z",
        payload: { message: "do not retry blindly" },
        taskId: "task-stale-failed",
      });
      const claimed = claimNextDispatchCommandSync(database, {
        commandTypes: ["notify_manager"],
        dispatcherId: "stale-dispatch",
        leaseSeconds: 1,
        now: "2026-05-23T10:00:00Z",
      });
      assert.ok(claimed);
      markCommandAttemptSideEffectStartedSync(database, claimed.attempt.id);

      const recovered = recoverStaleDispatchClaimsSync(database, {
        commandTypes: ["notify_manager"],
        dispatcherId: "dispatch-recover",
        now: "2026-05-23T10:00:01Z",
      });
      const command = database.prepare("select state, error, claimed_by, claim_expires_at from commands where id = ?").get("command-stale-failed") as {
        claim_expires_at: string | null;
        claimed_by: string | null;
        error: string | null;
        state: string;
      };
      const attempt = database.prepare("select state, error, side_effect_started from command_attempts where id = ?").get(claimed.attempt.id) as {
        error: string;
        side_effect_started: number;
        state: string;
      };

      assert.deepEqual(recovered, [
        {
          attempt_id: claimed.attempt.id,
          command_id: "command-stale-failed",
          command_type: "notify_manager",
          error: "stale dispatch claim expired after side effect started; manual review required",
          side_effect_started: true,
          state: "failed",
        },
      ]);
      assert.deepEqual(
        {
          claim_expires_at: command.claim_expires_at,
          claimed_by: command.claimed_by,
          error: command.error,
          state: command.state,
        },
        {
          claim_expires_at: null,
          claimed_by: null,
          error: "stale dispatch claim expired after side effect started; manual review required",
          state: "failed",
        },
      );
      assert.deepEqual(
        { error: attempt.error, side_effect_started: Boolean(attempt.side_effect_started), state: attempt.state },
        {
          error: "stale dispatch claim expired after side effect started; manual review required",
          side_effect_started: true,
          state: "failed",
        },
      );
    } finally {
      database.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("command queue claim result matches Python command record shape", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-command-python."));
  try {
    const dbPath = join(root, "workerctl.db");
    const database = openDatabaseSync(dbPath);
    initializeDatabaseSync(database);
    createTaskSync(database, {
      goal: "Run QA.",
      name: "qa-task",
      now: "2026-05-23T10:00:00Z",
      taskId: "task-claim",
    });
    createCommandSync(database, {
      commandId: "command-claim",
      commandType: "notify_manager",
      correlationId: "corr-command",
      now: "2000-01-01T00:00:00Z",
      payload: { message: "check worker" },
      taskId: "task-claim",
    });
    const claimed = claimNextDispatchCommandSync(database, {
      commandTypes: ["notify_manager"],
      dispatcherId: "dispatch-a",
      leaseSeconds: 30,
      now: "2026-05-23T10:01:00Z",
    });
    database.close();
    assert.ok(claimed);

    const python = spawnSync("python3", ["-c", `
import json
from pathlib import Path
from workerctl import db
conn = db.connect(Path(${JSON.stringify(dbPath)}))
try:
    row = conn.execute("""
        select id, idempotency_key, created_at, updated_at, task_id, worker_id,
               manager_id, correlation_id, type, state, available_at, claimed_by,
               claimed_at, claim_expires_at, attempts, max_attempts, payload_json,
               required_permission, result_json, error
        from commands
        where id = 'command-claim'
    """).fetchone()
    print(json.dumps(db._command_record(row), sort_keys=True))
finally:
    conn.close()
`], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    assert.equal(python.status, 0, python.stderr);
    assert.deepEqual(JSON.parse(python.stdout), claimed.command);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("manager config permissions normalize aliases and round-trip allowed checks", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-manager-config."));
  try {
    const database = openDatabaseSync(join(root, "workerctl.db"));
    try {
      initializeDatabaseSync(database);
      createTaskSync(database, {
        goal: "Run QA.",
        name: "qa-task",
        now: "2026-05-23T10:00:00Z",
        taskId: "task-manager-config",
      });
      database.prepare(`
        insert into manager_configs(
          task_id, supervision_mode, objective, guidelines_json,
          acceptance_criteria_json, reference_paths_json, permissions_json,
          tools_json, epilogues_json, nudge_on_completion, require_acks,
          revision, created_at, updated_at
        )
        values (?, 'strict', ?, ?, ?, ?, ?, ?, ?, 'ask-operator', 1, 1, ?, ?)
      `).run(
        "task-manager-config",
        "Check against PRD.",
        JSON.stringify(["Nudge only when stale"]),
        JSON.stringify(["Tests pass"]),
        JSON.stringify(["docs/prd.md"]),
        JSON.stringify({ allow_pr: true, allow_worker_compact_clear: true, merge_green_pr: false }),
        JSON.stringify(["pytest"]),
        JSON.stringify(["draft-pr"]),
        "2026-05-23T10:01:00Z",
        "2026-05-23T10:01:00Z",
      );

      const config = managerConfigSync(database, "task-manager-config");

      assert.deepEqual(normalizeManagerPermissions({ allow_pr: true, allow_worker_compact_clear: true }), {
        communication: [],
        context: [],
        repo: ["open_pr"],
        verification: [],
        worker_session: ["clear", "compact"],
      });
      assert.equal(config?.objective, "Check against PRD.");
      assert.equal(config?.require_acks, true);
      assert.deepEqual(config?.permissions.repo, ["open_pr"]);
      assert.deepEqual(config?.permissions.worker_session, ["clear", "compact"]);
      assert.equal(managerConfigPermissionAllowed(config, "create_pr"), true);
      assert.equal(managerConfigPermissionAllowed(config, "worker_compact_clear"), true);
      assert.equal(managerConfigPermissionAllowed(config, "repo.merge_green_pr"), false);
    } finally {
      database.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("dispatch permission check emits telemetry and rejects missing manager permission", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-dispatch-permission."));
  try {
    const database = openDatabaseSync(join(root, "workerctl.db"));
    try {
      initializeDatabaseSync(database);
      createTaskSync(database, {
        goal: "Run QA.",
        name: "qa-task",
        now: "2026-05-23T10:00:00Z",
        taskId: "task-permission",
      });
      createCommandSync(database, {
        commandId: "command-permission",
        commandType: "notify_manager",
        correlationId: "corr-permission",
        now: "2026-05-23T10:00:00Z",
        payload: { message: "operator help" },
        requiredPermission: "communication.notify_operator",
        taskId: "task-permission",
      });
      const claimed = claimNextDispatchCommandSync(database, {
        commandTypes: ["notify_manager"],
        dispatcherId: "dispatch-permission",
        now: "2026-05-23T10:01:00Z",
      });
      assert.ok(claimed);

      assert.throws(
        () => checkDispatchRequiredPermissionSync(database, {
          command: claimed.command,
          now: "2026-05-23T10:01:01Z",
        }),
        /manager permission required for dispatch command: communication\.notify_operator/,
      );
      const event = database.prepare(`
        select severity, attributes_json, correlation_json
        from telemetry_events
        where event_type = 'dispatch_command_permission_checked'
      `).get() as { attributes_json: string; correlation_json: string; severity: string };

      assert.equal(event.severity, "warning");
      assert.deepEqual(JSON.parse(event.attributes_json), {
        allowed: false,
        configured: false,
        required_permission: "communication.notify_operator",
      });
      assert.deepEqual(JSON.parse(event.correlation_json), {
        command_id: "command-permission",
        command_type: "notify_manager",
        correlation_id: "corr-permission",
        required_permission: "communication.notify_operator",
      });
    } finally {
      database.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("dispatch permission check allows configured alias permission", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-dispatch-permission-allowed."));
  try {
    const database = openDatabaseSync(join(root, "workerctl.db"));
    try {
      initializeDatabaseSync(database);
      createTaskSync(database, {
        goal: "Run QA.",
        name: "qa-task",
        now: "2026-05-23T10:00:00Z",
        taskId: "task-permission-allowed",
      });
      database.prepare(`
        insert into manager_configs(
          task_id, supervision_mode, objective, guidelines_json,
          acceptance_criteria_json, reference_paths_json, permissions_json,
          tools_json, epilogues_json, nudge_on_completion, require_acks,
          revision, created_at, updated_at
        )
        values (?, 'guided', null, '[]', '[]', '[]', ?, '[]', '[]', 'ask-operator', 0, 1, ?, ?)
      `).run(
        "task-permission-allowed",
        JSON.stringify({ allow_worker_compact_clear: true }),
        "2026-05-23T10:00:30Z",
        "2026-05-23T10:00:30Z",
      );
      createCommandSync(database, {
        commandId: "command-permission-allowed",
        commandType: "nudge_worker",
        correlationId: "corr-permission-allowed",
        now: "2026-05-23T10:00:00Z",
        payload: { message: "clear when safe" },
        requiredPermission: "worker_compact_clear",
        taskId: "task-permission-allowed",
      });
      const claimed = claimNextDispatchCommandSync(database, {
        commandTypes: ["nudge_worker"],
        dispatcherId: "dispatch-permission",
        now: "2026-05-23T10:01:00Z",
      });
      assert.ok(claimed);

      const check = checkDispatchRequiredPermissionSync(database, {
        command: claimed.command,
        now: "2026-05-23T10:01:01Z",
      });
      const event = database.prepare(`
        select severity, attributes_json
        from telemetry_events
        where event_type = 'dispatch_command_permission_checked'
      `).get() as { attributes_json: string; severity: string };

      assert.deepEqual(check, {
        allowed: true,
        configured: true,
        required_permission: "worker_compact_clear",
      });
      assert.equal(event.severity, "info");
      assert.deepEqual(JSON.parse(event.attributes_json), {
        allowed: true,
        configured: true,
        required_permission: "worker_compact_clear",
      });
    } finally {
      database.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("dispatch route resolution mirrors command direction by command type", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-dispatch-route."));
  try {
    const database = openDatabaseSync(join(root, "workerctl.db"));
    try {
      initializeDatabaseSync(database);
      createTaskSync(database, {
        goal: "Run QA.",
        name: "qa-task",
        now: "2026-05-23T10:00:00Z",
        taskId: "task-route",
      });
      insertSession(database, { id: "session-worker", name: "worker-a", role: "worker" });
      insertSession(database, { id: "session-manager", name: "manager-a", role: "manager" });
      bindSessionsSync(database, {
        bindingId: "binding-route",
        managerSessionName: "manager-a",
        now: "2026-05-23T10:00:30Z",
        taskName: "qa-task",
        workerSessionName: "worker-a",
      });

      createCommandSync(database, {
        commandId: "command-notify",
        commandType: "notify_manager",
        now: "2026-05-23T10:01:00Z",
        payload: { message: "review worker" },
        taskId: "task-route",
      });
      const notify = claimNextDispatchCommandSync(database, {
        commandTypes: ["notify_manager"],
        dispatcherId: "dispatch-route",
        now: "2026-05-23T10:01:01Z",
      });
      assert.ok(notify);
      assert.deepEqual(resolveDispatchCommandRouteSync(database, notify.command), {
        binding_id: "binding-route",
        created_at: "2026-05-23T10:00:30Z",
        manager_session_id: "session-manager",
        manager_session_name: "manager-a",
        signal_type: "notify_manager",
        source_session_id: "session-worker",
        source_session_name: "worker-a",
        state: "active",
        target_session_id: "session-manager",
        target_session_name: "manager-a",
        task_id: "task-route",
        worker_session_id: "session-worker",
        worker_session_name: "worker-a",
      });

      for (const commandType of ["nudge_worker", "continue_iteration"]) {
        createCommandSync(database, {
          commandId: `command-${commandType}`,
          commandType,
          now: "2026-05-23T10:02:00Z",
          payload: { message: "continue" },
          taskId: "task-route",
        });
        const claimed = claimNextDispatchCommandSync(database, {
          commandTypes: [commandType],
          dispatcherId: "dispatch-route",
          now: "2026-05-23T10:02:01Z",
        });
        assert.ok(claimed);
        const route = resolveDispatchCommandRouteSync(database, claimed.command);
        assert.equal(route.signal_type, commandType);
        assert.equal(route.source_session_id, "session-manager");
        assert.equal(route.source_session_name, "manager-a");
        assert.equal(route.target_session_id, "session-worker");
        assert.equal(route.target_session_name, "worker-a");
      }
    } finally {
      database.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("dispatch route resolution rejects unsupported command types", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-dispatch-route-unsupported."));
  try {
    const database = openDatabaseSync(join(root, "workerctl.db"));
    try {
      initializeDatabaseSync(database);
      createTaskSync(database, {
        goal: "Run QA.",
        name: "qa-task",
        now: "2026-05-23T10:00:00Z",
        taskId: "task-route-unsupported",
      });
      insertSession(database, { id: "session-worker", name: "worker-a", role: "worker" });
      insertSession(database, { id: "session-manager", name: "manager-a", role: "manager" });
      bindSessionsSync(database, {
        bindingId: "binding-route",
        managerSessionName: "manager-a",
        now: "2026-05-23T10:00:30Z",
        taskName: "qa-task",
        workerSessionName: "worker-a",
      });
      createCommandSync(database, {
        commandId: "command-unsupported",
        commandType: "unsupported_command",
        now: "2026-05-23T10:01:00Z",
        payload: { message: "nope" },
        taskId: "task-route-unsupported",
      });
      const claimed = claimNextDispatchCommandSync(database, {
        commandTypes: ["unsupported_command"],
        dispatcherId: "dispatch-route",
        now: "2026-05-23T10:01:01Z",
      });
      assert.ok(claimed);

      assert.throws(
        () => resolveDispatchCommandRouteSync(database, claimed.command),
        /unsupported dispatch command type: unsupported_command/,
      );
    } finally {
      database.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("routed notifications preserve push delivery records and session inbox consumption", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-routed-notification."));
  try {
    const database = openDatabaseSync(join(root, "workerctl.db"));
    try {
      initializeDatabaseSync(database);
      createTaskSync(database, {
        goal: "Run QA.",
        name: "qa-task",
        now: "2026-05-23T10:00:00Z",
        taskId: "task-notification",
      });
      insertSession(database, { id: "session-worker", name: "worker-a", role: "worker" });
      insertSession(database, { id: "session-manager", name: "manager-a", role: "manager" });
      database.prepare("update sessions set tmux_session = ? where id = ?").run("codex-manager-a", "session-manager");
      bindSessionsSync(database, {
        bindingId: "binding-notification",
        managerSessionName: "manager-a",
        now: "2026-05-23T10:00:30Z",
        taskName: "qa-task",
        workerSessionName: "worker-a",
      });

      assert.equal(deliveryModeForTargetSessionSync(database, "session-manager"), "push");
      const notificationId = insertRoutedNotificationSync(database, {
        bindingId: "binding-notification",
        correlationId: "dispatch-inbox",
        dedupeKey: "dispatch-inbox-1",
        deliveryMode: "push",
        now: "2026-05-23T10:01:00Z",
        payload: { message: "inspect completion" },
        signalType: "worker_task_complete",
        sourceSessionId: "session-worker",
        state: "delivered",
        targetSessionId: "session-manager",
        taskId: "task-notification",
      });
      const notifications = routedNotificationsSync(database, { taskId: "task-notification" });
      const inbox = sessionInboxSync(database, { sessionName: "manager-a" });

      assert.equal(notificationId, notifications[0]?.id);
      assert.equal(notifications[0]?.delivery_mode, "push");
      assert.equal(notifications[0]?.state, "delivered");
      assert.deepEqual(notifications[0]?.payload, { message: "inspect completion" });
      assert.equal(inbox[0]?.id, notificationId);
      assert.equal(inbox[0]?.source_session_name, "worker-a");
      assert.equal(inbox[0]?.target_session_name, "manager-a");

      const consumed = consumeNextSessionInboxItemSync(database, {
        now: "2026-05-23T10:02:00Z",
        sessionName: "manager-a",
      });
      assert.equal(consumed?.id, notificationId);
      assert.equal(consumed?.consumed_by_session_id, "session-manager");
      assert.equal(consumed?.consumed_at, "2026-05-23T10:02:00Z");
      assert.deepEqual(sessionInboxSync(database, { sessionName: "manager-a" }), []);
      assert.equal(consumeNextSessionInboxItemSync(database, { sessionName: "manager-a" }), null);
    } finally {
      database.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pull-required routed notifications are delivered without side effects", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-routed-pull."));
  try {
    const database = openDatabaseSync(join(root, "workerctl.db"));
    try {
      initializeDatabaseSync(database);
      createTaskSync(database, {
        goal: "Run QA.",
        name: "qa-task",
        now: "2026-05-23T10:00:00Z",
        taskId: "task-pull",
      });
      insertSession(database, { id: "session-worker", name: "worker-a", role: "worker" });
      insertSession(database, { id: "session-manager", name: "manager-a", role: "manager" });
      bindSessionsSync(database, {
        bindingId: "binding-pull",
        managerSessionName: "manager-a",
        now: "2026-05-23T10:00:30Z",
        taskName: "qa-task",
        workerSessionName: "worker-a",
      });

      const deliveryMode = deliveryModeForTargetSessionSync(database, "session-manager");
      const notificationId = insertRoutedNotificationSync(database, {
        bindingId: "binding-pull",
        claimedAt: "2026-05-23T10:01:00Z",
        claimedBy: "dispatch-pull",
        correlationId: "dispatch-pull",
        dedupeKey: "dispatch-pull-1",
        deliveryMode,
        now: "2026-05-23T10:01:00Z",
        payload: { delivery_mode: deliveryMode, message: "pull me" },
        signalType: "notify_manager",
        sourceSessionId: "session-worker",
        targetSessionId: "session-manager",
        taskId: "task-pull",
      });
      finishRoutedNotificationSync(database, {
        notificationId,
        now: "2026-05-23T10:01:01Z",
        sideEffectCompleted: false,
        state: "delivered",
      });
      const notification = routedNotificationsSync(database, { taskId: "task-pull" })[0];
      const inbox = sessionInboxSync(database, { sessionName: "manager-a" });

      assert.equal(deliveryMode, "pull_required");
      assert.equal(notification?.state, "delivered");
      assert.equal(notification?.delivery_mode, "pull_required");
      assert.equal(notification?.delivered_at, "2026-05-23T10:01:01Z");
      assert.equal(notification?.side_effect_started, false);
      assert.equal(notification?.side_effect_completed, false);
      assert.equal(notification?.claimed_by, "dispatch-pull");
      assert.equal(inbox[0]?.id, notificationId);
      assert.deepEqual(inbox[0]?.payload, { delivery_mode: "pull_required", message: "pull me" });
    } finally {
      database.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("dispatch command execution dry-run plans without notification side effects", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-dispatch-dry-run."));
  try {
    const database = openDatabaseSync(join(root, "workerctl.db"));
    try {
      initializeDatabaseSync(database);
      createTaskSync(database, {
        goal: "Run QA.",
        name: "qa-task",
        now: "2026-05-23T10:00:00Z",
        taskId: "task-dispatch-dry-run",
      });
      insertSession(database, { id: "session-worker", name: "worker-a", role: "worker" });
      insertSession(database, { id: "session-manager", name: "manager-a", role: "manager" });
      bindSessionsSync(database, {
        bindingId: "binding-dispatch-dry-run",
        managerSessionName: "manager-a",
        now: "2026-05-23T10:00:30Z",
        taskName: "qa-task",
        workerSessionName: "worker-a",
      });
      createCommandSync(database, {
        commandId: "command-dry-run",
        commandType: "nudge_worker",
        correlationId: "corr-dry-run",
        now: "2026-05-23T10:01:00Z",
        payload: { message: "continue" },
        taskId: "task-dispatch-dry-run",
      });
      const claimed = claimNextDispatchCommandSync(database, {
        commandTypes: ["nudge_worker"],
        dispatcherId: "dispatch-dry-run",
        now: "2026-05-23T10:01:01Z",
      });
      assert.ok(claimed);

      const result = executeDispatchCommandSync(database, {
        claimed,
        dispatcherId: "dispatch-dry-run",
        dryRun: true,
        now: "2026-05-23T10:01:02Z",
      });
      const attempt = database.prepare("select state from command_attempts where id = ?").get(claimed.attempt.id) as { state: string };

      assert.deepEqual(result, {
        attempt_id: claimed.attempt.id,
        command_id: "command-dry-run",
        command_type: "nudge_worker",
        correlation_id: "corr-dry-run",
        dispatcher_id: "dispatch-dry-run",
        dry_run: true,
        state: "planned",
        target_session: "worker-a",
      });
      assert.deepEqual(routedNotificationsSync(database, { taskId: "task-dispatch-dry-run" }), []);
      assert.equal(attempt.state, "running");
    } finally {
      database.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("dispatch command execution delivers pull-required command to worker inbox and finishes attempt", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-dispatch-pull-command."));
  try {
    const database = openDatabaseSync(join(root, "workerctl.db"));
    try {
      initializeDatabaseSync(database);
      createTaskSync(database, {
        goal: "Run QA.",
        name: "qa-task",
        now: "2026-05-23T10:00:00Z",
        taskId: "task-dispatch-pull",
      });
      insertSession(database, { id: "session-worker", name: "worker-a", role: "worker" });
      insertSession(database, { id: "session-manager", name: "manager-a", role: "manager" });
      bindSessionsSync(database, {
        bindingId: "binding-dispatch-pull",
        managerSessionName: "manager-a",
        now: "2026-05-23T10:00:30Z",
        taskName: "qa-task",
        workerSessionName: "worker-a",
      });
      createCommandSync(database, {
        commandId: "command-pull",
        commandType: "nudge_worker",
        correlationId: "corr-pull",
        now: "2026-05-23T10:01:00Z",
        payload: { message: "continue through inbox" },
        taskId: "task-dispatch-pull",
      });
      const claimed = claimNextDispatchCommandSync(database, {
        commandTypes: ["nudge_worker"],
        dispatcherId: "dispatch-pull",
        now: "2026-05-23T10:01:01Z",
      });
      assert.ok(claimed);

      const result = executeDispatchCommandSync(database, {
        claimed,
        dispatcherId: "dispatch-pull",
        now: "2026-05-23T10:01:02Z",
      });
      const notifications = routedNotificationsSync(database, { taskId: "task-dispatch-pull" });
      const inbox = sessionInboxSync(database, { sessionName: "worker-a" });
      const command = database.prepare("select state, result_json from commands where id = ?").get("command-pull") as {
        result_json: string;
        state: string;
      };
      const events = database.prepare(`
        select event_type, severity
        from telemetry_events
        where event_type in ('dispatch_command_attempted', 'dispatch_signal_pull_required', 'dispatch_command_succeeded')
        order by timestamp, event_type
      `).all() as Array<{ event_type: string; severity: string }>;

      assert.equal(result.state, "pull_required");
      assert.equal(result.notification_id, notifications[0]?.id);
      assert.equal(result.side_effect_started, false);
      assert.equal(result.side_effect_completed, false);
      assert.equal(command.state, "succeeded");
      assert.equal(JSON.parse(command.result_json).notification_id, notifications[0]?.id);
      assert.equal(notifications[0]?.state, "delivered");
      assert.equal(notifications[0]?.delivery_mode, "pull_required");
      assert.equal(notifications[0]?.side_effect_started, false);
      assert.equal(notifications[0]?.side_effect_completed, false);
      assert.equal(inbox[0]?.id, notifications[0]?.id);
      assert.deepEqual(inbox[0]?.payload, {
        command_id: "command-pull",
        command_type: "nudge_worker",
        delivery_mode: "pull_required",
        dispatcher_id: "dispatch-pull",
        message: "continue through inbox",
        permission_check: null,
        source_session: "manager-a",
        target_session: "worker-a",
        task_id: "task-dispatch-pull",
      });
      assert.deepEqual(
        events.map((row) => ({ event_type: row.event_type, severity: row.severity })),
        [
          { event_type: "dispatch_command_attempted", severity: "info" },
          { event_type: "dispatch_command_succeeded", severity: "info" },
          { event_type: "dispatch_signal_pull_required", severity: "info" },
        ],
      );
    } finally {
      database.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("dispatch command execution blocks continue_iteration before notification when loop evidence is missing", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-dispatch-loop-blocked."));
  try {
    const database = openDatabaseSync(join(root, "workerctl.db"));
    try {
      initializeDatabaseSync(database);
      createTaskSync(database, {
        goal: "Run QA.",
        name: "qa-task",
        now: "2026-05-23T10:00:00Z",
        taskId: "task-dispatch-loop-blocked",
      });
      insertSession(database, { id: "session-worker", name: "worker-a", role: "worker" });
      insertSession(database, { id: "session-manager", name: "manager-a", role: "manager" });
      bindSessionsSync(database, {
        bindingId: "binding-dispatch-loop-blocked",
        managerSessionName: "manager-a",
        now: "2026-05-23T10:00:30Z",
        taskName: "qa-task",
        workerSessionName: "worker-a",
      });
      insertRalphLoopRun(database, {
        currentIteration: 1,
        maxIterations: 3,
        requiredBeforeContinue: ["ci_green", "adversarial_check"],
        runId: "run-loop-blocked",
        taskId: "task-dispatch-loop-blocked",
      });
      createCommandSync(database, {
        commandId: "command-loop-blocked",
        commandType: "continue_iteration",
        correlationId: "corr-loop-blocked",
        now: "2026-05-23T10:01:00Z",
        payload: {
          manager_decision: { decision_id: "42" },
          message: "Run iteration 2.",
          ralph_loop: { requested_iteration: 2, run_id: "run-loop-blocked" },
        },
        taskId: "task-dispatch-loop-blocked",
      });
      const claimed = claimNextDispatchCommandSync(database, {
        commandTypes: ["continue_iteration"],
        dispatcherId: "dispatch-loop",
        now: "2026-05-23T10:01:01Z",
      });
      assert.ok(claimed);

      const result = executeDispatchCommandSync(database, {
        claimed,
        dispatcherId: "dispatch-loop",
        now: "2026-05-23T10:01:02Z",
      });
      const command = database.prepare("select state, error, result_json from commands where id = ?").get("command-loop-blocked") as {
        error: string;
        result_json: string;
        state: string;
      };
      const attempt = database.prepare("select state, side_effect_started, side_effect_completed from command_attempts where id = ?").get(claimed.attempt.id) as {
        side_effect_completed: number;
        side_effect_started: number;
        state: string;
      };
      const telemetry = database.prepare(`
        select event_type, severity
        from telemetry_events
        where event_type in ('dispatch_command_blocked', 'dispatch_command_failed')
      `).all() as Array<{ event_type: string; severity: string }>;

      assert.equal(result.state, "blocked");
      assert.equal(result.reason, "missing_required_evidence");
      assert.deepEqual(result.missing_evidence, ["ci_green", "adversarial_check"]);
      assert.equal(result.delivered, false);
      assert.equal(result.target_worker_notified, false);
      assert.equal(result.notification_id, null);
      assert.equal(result.delivery_mode, "pull_required");
      assert.equal(result.manager_decision_id, 42);
      assert.equal(command.state, "blocked");
      assert.match(command.error, /missing_required_evidence/);
      assert.match(command.error, /missing_evidence=ci_green,adversarial_check/);
      assert.deepEqual(JSON.parse(command.result_json).missing_evidence, ["ci_green", "adversarial_check"]);
      assert.deepEqual(routedNotificationsSync(database, { taskId: "task-dispatch-loop-blocked" }), []);
      assert.deepEqual(sessionInboxSync(database, { sessionName: "worker-a" }), []);
      assert.deepEqual(
        { side_effect_completed: Boolean(attempt.side_effect_completed), side_effect_started: Boolean(attempt.side_effect_started), state: attempt.state },
        { side_effect_completed: false, side_effect_started: false, state: "blocked" },
      );
      assert.deepEqual(
        telemetry.map((row) => ({ event_type: row.event_type, severity: row.severity })),
        [{ event_type: "dispatch_command_blocked", severity: "warning" }],
      );
    } finally {
      database.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("dispatch command execution allows continue_iteration after structured prior evidence exists", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-dispatch-loop-allowed."));
  try {
    const database = openDatabaseSync(join(root, "workerctl.db"));
    try {
      initializeDatabaseSync(database);
      createTaskSync(database, {
        goal: "Run QA.",
        name: "qa-task",
        now: "2026-05-23T10:00:00Z",
        taskId: "task-dispatch-loop-allowed",
      });
      insertSession(database, { id: "session-worker", name: "worker-a", role: "worker" });
      insertSession(database, { id: "session-manager", name: "manager-a", role: "manager" });
      bindSessionsSync(database, {
        bindingId: "binding-dispatch-loop-allowed",
        managerSessionName: "manager-a",
        now: "2026-05-23T10:00:30Z",
        taskName: "qa-task",
        workerSessionName: "worker-a",
      });
      insertRalphLoopRun(database, {
        currentIteration: 1,
        maxIterations: 3,
        requiredBeforeContinue: ["ci_green", "adversarial_check"],
        runId: "run-loop-allowed",
        taskId: "task-dispatch-loop-allowed",
      });
      insertAcceptanceCriterion(database, {
        criterion: "Iteration 1 CI evidence",
        evidence: {
          evidence_type: "ci_green",
          iteration: 1,
          ralph_loop_run_id: "run-loop-allowed",
          status: "recorded",
        },
        taskId: "task-dispatch-loop-allowed",
      });
      insertAcceptanceCriterion(database, {
        criterion: "Iteration 1 adversarial evidence",
        evidence: {
          check: "Inspect CI and worker receipts before retry.",
          evidence_type: "adversarial_check",
          failure_mode: "A loop could continue on generic passing text.",
          iteration: 1,
          ralph_loop_run_id: "run-loop-allowed",
          result: "Structured evidence exists before continuation.",
          status: "pass",
        },
        taskId: "task-dispatch-loop-allowed",
      });
      createCommandSync(database, {
        commandId: "command-loop-allowed",
        commandType: "continue_iteration",
        correlationId: "corr-loop-allowed",
        now: "2026-05-23T10:01:00Z",
        payload: {
          message: "Run iteration 2.",
          ralph_loop: { requested_iteration: 2, run_id: "run-loop-allowed" },
        },
        taskId: "task-dispatch-loop-allowed",
      });
      const claimed = claimNextDispatchCommandSync(database, {
        commandTypes: ["continue_iteration"],
        dispatcherId: "dispatch-loop",
        now: "2026-05-23T10:01:01Z",
      });
      assert.ok(claimed);

      const result = executeDispatchCommandSync(database, {
        claimed,
        dispatcherId: "dispatch-loop",
        now: "2026-05-23T10:01:02Z",
      });
      const notification = routedNotificationsSync(database, { taskId: "task-dispatch-loop-allowed" })[0];
      const inbox = sessionInboxSync(database, { sessionName: "worker-a" })[0];
      const command = database.prepare("select state from commands where id = ?").get("command-loop-allowed") as { state: string };

      assert.equal(result.state, "pull_required");
      assert.equal(result.reason, null);
      assert.deepEqual(result.missing_evidence, []);
      assert.equal(result.run_id, "run-loop-allowed");
      assert.equal(command.state, "succeeded");
      assert.equal(notification?.command_id, "command-loop-allowed");
      assert.equal(notification?.signal_type, "continue_iteration");
      assert.equal(notification?.delivery_mode, "pull_required");
      assert.deepEqual(notification?.payload.ralph_loop, {
        artifact_requirements: {},
        cleanup_policy: "clear",
        current_iteration: 1,
        max_iterations: 3,
        preset: null,
        recommended_tools: [],
        required_before_continue: ["ci_green", "adversarial_check"],
        requested_iteration: 2,
        run_id: "run-loop-allowed",
        seed_prompt_sha256: null,
        stop_conditions: ["max_iterations", "required_evidence"],
        tags: [],
        template: null,
      });
      assert.equal(inbox?.id, notification?.id);
      assert.equal(inbox?.payload.message, "Run iteration 2.");
    } finally {
      database.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("dispatch command execution rejects unstructured adversarial loop evidence", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-dispatch-loop-adversarial."));
  try {
    const database = openDatabaseSync(join(root, "workerctl.db"));
    try {
      initializeDatabaseSync(database);
      createTaskSync(database, {
        goal: "Run QA.",
        name: "qa-task",
        now: "2026-05-23T10:00:00Z",
        taskId: "task-dispatch-loop-adversarial",
      });
      insertSession(database, { id: "session-worker", name: "worker-a", role: "worker" });
      insertSession(database, { id: "session-manager", name: "manager-a", role: "manager" });
      bindSessionsSync(database, {
        bindingId: "binding-dispatch-loop-adversarial",
        managerSessionName: "manager-a",
        now: "2026-05-23T10:00:30Z",
        taskName: "qa-task",
        workerSessionName: "worker-a",
      });
      insertRalphLoopRun(database, {
        currentIteration: 1,
        maxIterations: 3,
        requiredBeforeContinue: ["adversarial_check"],
        runId: "run-loop-adversarial",
        taskId: "task-dispatch-loop-adversarial",
      });
      insertAcceptanceCriterion(database, {
        criterion: "Unstructured adversarial evidence",
        evidence: {
          evidence_type: "adversarial_check",
          iteration: 1,
          ralph_loop_run_id: "run-loop-adversarial",
          status: "pass",
        },
        taskId: "task-dispatch-loop-adversarial",
      });
      createCommandSync(database, {
        commandId: "command-loop-adversarial",
        commandType: "continue_iteration",
        now: "2026-05-23T10:01:00Z",
        payload: {
          message: "Run iteration 2.",
          ralph_loop: { requested_iteration: 2, run_id: "run-loop-adversarial" },
        },
        taskId: "task-dispatch-loop-adversarial",
      });
      const claimed = claimNextDispatchCommandSync(database, {
        commandTypes: ["continue_iteration"],
        dispatcherId: "dispatch-loop",
        now: "2026-05-23T10:01:01Z",
      });
      assert.ok(claimed);

      const result = executeDispatchCommandSync(database, {
        claimed,
        dispatcherId: "dispatch-loop",
        now: "2026-05-23T10:01:02Z",
      });

      assert.equal(result.state, "blocked");
      assert.equal(result.reason, "missing_adversarial_check_evidence");
      assert.deepEqual(result.missing_evidence, ["adversarial_check"]);
      assert.deepEqual(routedNotificationsSync(database, { taskId: "task-dispatch-loop-adversarial" }), []);
      assert.deepEqual(sessionInboxSync(database, { sessionName: "worker-a" }), []);
    } finally {
      database.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loop evidence records run-qualified receipts consumed by Dispatch", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-loop-evidence-record."));
  try {
    const database = openDatabaseSync(join(root, "workerctl.db"));
    try {
      initializeDatabaseSync(database);
      createTaskSync(database, {
        goal: "Run QA.",
        name: "qa-task",
        now: "2026-05-23T10:00:00Z",
        taskId: "task-loop-evidence",
      });
      insertSession(database, { id: "session-worker", name: "worker-a", role: "worker" });
      insertSession(database, { id: "session-manager", name: "manager-a", role: "manager" });
      bindSessionsSync(database, {
        bindingId: "binding-loop-evidence",
        managerSessionName: "manager-a",
        now: "2026-05-23T10:00:30Z",
        taskName: "qa-task",
        workerSessionName: "worker-a",
      });
      insertRalphLoopRun(database, {
        currentIteration: 1,
        maxIterations: 3,
        requiredBeforeContinue: ["ci_green", "adversarial_check"],
        runId: "run-loop-evidence",
        taskId: "task-loop-evidence",
      });

      const ci = recordLoopEvidenceSync(database, {
        artifactPath: "/tmp/ci.json",
        correlationId: "corr-ci",
        evidenceType: "ci_green",
        iteration: 1,
        loopRunId: "run-loop-evidence",
        metadata: { suite: "unit" },
        now: "2026-05-23T10:01:00Z",
        proof: "CI is green.",
        status: "green",
        task: "qa-task",
      });
      const adversarial = recordAdversarialLoopEvidenceSync(database, {
        artifactPath: "/tmp/adversarial.txt",
        check: "Inspect CI and dispatch receipts before retry.",
        correlationId: "corr-adversarial",
        failureMode: "A retry could continue on generic CI text.",
        iteration: 1,
        loopRunId: "run-loop-evidence",
        now: "2026-05-23T10:01:01Z",
        result: "Receipts are structured and tied to the prior iteration.",
        task: "task-loop-evidence",
      });
      createCommandSync(database, {
        commandId: "command-loop-evidence",
        commandType: "continue_iteration",
        now: "2026-05-23T10:02:00Z",
        payload: {
          message: "Run iteration 2.",
          ralph_loop: { requested_iteration: 2, run_id: "run-loop-evidence" },
        },
        taskId: "task-loop-evidence",
      });
      const claimed = claimNextDispatchCommandSync(database, {
        commandTypes: ["continue_iteration"],
        dispatcherId: "dispatch-loop",
        now: "2026-05-23T10:02:01Z",
      });
      assert.ok(claimed);

      const result = executeDispatchCommandSync(database, {
        claimed,
        dispatcherId: "dispatch-loop",
        now: "2026-05-23T10:02:02Z",
      });
      const criteria = acceptanceCriteriaForTaskSync(database, { statuses: ["satisfied"], taskId: "task-loop-evidence" });
      const criterionEvents = database.prepare(`
        select type
        from events
        where task_id = ? and type like 'acceptance_criterion_%'
        order by id
      `).all("task-loop-evidence") as Array<{ type: string }>;

      assert.equal(ci.criterion.status, "satisfied");
      assert.equal(ci.evidence.artifact_path, "/tmp/ci.json");
      assert.equal(ci.evidence.correlation_id, "corr-ci");
      assert.equal(adversarial.criterion.status, "satisfied");
      assert.equal(adversarial.evidence.failure_mode, "A retry could continue on generic CI text.");
      assert.deepEqual(
        criteria.map((criterion) => criterion.evidence.evidence_type),
        ["ci_green", "adversarial_check"],
      );
      assert.equal(result.state, "pull_required");
      assert.deepEqual(result.missing_evidence, []);
      assert.deepEqual(criterionEvents.map((row) => row.type), ["acceptance_criterion_added", "acceptance_criterion_added"]);
    } finally {
      database.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loop evidence rejects weak adversarial metadata before writing criteria", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-loop-evidence-reject."));
  try {
    const database = openDatabaseSync(join(root, "workerctl.db"));
    try {
      initializeDatabaseSync(database);
      createTaskSync(database, {
        goal: "Reject weak proof.",
        name: "weak-task",
        now: "2026-05-23T10:00:00Z",
        taskId: "task-loop-weak",
      });
      insertRalphLoopRun(database, {
        currentIteration: 1,
        maxIterations: 2,
        requiredBeforeContinue: ["adversarial_check"],
        runId: "run-loop-weak",
        taskId: "task-loop-weak",
      });

      assert.throws(
        () => recordLoopEvidenceSync(database, {
          evidenceType: "adversarial_check",
          iteration: 1,
          loopRunId: "run-loop-weak",
          metadata: {},
          now: "2026-05-23T10:01:00Z",
          task: "weak-task",
        }),
        /--failure-mode must be non-empty/,
      );
      assert.deepEqual(acceptanceCriteriaForTaskSync(database, { taskId: "task-loop-weak" }), []);
      assert.deepEqual(
        database.prepare("select type from events where task_id = ? and type like 'acceptance_criterion_%'").all("task-loop-weak"),
        [],
      );
    } finally {
      database.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loop evidence updates an existing receipt so failed reruns do not leave stale satisfied evidence", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-loop-evidence-update."));
  try {
    const database = openDatabaseSync(join(root, "workerctl.db"));
    try {
      initializeDatabaseSync(database);
      createTaskSync(database, {
        goal: "Update proof.",
        name: "update-task",
        now: "2026-05-23T10:00:00Z",
        taskId: "task-loop-update",
      });
      insertRalphLoopRun(database, {
        currentIteration: 1,
        maxIterations: 3,
        requiredBeforeContinue: ["coverage_checked"],
        runId: "run-loop-update",
        taskId: "task-loop-update",
      });
      const first = recordLoopEvidenceSync(database, {
        evidenceType: "coverage_checked",
        iteration: 1,
        loopRunId: "run-loop-update",
        metadata: { suite: "unit" },
        now: "2026-05-23T10:01:00Z",
        proof: "Coverage passed.",
        status: "pass",
        task: "update-task",
      });
      const second = recordLoopEvidenceSync(database, {
        correlationId: "coverage-red",
        evidenceType: "coverage_checked",
        iteration: 1,
        loopRunId: "run-loop-update",
        metadata: { suite: "unit", tests: "failed" },
        now: "2026-05-23T10:02:00Z",
        proof: "Coverage failed on rerun.",
        status: "fail",
        task: "update-task",
      });
      const allCriteria = acceptanceCriteriaForTaskSync(database, { taskId: "task-loop-update" });
      const satisfiedCriteria = acceptanceCriteriaForTaskSync(database, { statuses: ["satisfied"], taskId: "task-loop-update" });
      const events = database.prepare(`
        select type
        from events
        where task_id = ? and type like 'acceptance_criterion_%'
        order by id
      `).all("task-loop-update") as Array<{ type: string }>;

      assert.equal(first.criterion.id, second.criterion.id);
      assert.equal(second.criterion.status, "rejected");
      assert.equal(second.criterion.proof, "Coverage failed on rerun.");
      assert.equal(second.evidence.correlation_id, "coverage-red");
      assert.equal(allCriteria.length, 1);
      assert.equal(satisfiedCriteria.length, 0);
      assert.deepEqual(events.map((row) => row.type), ["acceptance_criterion_added", "acceptance_criterion_updated"]);
    } finally {
      database.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("visual diff loop evidence records report and threshold receipts", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-visual-diff."));
  try {
    const database = openDatabaseSync(join(root, "workerctl.db"));
    try {
      initializeDatabaseSync(database);
      createTaskSync(database, {
        goal: "Compare screenshots.",
        name: "visual-task",
        now: "2026-05-23T10:00:00Z",
        taskId: "task-visual",
      });
      insertRalphLoopRun(database, {
        currentIteration: 1,
        maxIterations: 3,
        requiredBeforeContinue: ["visual_diff_report", "diff_below_threshold"],
        runId: "run-visual",
        taskId: "task-visual",
      });
      const reference = join(root, "reference.png");
      const candidate = join(root, "candidate.png");
      const diff = join(root, "diff.png");
      const report = join(root, "report.json");
      writePngRgba(reference, 2, 1, [[255, 0, 0, 255], [0, 255, 0, 255]]);
      writePngRgba(candidate, 2, 1, [[255, 0, 0, 255], [0, 0, 255, 255]]);

      const result = recordVisualDiffLoopEvidenceSync(database, {
        candidatePath: candidate,
        correlationId: "visual-diff-receipt",
        diffOutput: diff,
        iteration: 1,
        loopRunId: "run-visual",
        now: "2026-05-23T10:01:00Z",
        referencePath: reference,
        reportOutput: report,
        task: "visual-task",
        threshold: 0.6,
      });
      const satisfiedTypes = acceptanceCriteriaForTaskSync(database, { statuses: ["satisfied"], taskId: "task-visual" })
        .map((criterion) => criterion.evidence.evidence_type);
      const reportJson = JSON.parse(readFileSync(report, "utf8")) as Record<string, unknown>;

      assert.equal(result.diff.changed_pixels, 1);
      assert.equal(result.diff.total_pixels, 2);
      assert.equal(result.diff.diff_score, 0.5);
      assert.equal(result.diff.below_threshold, true);
      assert.equal(result.criterion.status, "satisfied");
      assert.equal(result.threshold_criterion.status, "satisfied");
      assert.equal(result.evidence.evidence_type, "visual_diff_report");
      assert.equal(reportJson.diff_score, 0.5);
      assert.equal(existsSync(diff), true);
      assert.deepEqual(satisfiedTypes, ["visual_diff_report", "diff_below_threshold"]);
    } finally {
      database.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("visual diff loop evidence rejects stale threshold evidence on failed rerun", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-visual-diff-rerun."));
  try {
    const database = openDatabaseSync(join(root, "workerctl.db"));
    try {
      initializeDatabaseSync(database);
      createTaskSync(database, {
        goal: "Compare screenshots.",
        name: "visual-task",
        now: "2026-05-23T10:00:00Z",
        taskId: "task-visual-rerun",
      });
      insertRalphLoopRun(database, {
        currentIteration: 1,
        maxIterations: 3,
        requiredBeforeContinue: ["visual_diff_report", "diff_below_threshold"],
        runId: "run-visual-rerun",
        taskId: "task-visual-rerun",
      });
      const reference = join(root, "reference.png");
      const passing = join(root, "passing.png");
      const failing = join(root, "failing.png");
      writePngRgba(reference, 2, 1, [[255, 0, 0, 255], [0, 255, 0, 255]]);
      writePngRgba(passing, 2, 1, [[255, 0, 0, 255], [0, 0, 255, 255]]);
      writePngRgba(failing, 2, 1, [[0, 0, 255, 255], [0, 0, 255, 255]]);

      const first = recordVisualDiffLoopEvidenceSync(database, {
        candidatePath: passing,
        iteration: 1,
        loopRunId: "run-visual-rerun",
        now: "2026-05-23T10:01:00Z",
        referencePath: reference,
        task: "visual-task",
        threshold: 0.6,
      });
      const second = recordVisualDiffLoopEvidenceSync(database, {
        candidatePath: failing,
        iteration: 1,
        loopRunId: "run-visual-rerun",
        now: "2026-05-23T10:02:00Z",
        referencePath: reference,
        source: "final_audit",
        task: "visual-task",
        threshold: 0.4,
      });
      const allCriteria = acceptanceCriteriaForTaskSync(database, { taskId: "task-visual-rerun" });
      const satisfiedTypes = acceptanceCriteriaForTaskSync(database, { statuses: ["satisfied"], taskId: "task-visual-rerun" })
        .map((criterion) => criterion.evidence.evidence_type);

      assert.equal(first.threshold_criterion.id, second.threshold_criterion.id);
      assert.equal(second.diff.diff_score, 1);
      assert.equal(second.diff.below_threshold, false);
      assert.equal(second.threshold_criterion.status, "rejected");
      assert.equal(allCriteria.filter((criterion) => criterion.evidence.evidence_type === "diff_below_threshold").length, 1);
      assert.deepEqual(satisfiedTypes, ["visual_diff_report"]);
    } finally {
      database.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("visual diff loop evidence validates the run before writing artifacts", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-visual-diff-bad-run."));
  try {
    const database = openDatabaseSync(join(root, "workerctl.db"));
    try {
      initializeDatabaseSync(database);
      createTaskSync(database, {
        goal: "Compare screenshots.",
        name: "visual-task",
        now: "2026-05-23T10:00:00Z",
        taskId: "task-visual-bad-run",
      });
      database.prepare(`
        insert into runs(id, task_id, name, purpose, status, started_at, ended_at, metadata_json)
        values ('run-ordinary', 'task-visual-bad-run', 'ordinary-run', 'telemetry', 'finished', ?, ?, ?)
      `).run("2026-05-23T10:00:45Z", "2026-05-23T10:00:45Z", JSON.stringify({ kind: "telemetry" }));
      const reference = join(root, "reference.png");
      const candidate = join(root, "candidate.png");
      const diff = join(root, "diff.png");
      const report = join(root, "report.json");
      writePngRgba(reference, 2, 1, [[255, 0, 0, 255], [0, 255, 0, 255]]);
      writePngRgba(candidate, 2, 1, [[255, 0, 0, 255], [0, 0, 255, 255]]);

      assert.throws(
        () => recordVisualDiffLoopEvidenceSync(database, {
          candidatePath: candidate,
          diffOutput: diff,
          iteration: 1,
          loopRunId: "run-ordinary",
          referencePath: reference,
          reportOutput: report,
          task: "visual-task",
          threshold: 0.6,
        }),
        /is not a Ralph loop run/,
      );
      assert.equal(existsSync(diff), false);
      assert.equal(existsSync(report), false);
      assert.deepEqual(acceptanceCriteriaForTaskSync(database, { taskId: "task-visual-bad-run" }), []);
    } finally {
      database.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("task audit exposes migrated Dispatch and loop evidence surfaces with Python-compatible records", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-task-audit."));
  try {
    const dbPath = join(root, "workerctl.db");
    const database = openDatabaseSync(dbPath);
    let audit: ReturnType<typeof taskAuditSync>;
    try {
      initializeDatabaseSync(database);
      createTaskSync(database, {
        goal: "Audit migrated evidence.",
        name: "audit-task",
        now: "2026-05-23T10:00:00Z",
        taskId: "task-audit",
      });
      insertSession(database, { id: "session-worker", name: "worker-a", role: "worker" });
      insertSession(database, { id: "session-manager", name: "manager-a", role: "manager" });
      bindSessionsSync(database, {
        bindingId: "binding-audit",
        managerSessionName: "manager-a",
        now: "2026-05-23T10:00:30Z",
        taskName: "audit-task",
        workerSessionName: "worker-a",
      });
      insertRalphLoopRun(database, {
        currentIteration: 1,
        maxIterations: 3,
        requiredBeforeContinue: ["ci_green"],
        runId: "run-audit",
        taskId: "task-audit",
      });
      recordLoopEvidenceSync(database, {
        correlationId: "audit-ci",
        evidenceType: "ci_green",
        iteration: 1,
        loopRunId: "run-audit",
        metadata: { suite: "audit" },
        now: "2026-05-23T10:01:00Z",
        proof: "CI is green.",
        status: "green",
        task: "audit-task",
      });
      createCommandSync(database, {
        commandId: "command-audit",
        commandType: "continue_iteration",
        correlationId: "corr-audit",
        now: "2026-05-23T10:02:00Z",
        payload: {
          message: "Run iteration 2.",
          ralph_loop: { requested_iteration: 2, run_id: "run-audit" },
        },
        taskId: "task-audit",
      });
      const claimed = claimNextDispatchCommandSync(database, {
        commandTypes: ["continue_iteration"],
        dispatcherId: "dispatch-audit",
        now: "2026-05-23T10:02:01Z",
      });
      assert.ok(claimed);
      executeDispatchCommandSync(database, {
        claimed,
        dispatcherId: "dispatch-audit",
        now: "2026-05-23T10:02:02Z",
      });

      audit = taskAuditSync(database, "audit-task");

      assert.equal(audit.task.id, "task-audit");
      assert.deepEqual(audit.acceptance_criteria.map((criterion) => criterion.evidence.evidence_type), ["ci_green"]);
      assert.equal(audit.commands[0]?.id, "command-audit");
      assert.equal(audit.commands[0]?.state, "succeeded");
      assert.equal(audit.command_attempts[0]?.state, "succeeded");
      assert.equal(audit.routed_notifications[0]?.target_session_name, "worker-a");
      assert.equal(audit.routed_notifications[0]?.source_session_name, "manager-a");
      assert.deepEqual((audit.routed_notifications[0]?.payload.ralph_loop as Record<string, unknown>).run_id, "run-audit");
      assert.deepEqual(audit.correlation_chains, [
        {
          attempt_ids: [claimed.attempt.id],
          command_id: "command-audit",
          command_state: "succeeded",
          command_type: "continue_iteration",
          correlation_id: "corr-audit",
          created_at: "2026-05-23T10:02:00Z",
          manager_cycle_id: null,
          manager_decision_cycle_id: null,
          manager_decision_id: null,
          routed_notification_ids: [audit.routed_notifications[0]?.id],
        },
      ]);
      assert.deepEqual(
        audit.events.filter((event) => event.type.startsWith("acceptance_criterion_")).map((event) => event.type),
        ["acceptance_criterion_added"],
      );
    } finally {
      database.close();
    }

    const python = spawnSync("python3", ["-c", `
import json
from pathlib import Path
from workerctl import db
conn = db.connect(Path(${JSON.stringify(dbPath)}))
try:
    audit = db.task_audit(conn, task="audit-task")
    subset = {
        "acceptance_criteria": audit["acceptance_criteria"],
        "command_attempt_states": [row["state"] for row in audit["command_attempts"]],
        "command_states": [row["state"] for row in audit["commands"]],
        "correlation_chains": audit["correlation_chains"],
        "notification_sessions": [
            {
                "source_session_name": row["source_session_name"],
                "target_session_name": row["target_session_name"],
            }
            for row in audit["routed_notifications"]
        ],
        "task": audit["task"],
    }
    print(json.dumps(subset, sort_keys=True))
finally:
    conn.close()
`], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    assert.equal(python.status, 0, python.stderr);
    const pythonAudit = JSON.parse(python.stdout) as {
      acceptance_criteria: unknown[];
      command_attempt_states: string[];
      command_states: string[];
      correlation_chains: unknown[];
      notification_sessions: Array<{ source_session_name: string; target_session_name: string }>;
      task: Record<string, unknown>;
    };

    assert.deepEqual(pythonAudit.task, audit.task);
    assert.deepEqual(pythonAudit.acceptance_criteria, audit.acceptance_criteria);
    assert.deepEqual(pythonAudit.command_states, audit.commands.map((command) => command.state));
    assert.deepEqual(pythonAudit.command_attempt_states, audit.command_attempts.map((attempt) => attempt.state));
    assert.deepEqual(pythonAudit.correlation_chains, audit.correlation_chains);
    assert.deepEqual(pythonAudit.notification_sessions, audit.routed_notifications.map((notification) => ({
      source_session_name: notification.source_session_name,
      target_session_name: notification.target_session_name,
    })));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("task replay entries mirror Python migrated audit subset", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-task-replay."));
  try {
    const dbPath = join(root, "workerctl.db");
    const database = openDatabaseSync(dbPath);
    let audit: ReturnType<typeof taskAuditSync>;
    try {
      initializeDatabaseSync(database);
      createTaskSync(database, {
        goal: "Replay migrated evidence.",
        name: "replay-task",
        now: "2026-05-23T10:00:00Z",
        taskId: "task-replay",
      });
      insertSession(database, { id: "session-worker", name: "worker-a", role: "worker" });
      insertSession(database, { id: "session-manager", name: "manager-a", role: "manager" });
      bindSessionsSync(database, {
        bindingId: "binding-replay",
        managerSessionName: "manager-a",
        now: "2026-05-23T10:00:30Z",
        taskName: "replay-task",
        workerSessionName: "worker-a",
      });
      insertRalphLoopRun(database, {
        currentIteration: 1,
        maxIterations: 3,
        requiredBeforeContinue: ["ci_green"],
        runId: "run-replay",
        taskId: "task-replay",
      });
      recordLoopEvidenceSync(database, {
        correlationId: "replay-ci",
        evidenceType: "ci_green",
        iteration: 1,
        loopRunId: "run-replay",
        now: "2026-05-23T10:01:00Z",
        proof: "CI is green.",
        status: "green",
        task: "replay-task",
      });
      createCommandSync(database, {
        commandId: "command-replay",
        commandType: "continue_iteration",
        correlationId: "corr-replay",
        now: "2026-05-23T10:02:00Z",
        payload: {
          message: "Run iteration 2.",
          ralph_loop: { requested_iteration: 2, run_id: "run-replay" },
        },
        taskId: "task-replay",
      });
      const claimed = claimNextDispatchCommandSync(database, {
        commandTypes: ["continue_iteration"],
        dispatcherId: "dispatch-replay",
        now: "2026-05-23T10:02:01Z",
      });
      assert.ok(claimed);
      executeDispatchCommandSync(database, {
        claimed,
        dispatcherId: "dispatch-replay",
        now: "2026-05-23T10:02:02Z",
      });
      audit = taskAuditSync(database, "replay-task");
    } finally {
      database.close();
    }

    const python = spawnSync("python3", ["-c", `
import json
from pathlib import Path
from workerctl import db, replay
conn = db.connect(Path(${JSON.stringify(dbPath)}))
try:
    audit = db.task_audit(conn, task="replay-task")
    print(json.dumps(replay.replay_entries(audit), sort_keys=True))
finally:
    conn.close()
`], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    assert.equal(python.status, 0, python.stderr);
    const pythonEntries = JSON.parse(python.stdout) as unknown[];
    const entries = replayEntriesFromAudit(audit);

    assert.deepEqual(entries, pythonEntries);
    assert.deepEqual(entries.map((entry) => entry.source), [
      "events",
      "commands",
      "correlation_chains",
      "command_attempts",
      "routed_notifications",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("task export writes migrated audit subset files and manifest", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-task-export."));
  try {
    const dbPath = join(root, "workerctl.db");
    const outputDir = join(root, "export");
    const database = openDatabaseSync(dbPath);
    try {
      initializeDatabaseSync(database);
      createTaskSync(database, {
        goal: "Export migrated evidence.",
        name: "export-task",
        now: "2026-05-23T10:00:00Z",
        taskId: "task-export",
      });
      insertSession(database, { id: "session-worker", name: "worker-a", role: "worker" });
      insertSession(database, { id: "session-manager", name: "manager-a", role: "manager" });
      bindSessionsSync(database, {
        bindingId: "binding-export",
        managerSessionName: "manager-a",
        now: "2026-05-23T10:00:30Z",
        taskName: "export-task",
        workerSessionName: "worker-a",
      });
      insertRalphLoopRun(database, {
        currentIteration: 1,
        maxIterations: 3,
        requiredBeforeContinue: ["ci_green"],
        runId: "run-export",
        taskId: "task-export",
      });
      recordLoopEvidenceSync(database, {
        correlationId: "export-ci",
        evidenceType: "ci_green",
        iteration: 1,
        loopRunId: "run-export",
        now: "2026-05-23T10:01:00Z",
        proof: "CI is green.",
        status: "green",
        task: "export-task",
      });
      createCommandSync(database, {
        commandId: "command-export",
        commandType: "continue_iteration",
        correlationId: "corr-export",
        now: "2026-05-23T10:02:00Z",
        payload: {
          message: "Run iteration 2.",
          ralph_loop: { requested_iteration: 2, run_id: "run-export" },
        },
        taskId: "task-export",
      });
      const claimed = claimNextDispatchCommandSync(database, {
        commandTypes: ["continue_iteration"],
        dispatcherId: "dispatch-export",
        now: "2026-05-23T10:02:01Z",
      });
      assert.ok(claimed);
      executeDispatchCommandSync(database, {
        claimed,
        dispatcherId: "dispatch-export",
        now: "2026-05-23T10:02:02Z",
      });
      const audit = taskAuditSync(database, "export-task");

      const result = exportTaskAuditSubsetSync(database, {
        now: "2026-05-23T10:03:00Z",
        outputDir,
        task: "export-task",
      });
      const manifest = JSON.parse(readFileSync(join(outputDir, "manifest.json"), "utf8")) as {
        created_at: string;
        files: string[];
        task: { id: string; name: string };
      };
      const parsedFiles = Object.fromEntries(
        manifest.files.map((file) => [file, JSON.parse(readFileSync(join(outputDir, file), "utf8")) as unknown]),
      );

      assert.equal(result.export_dir, outputDir);
      assert.deepEqual(manifest, {
        created_at: "2026-05-23T10:03:00Z",
        files: [
          "task-status.json",
          "audit.json",
          "acceptance-criteria.json",
          "commands.json",
          "command-attempts.json",
          "routed-notifications.json",
          "manager-decisions.json",
          "correlation-chains.json",
        ],
        task: { id: "task-export", name: "export-task" },
      });
      assert.deepEqual(parsedFiles["audit.json"], audit);
      assert.deepEqual(parsedFiles["acceptance-criteria.json"], audit.acceptance_criteria);
      assert.deepEqual(parsedFiles["commands.json"], audit.commands);
      assert.deepEqual(parsedFiles["command-attempts.json"], audit.command_attempts);
      assert.deepEqual(parsedFiles["routed-notifications.json"], audit.routed_notifications);
      assert.deepEqual(parsedFiles["manager-decisions.json"], audit.manager_decisions);
      assert.deepEqual(parsedFiles["correlation-chains.json"], audit.correlation_chains);
      assert.deepEqual(parsedFiles["task-status.json"], audit.task);
    } finally {
      database.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("dispatch command execution refuses push delivery before creating notification", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-dispatch-push-refusal."));
  try {
    const database = openDatabaseSync(join(root, "workerctl.db"));
    try {
      initializeDatabaseSync(database);
      createTaskSync(database, {
        goal: "Run QA.",
        name: "qa-task",
        now: "2026-05-23T10:00:00Z",
        taskId: "task-dispatch-push",
      });
      insertSession(database, { id: "session-worker", name: "worker-a", role: "worker" });
      insertSession(database, { id: "session-manager", name: "manager-a", role: "manager" });
      database.prepare("update sessions set tmux_session = ? where id = ?").run("codex-worker-a", "session-worker");
      bindSessionsSync(database, {
        bindingId: "binding-dispatch-push",
        managerSessionName: "manager-a",
        now: "2026-05-23T10:00:30Z",
        taskName: "qa-task",
        workerSessionName: "worker-a",
      });
      createCommandSync(database, {
        commandId: "command-push",
        commandType: "nudge_worker",
        now: "2026-05-23T10:01:00Z",
        payload: { message: "push me" },
        taskId: "task-dispatch-push",
      });
      const claimed = claimNextDispatchCommandSync(database, {
        commandTypes: ["nudge_worker"],
        dispatcherId: "dispatch-push",
        now: "2026-05-23T10:01:01Z",
      });
      assert.ok(claimed);

      assert.throws(
        () => executeDispatchCommandSync(database, {
          claimed,
          dispatcherId: "dispatch-push",
          now: "2026-05-23T10:01:02Z",
        }),
        /push delivery requires a tmux runner/,
      );
      assert.deepEqual(routedNotificationsSync(database, { taskId: "task-dispatch-push" }), []);
    } finally {
      database.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("dispatch command execution uses tmux runner for push delivery and marks side effects", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-dispatch-push-success."));
  try {
    const database = openDatabaseSync(join(root, "workerctl.db"));
    try {
      initializeDatabaseSync(database);
      createTaskSync(database, {
        goal: "Run QA.",
        name: "qa-task",
        now: "2026-05-23T10:00:00Z",
        taskId: "task-dispatch-push-success",
      });
      insertSession(database, { id: "session-worker", name: "worker-a", role: "worker" });
      insertSession(database, { id: "session-manager", name: "manager-a", role: "manager" });
      database.prepare("update sessions set tmux_session = ?, tmux_pane_id = ? where id = ?").run("codex-worker-a", "%7", "session-worker");
      bindSessionsSync(database, {
        bindingId: "binding-dispatch-push",
        managerSessionName: "manager-a",
        now: "2026-05-23T10:00:30Z",
        taskName: "qa-task",
        workerSessionName: "worker-a",
      });
      createCommandSync(database, {
        commandId: "command-push-success",
        commandType: "nudge_worker",
        correlationId: "corr-push-success",
        now: "2026-05-23T10:01:00Z",
        payload: { message: "push me" },
        taskId: "task-dispatch-push-success",
      });
      const claimed = claimNextDispatchCommandSync(database, {
        commandTypes: ["nudge_worker"],
        dispatcherId: "dispatch-push",
        now: "2026-05-23T10:01:01Z",
      });
      assert.ok(claimed);
      const calls: string[][] = [];
      const runner: TmuxRunner = (args) => {
        calls.push(args);
        return { status: 0 };
      };

      const result = executeDispatchCommandSync(database, {
        claimed,
        dispatcherId: "dispatch-push",
        now: "2026-05-23T10:01:02Z",
        sleep: () => {},
        tmuxRunner: runner,
      });
      const notification = routedNotificationsSync(database, { taskId: "task-dispatch-push-success" })[0];
      const command = database.prepare("select state from commands where id = ?").get("command-push-success") as { state: string };
      const attempt = database.prepare("select state, side_effect_started, side_effect_completed from command_attempts where id = ?").get(claimed.attempt.id) as {
        side_effect_completed: number;
        side_effect_started: number;
        state: string;
      };

      assert.equal(result.state, "delivered");
      assert.equal(result.side_effect_started, true);
      assert.equal(result.side_effect_completed, true);
      assert.equal(result.send_result?.target, "codex-worker-a:%7");
      assert.equal(notification?.state, "delivered");
      assert.equal(notification?.side_effect_started, true);
      assert.equal(notification?.side_effect_completed, true);
      assert.equal(command.state, "succeeded");
      assert.deepEqual(
        { side_effect_completed: Boolean(attempt.side_effect_completed), side_effect_started: Boolean(attempt.side_effect_started), state: attempt.state },
        { side_effect_completed: true, side_effect_started: true, state: "succeeded" },
      );
      assert.deepEqual(calls, [
        ["tmux", "has-session", "-t", "codex-worker-a"],
        ["tmux", "set-buffer", "-b", "workerctl-session-worker-a", "push me"],
        ["tmux", "paste-buffer", "-b", "workerctl-session-worker-a", "-t", "codex-worker-a:%7"],
        ["tmux", "send-keys", "-t", "codex-worker-a:%7", "C-m"],
        ["tmux", "delete-buffer", "-b", "workerctl-session-worker-a"],
      ]);
    } finally {
      database.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("dispatch command execution defers push notification when tmux fails before side effect", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-conveyor-dispatch-push-failure."));
  try {
    const database = openDatabaseSync(join(root, "workerctl.db"));
    try {
      initializeDatabaseSync(database);
      createTaskSync(database, {
        goal: "Run QA.",
        name: "qa-task",
        now: "2026-05-23T10:00:00Z",
        taskId: "task-dispatch-push-failure",
      });
      insertSession(database, { id: "session-worker", name: "worker-a", role: "worker" });
      insertSession(database, { id: "session-manager", name: "manager-a", role: "manager" });
      database.prepare("update sessions set tmux_session = ? where id = ?").run("codex-worker-a", "session-worker");
      bindSessionsSync(database, {
        bindingId: "binding-dispatch-push",
        managerSessionName: "manager-a",
        now: "2026-05-23T10:00:30Z",
        taskName: "qa-task",
        workerSessionName: "worker-a",
      });
      createCommandSync(database, {
        commandId: "command-push-failure",
        commandType: "nudge_worker",
        correlationId: "corr-push-failure",
        now: "2026-05-23T10:01:00Z",
        payload: { message: "push me" },
        taskId: "task-dispatch-push-failure",
      });
      const claimed = claimNextDispatchCommandSync(database, {
        commandTypes: ["nudge_worker"],
        dispatcherId: "dispatch-push",
        now: "2026-05-23T10:01:01Z",
      });
      assert.ok(claimed);
      const runner: TmuxRunner = (args) => {
        if (args[1] === "set-buffer") {
          return { status: 1, stderr: "set-buffer denied" };
        }
        return { status: 0 };
      };

      const result = executeDispatchCommandSync(database, {
        claimed,
        dispatcherId: "dispatch-push",
        now: "2026-05-23T10:01:02Z",
        tmuxRunner: runner,
      });
      const notification = routedNotificationsSync(database, { taskId: "task-dispatch-push-failure" })[0];
      const command = database.prepare("select state, error from commands where id = ?").get("command-push-failure") as {
        error: string;
        state: string;
      };
      const attempt = database.prepare("select state, side_effect_started, side_effect_completed from command_attempts where id = ?").get(claimed.attempt.id) as {
        side_effect_completed: number;
        side_effect_started: number;
        state: string;
      };

      assert.equal(result.state, "failed");
      assert.equal(result.side_effect_started, false);
      assert.equal(result.side_effect_completed, false);
      assert.match(result.error ?? "", /set-buffer denied/);
      assert.equal(notification?.state, "pending");
      assert.match(notification?.error ?? "", /set-buffer denied/);
      assert.equal(notification?.side_effect_started, false);
      assert.equal(notification?.side_effect_completed, false);
      assert.equal(notification?.claimed_by, null);
      assert.equal(command.state, "failed");
      assert.match(command.error, /set-buffer denied/);
      assert.deepEqual(
        { side_effect_completed: Boolean(attempt.side_effect_completed), side_effect_started: Boolean(attempt.side_effect_started), state: attempt.state },
        { side_effect_completed: false, side_effect_started: false, state: "failed" },
      );
    } finally {
      database.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("classifier mirrors startup and busy-wait prompt detection", () => {
  assert.deepEqual(classifyStartupOutput("OpenAI Codex\n› "), ["ready", "Codex input prompt is visible"]);
  assert.deepEqual(classifyStartupOutput("Working\nEsc to interrupt"), ["working", "Codex is already working"]);
  assert.deepEqual(classifyStartupOutput(""), ["starting", "terminal output is empty"]);
  assert.deepEqual(classifyStartupOutput("failed to launch"), ["error", "terminal output contains an error-like message"]);
  assert.deepEqual(classifyStartupOutput("Do you trust the contents of this directory?"), [
    "needs_trust",
    "Codex is waiting for workspace trust confirmation",
  ]);
  assert.deepEqual(classifyBusyWait("Starting MCP servers", 120, 60), {
    pattern: "mcp_startup",
    reason: "terminal shows Codex waiting on MCP server startup",
    recommended_action: "inspect_or_interrupt",
  });
  assert.deepEqual(classifyBusyWait("historical approval_prompt inspect_or_approve", 120, 60), null);
  assert.deepEqual(classifyBusyWait("approval required\nallow command?", 120, 60), {
    pattern: "approval_prompt",
    reason: "terminal appears to mention an approval prompt",
    recommended_action: "inspect_or_approve",
  });
  assert.deepEqual(classifyBusyWait("Approaching rate limits\nPress enter to confirm", 120, 60), {
    pattern: "rate_limit_prompt",
    reason: "terminal shows a rate-limit model switch prompt",
    recommended_action: "inspect_or_interrupt",
  });
  assert.deepEqual(classifyBusyWait("Press enter to confirm", 120, 60), {
    pattern: "enter_to_confirm",
    reason: "terminal is waiting for Enter confirmation",
    recommended_action: "inspect_or_confirm",
  });
  assert.deepEqual(classifyBusyWait("Do you trust the contents of this directory?", 120, 60), {
    pattern: "trust_prompt",
    reason: "terminal is waiting for workspace trust confirmation",
    recommended_action: "inspect_or_accept_trust",
  });
  assert.deepEqual(classifyBusyWait("Create a plan? shift + tab use Plan mode esc dismiss", 120, 60), {
    pattern: "plan_prompt",
    reason: "terminal is waiting at Codex plan-mode suggestion",
    recommended_action: "inspect_or_confirm",
  });
  assert.deepEqual(classifyBusyWait("Working\nEsc to interrupt", 120, 60, 10), null);
  assert.deepEqual(classifyBusyWait("running tests... esc to interrupt", 300, 60, 133), null);
  assert.deepEqual(classifyBusyWait("running tests... esc to interrupt", 300, 60, 2), {
    pattern: "long_running_interruptible",
    reason: "terminal shows an interruptible Codex operation while status.json is stale",
    recommended_action: "inspect_or_interrupt",
  });
  assert.deepEqual(classifyBusyWait("Starting MCP servers", 10, 60), null);
});

function insertSession(
  database: DatabaseSync,
  options: { id: string; name: string; role: "manager" | "worker" },
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
    "2026-05-08T09:00:00Z",
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

function insertAcceptanceCriterion(
  database: DatabaseSync,
  options: {
    criterion: string;
    evidence: Record<string, unknown>;
    taskId: string;
  },
): void {
  database.prepare(`
    insert into acceptance_criteria(
      task_id, criterion, status, source, proof, rationale,
      evidence_json, created_at, updated_at
    )
    values (?, ?, 'satisfied', 'manager_inferred', ?, null, ?, ?, ?)
  `).run(
    options.taskId,
    options.criterion,
    `${options.criterion} receipt recorded.`,
    JSON.stringify(options.evidence),
    "2026-05-23T10:00:50Z",
    "2026-05-23T10:00:50Z",
  );
}
