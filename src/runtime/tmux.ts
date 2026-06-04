const PASTE_SUBMIT_DELAY_SECONDS = 0.1;
const SUBMIT_KEY = "C-m";

export interface TmuxCommandResult {
  status: number;
  stderr?: string;
  stdout?: string;
}

export type TmuxRunner = (args: string[], options?: { check?: boolean }) => TmuxCommandResult;

export interface SendTextResult {
  dry_run: boolean;
  session?: string;
  side_effect_completed: boolean;
  side_effect_started: boolean;
  target: string;
  text: string;
  time: string;
}

const TMUX_PERMISSION_MARKERS = [
  "operation not permitted",
  "permission denied",
  "not authorized",
  "not authorised",
];

export function tmuxSession(name: string): string {
  return `codex-${name}`;
}

export function tmuxTarget(name: string): string {
  return tmuxSession(name);
}

export function hasSessionArgs(name: string): string[] {
  return ["tmux", "has-session", "-t", tmuxTarget(name)];
}

export function listPanesArgs(target: string): string[] {
  return ["tmux", "list-panes", "-t", target, "-F", "#{pane_id}"];
}

export function capturePaneArgs(target: string, historyLines: number): string[] {
  return ["tmux", "capture-pane", "-p", "-S", `-${historyLines}`, "-t", target];
}

export function currentPaneIdWithRunner(target: string, runner: TmuxRunner): string | null {
  const result = runTmuxChecked(runner, listPanesArgs(target), { check: false });
  raiseForTmuxPermissionFailure(result);
  if (result.status !== 0) {
    return null;
  }
  for (const line of (result.stdout ?? "").split(/\r?\n/)) {
    const paneId = line.trim();
    if (paneId) {
      return paneId;
    }
  }
  return null;
}

export function captureTmuxTargetWithRunner(
  target: string,
  historyLines: number,
  runner: TmuxRunner,
): string {
  const result = runTmuxChecked(runner, capturePaneArgs(target, historyLines));
  return (result.stdout ?? "").replace(/\n+$/, "");
}

export function isTmuxPermissionError(detail: string): boolean {
  const lowered = detail.toLowerCase();
  return TMUX_PERMISSION_MARKERS.some((marker) => lowered.includes(marker));
}

export function tmuxPermissionErrorMessage(detail: string): string {
  const normalizedDetail = detail.trim() || "permission denied";
  return "tmux access was denied by the operating system or sandbox: "
    + `${normalizedDetail}. Retry from a terminal/session with tmux PTY permissions; `
    + "on macOS, grant the terminal app appropriate Privacy & Security access "
    + "and restart the terminal/tmux server.";
}

export function tmuxCommandFailureMessage(args: string[], detail: string): string {
  const command = args.join(" ");
  if (args[0] === "tmux" && isTmuxPermissionError(detail)) {
    return `${command} failed: ${tmuxPermissionErrorMessage(detail)}`;
  }
  return `${command} failed: ${detail}`;
}

export function raiseForTmuxPermissionFailure(result: TmuxCommandResult): void {
  if (result.status === 0) {
    return;
  }
  const detail = (result.stderr || result.stdout || "").trim();
  if (isTmuxPermissionError(detail)) {
    throw new Error(tmuxPermissionErrorMessage(detail));
  }
}

function runTmuxChecked(runner: TmuxRunner, args: string[], options?: { check?: boolean }): TmuxCommandResult {
  const check = options?.check ?? true;
  const result = runner(args, { check });
  if (check && result.status !== 0) {
    const detail = (result.stderr || result.stdout || `exit code ${result.status}`).trim();
    throw new Error(tmuxCommandFailureMessage(args, detail));
  }
  return result;
}

export function tmuxSessionRunning(tmuxSessionName: string, runner: TmuxRunner): boolean {
  const result = runTmuxChecked(runner, ["tmux", "has-session", "-t", tmuxSessionName], { check: false });
  raiseForTmuxPermissionFailure(result);
  return result.status === 0;
}

export function sessionExists(name: string, runner: TmuxRunner): boolean {
  const result = runTmuxChecked(runner, hasSessionArgs(name), { check: false });
  raiseForTmuxPermissionFailure(result);
  return result.status === 0;
}

