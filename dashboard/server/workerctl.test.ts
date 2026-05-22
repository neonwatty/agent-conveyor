import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildPtyAttachArgs,
  buildWorkerctlArgs,
  normalizeServerOptions,
} from "./workerctl.ts";
import {
  encodeTerminalResizeMessage,
  parseTerminalControlMessage,
} from "./terminal.ts";

test("normalizes loopback dashboard server defaults", () => {
  const options = normalizeServerOptions({});

  assert.equal(options.host, "127.0.0.1");
  assert.equal(options.port, 8797);
  assert.equal(options.workerctlPath, "scripts/workerctl");
});

test("builds task snapshot workerctl arguments without shell interpolation", () => {
  const args = buildWorkerctlArgs({
    command: "snapshot",
    task: "snapshot-task",
    workerctlPath: "scripts/workerctl",
  });

  assert.deepEqual(args, [
    "scripts/workerctl",
    "telemetry",
    "snapshot",
    "--task",
    "snapshot-task",
    "--json",
  ]);
});

test("builds session list arguments using the existing JSON default", () => {
  const args = buildWorkerctlArgs({
    dbPath: "/tmp/workerctl.db",
    command: "sessions",
    workerctlPath: "scripts/workerctl",
  });

  assert.deepEqual(args, ["scripts/workerctl", "sessions"]);
});

test("builds discovery arguments for dashboard search", () => {
  const args = buildWorkerctlArgs({
    command: "discover",
    includeAll: true,
    limit: 5,
    task: "dashboard-debug",
    workerctlPath: "scripts/workerctl",
  });

  assert.deepEqual(args, [
    "scripts/workerctl",
    "discover",
    "dashboard-debug",
    "--all",
    "--limit",
    "5",
  ]);
});

test("builds tmux attach arguments for a registered session", () => {
  const args = buildPtyAttachArgs({ session: "codex-worker-a" });

  assert.deepEqual(args, ["tmux", "attach", "-t", "codex-worker-a"]);
});

test("rejects unsafe terminal session names before spawning a PTY", () => {
  assert.throws(
    () => buildPtyAttachArgs({ session: "bad; rm -rf /" }),
    /Unsafe tmux session name/,
  );
});

test("parses dashboard terminal resize control messages", () => {
  assert.deepEqual(parseTerminalControlMessage(encodeTerminalResizeMessage(83, 31)), {
    cols: 83,
    rows: 31,
    type: "resize",
  });
});

test("leaves ordinary terminal input untouched by control parsing", () => {
  assert.equal(parseTerminalControlMessage("ls -la\r"), null);
  assert.equal(parseTerminalControlMessage(JSON.stringify({ type: "resize", cols: 83, rows: 31 })), null);
  assert.equal(parseTerminalControlMessage(encodeTerminalResizeMessage(1, 31)), null);
});

test("builds bind action arguments", () => {
  const args = buildWorkerctlArgs({
    command: "bind",
    manager: "manager-a",
    task: "task-a",
    worker: "worker-a",
    workerctlPath: "scripts/workerctl",
  });

  assert.deepEqual(args, [
    "scripts/workerctl",
    "bind",
    "--task",
    "task-a",
    "--worker",
    "worker-a",
    "--manager",
    "manager-a",
  ]);
});

test("builds task creation arguments", () => {
  const args = buildWorkerctlArgs({
    command: "create-task",
    task: "dashboard-task",
    taskGoal: "Supervise from dashboard.",
    taskSummary: "Dashboard QA",
    workerctlPath: "scripts/workerctl",
  });

  assert.deepEqual(args, [
    "scripts/workerctl",
    "tasks",
    "--create",
    "dashboard-task",
    "--goal",
    "Supervise from dashboard.",
    "--summary",
    "Dashboard QA",
  ]);
});

test("builds start-worker and start-manager arguments", () => {
  assert.deepEqual(
    buildWorkerctlArgs({
      askForApproval: "never",
      command: "start-worker",
      cwd: "/repo",
      sandbox: "danger-full-access",
      taskPrompt: "Implement the slice.",
      timeoutSeconds: 20,
      workerName: "dash-worker",
      workerctlPath: "scripts/workerctl",
    }),
    [
      "scripts/workerctl",
      "start-worker",
      "--name",
      "dash-worker",
      "--cwd",
      "/repo",
      "--sandbox",
      "danger-full-access",
      "--ask-for-approval",
      "never",
      "--timeout-seconds",
      "20",
      "--task",
      "Implement the slice.",
    ],
  );

  assert.deepEqual(
    buildWorkerctlArgs({
      command: "start-manager",
      dbPath: "/tmp/workerctl.db",
      managerName: "dash-manager",
      workerctlPath: "scripts/workerctl",
    }),
    ["scripts/workerctl", "start-manager", "--name", "dash-manager"],
  );
});

test("builds pair bootstrap arguments", () => {
  const args = buildWorkerctlArgs({
    command: "pair",
    cwd: "/repo",
    managerAcceptance: ["Both terminals attach"],
    managerGuideline: ["Keep receipts visible"],
    managerMode: "guided",
    managerName: "dash-manager",
    managerObjective: "Supervise dashboard bootstrap",
    managerReference: ["README.md"],
    task: "dashboard-task",
    taskGoal: "Exercise the browser bootstrap flow.",
    taskPrompt: "Start work from dashboard.",
    workerName: "dash-worker",
    workerctlPath: "scripts/workerctl",
  });

  assert.deepEqual(args, [
    "scripts/workerctl",
    "pair",
    "--task",
    "dashboard-task",
    "--worker-name",
    "dash-worker",
    "--manager-name",
    "dash-manager",
    "--cwd",
    "/repo",
    "--task-prompt",
    "Start work from dashboard.",
    "--task-goal",
    "Exercise the browser bootstrap flow.",
    "--manager-mode",
    "guided",
    "--manager-objective",
    "Supervise dashboard bootstrap",
    "--manager-guideline",
    "Keep receipts visible",
    "--manager-acceptance",
    "Both terminals attach",
    "--manager-reference",
    "README.md",
  ]);
});

test("builds session nudge dry-run arguments", () => {
  const args = buildWorkerctlArgs({
    command: "nudge",
    dryRun: true,
    session: "worker-a",
    text: "please report status",
    workerctlPath: "scripts/workerctl",
  });

  assert.deepEqual(args, [
    "scripts/workerctl",
    "session-nudge",
    "worker-a",
    "please report status",
    "--dry-run",
  ]);
});

test("builds interrupt arguments with followup", () => {
  const args = buildWorkerctlArgs({
    command: "interrupt",
    followup: "stop and summarize",
    key: "C-c",
    session: "worker-a",
    workerctlPath: "scripts/workerctl",
  });

  assert.deepEqual(args, [
    "scripts/workerctl",
    "session-interrupt",
    "worker-a",
    "--key",
    "C-c",
    "--followup",
    "stop and summarize",
  ]);
});

test("builds finish and export task arguments", () => {
  assert.deepEqual(
    buildWorkerctlArgs({
      command: "finish",
      requireCriteriaAudit: true,
      task: "task-a",
      workerctlPath: "scripts/workerctl",
    }),
    ["scripts/workerctl", "finish-task", "task-a", "--require-criteria-audit"],
  );
  assert.deepEqual(
    buildWorkerctlArgs({
      command: "export",
      task: "task-a",
      workerctlPath: "scripts/workerctl",
      zip: true,
    }),
    ["scripts/workerctl", "export-task", "task-a", "--zip"],
  );
});
