export type TerminalResizeMessage = {
  cols: number;
  rows: number;
  type: "resize";
};

const CONTROL_MARKER = "dashboard-terminal-control";

export function encodeTerminalResizeMessage(cols: number, rows: number): string {
  return JSON.stringify({ marker: CONTROL_MARKER, type: "resize", cols, rows });
}

export function parseTerminalControlMessage(message: string): TerminalResizeMessage | null {
  if (!message.startsWith("{")) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(message);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }

  const record = parsed as Record<string, unknown>;
  if (record.marker !== CONTROL_MARKER || record.type !== "resize") {
    return null;
  }

  const cols = record.cols;
  const rows = record.rows;
  if (typeof cols !== "number" || typeof rows !== "number" || !Number.isInteger(cols) || !Number.isInteger(rows)) {
    return null;
  }
  if (cols < 2 || rows < 2 || cols > 500 || rows > 500) {
    return null;
  }

  return { type: "resize", cols, rows };
}