export function sendTextCommandSequence(name: string, text: string): string[][] {
  const bufferName = `workerctl-${name}`;
  return [
    ["tmux", "set-buffer", "-b", bufferName, text],
    ["tmux", "paste-buffer", "-b", bufferName, "-t", tmuxTarget(name)],
    ["tmux", "send-keys", "-t", tmuxTarget(name), SUBMIT_KEY],
    ["tmux", "delete-buffer", "-b", bufferName],
  ];
}

export function sendTextWithRunner(
  name: string,
  text: string,
  runner: TmuxRunner,
  options?: { sleep?: (milliseconds: number) => void },
): void {
  if (!sessionExists(name, runner)) {
    throw new Error(`tmux session is not running for worker ${name}: ${tmuxTarget(name)}`);
  }
  const bufferName = `workerctl-${name}`;
  runTmuxChecked(runner, ["tmux", "set-buffer", "-b", bufferName, text]);
  try {
    runTmuxChecked(runner, ["tmux", "paste-buffer", "-b", bufferName, "-t", tmuxTarget(name)]);
    options?.sleep?.(PASTE_SUBMIT_DELAY_SECONDS * 1000);
    runTmuxChecked(runner, ["tmux", "send-keys", "-t", tmuxTarget(name), SUBMIT_KEY]);
  } finally {
    runTmuxChecked(runner, ["tmux", "delete-buffer", "-b", bufferName], { check: false });
  }
}

export function sessionTmuxTarget(row: { tmux_pane_id?: string | null; tmux_session?: string | null }): string {
  if (!row.tmux_session) {
    throw new Error("session has no tmux_session; cannot build tmux target (session likely registered outside tmux)");
  }
  if (row.tmux_pane_id) {
    return `${row.tmux_session}:${row.tmux_pane_id}`;
  }
  return row.tmux_session;
}

export function sendTextToSessionWithRunner(
  row: { name: string; tmux_pane_id?: string | null; tmux_session?: string | null },
  text: string,
  runner: TmuxRunner,
  options?: {
    dryRun?: boolean;
    now?: () => string;
    sideEffectAudit?: { side_effect_completed?: boolean; side_effect_started?: boolean; target?: string };
    sideEffectStartedCallback?: () => void;
    sleep?: (milliseconds: number) => void;
  },
): SendTextResult {
  const target = sessionTmuxTarget(row);
  const result: SendTextResult = {
    dry_run: options?.dryRun ?? false,
    session: row.name,
    side_effect_completed: false,
    side_effect_started: false,
    target,
    text,
    time: options?.now?.() ?? new Date().toISOString(),
  };
  if (options?.sideEffectAudit) {
    options.sideEffectAudit.side_effect_completed = false;
    options.sideEffectAudit.side_effect_started = false;
    options.sideEffectAudit.target = target;
  }
  if (result.dry_run) {
    return result;
  }
  if (!row.tmux_session || !tmuxSessionRunning(row.tmux_session, runner)) {
    throw new Error(`tmux session is not running for session ${JSON.stringify(row.name)}: ${row.tmux_session}`);
  }

  const bufferName = `workerctl-session-${row.name}`;
  try {
    runTmuxChecked(runner, ["tmux", "set-buffer", "-b", bufferName, text]);
    options?.sideEffectStartedCallback?.();
    result.side_effect_started = true;
    if (options?.sideEffectAudit) {
      options.sideEffectAudit.side_effect_started = true;
    }
    runTmuxChecked(runner, ["tmux", "paste-buffer", "-b", bufferName, "-t", target]);
    options?.sleep?.(PASTE_SUBMIT_DELAY_SECONDS * 1000);
    runTmuxChecked(runner, ["tmux", "send-keys", "-t", target, SUBMIT_KEY]);
    result.side_effect_completed = true;
    if (options?.sideEffectAudit) {
      options.sideEffectAudit.side_effect_completed = true;
    }
  } finally {
    runTmuxChecked(runner, ["tmux", "delete-buffer", "-b", bufferName], { check: false });
  }
  return result;
}
