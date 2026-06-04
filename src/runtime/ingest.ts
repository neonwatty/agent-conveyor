import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

export interface ParsedCodexEvent {
  byte_offset: number;
  new_offset: number;
  payload: Record<string, unknown>;
  subtype: string | null;
  timestamp: unknown;
  type: string;
}

export interface IngestResult {
  new_events: number;
  new_offset: number;
  skipped_lines: number;
}

export class IngestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IngestError";
  }
}

const STATE_MAP = new Map([
  ["task_started", "busy"],
  ["user_message", "busy"],
  ["task_complete", "idle"],
]);

export function parseJsonlEvents(content: Buffer, options: { startOffset: number }): ParsedCodexEvent[] {
  return parseJsonlEventsWithStats(content, options).events;
}

export function parseJsonlEventsWithStats(
  content: Buffer,
  options: { startOffset: number },
): { events: ParsedCodexEvent[]; skipped: number } {
  const events: ParsedCodexEvent[] = [];
  let skipped = 0;
  let cursor = 0;
  while (true) {
    const newline = content.indexOf(0x0a, cursor);
    if (newline === -1) {
      break;
    }
    const lineBytes = content.subarray(cursor, newline);
    const nextCursor = newline + 1;
    const absoluteLineStart = options.startOffset + cursor;
    const absoluteAfterLine = options.startOffset + nextCursor;
    cursor = nextCursor;

    let record: unknown;
    try {
      record = JSON.parse(lineBytes.toString("utf8"));
    } catch {
      skipped += 1;
      continue;
    }
    if (!isRecord(record) || typeof record.type !== "string") {
      skipped += 1;
      continue;
    }
    const payload = isRecord(record.payload) ? record.payload : {};
    const rawSubtype = record.type === "event_msg" ? payload.type : null;
    events.push({
      byte_offset: absoluteLineStart,
      new_offset: absoluteAfterLine,
      payload,
      subtype: typeof rawSubtype === "string" ? rawSubtype : null,
      timestamp: record.timestamp,
      type: record.type,
    });
  }
  return { events, skipped };
}

export function inferState(event: Pick<ParsedCodexEvent, "subtype" | "type">): string | null {
  if (event.type !== "event_msg" || typeof event.subtype !== "string") {
    return null;
  }
  return STATE_MAP.get(event.subtype) ?? null;
}

export function ingestSessionSync(
  database: DatabaseSync,
  options: { now?: string; sessionName: string },
): IngestResult {
  const row = database.prepare(`
    select id, state, codex_session_path, last_ingest_offset
    from sessions
    where name = ?
  `).get(options.sessionName) as {
    codex_session_path: string | null;
    id: string;
    last_ingest_offset: number | null;
    state: string;
  } | undefined;
  if (!row) {
    throw new IngestError(`Unknown session: ${options.sessionName}`);
  }
  if (row.state !== "active") {
    throw new IngestError(
      `session ${JSON.stringify(options.sessionName)} is in state ${JSON.stringify(row.state)}; re-register it before ingesting`,
    );
  }
  if (!row.codex_session_path) {
    throw new IngestError(`session ${JSON.stringify(options.sessionName)} has no codex_session_path`);
  }
  if (!existsSync(row.codex_session_path)) {
    throw new IngestError(`rollout file does not exist: ${row.codex_session_path}`);
  }

  const startOffset = row.last_ingest_offset ?? 0;
  const fileSize = statSync(row.codex_session_path).size;
  if (startOffset > fileSize) {
    throw new IngestError(
      `rollout file shrank: cached offset ${startOffset} > current size ${fileSize}. `
      + "The rollout was likely rotated or truncated. Reset the session's last_ingest_offset "
      + "(e.g. via re-register) before retrying.",
    );
  }

  const content = readFileSync(row.codex_session_path).subarray(startOffset);
  const timestamp = options.now ?? new Date().toISOString();
  const parsed = parseJsonlEventsWithStats(content, { startOffset });
  let newEvents = 0;
  let newOffset = startOffset;

  const insertCodexEvent = database.prepare(`
    insert into codex_events(
      session_id, timestamp, type, subtype, payload_json, byte_offset, ingested_at
    )
    values (?, ?, ?, ?, ?, ?, ?)
  `);
  for (const event of parsed.events) {
    insertCodexEvent.run(
      row.id,
      typeof event.timestamp === "string" && event.timestamp ? event.timestamp : timestamp,
      event.type,
      event.subtype,
      stableJson(event.payload),
      event.byte_offset,
      timestamp,
    );
    newOffset = event.new_offset;
    newEvents += 1;
  }

  if (newOffset !== startOffset) {
    database.prepare("update sessions set last_ingest_offset = ? where id = ?").run(newOffset, row.id);
  }
  database.prepare("update sessions set last_heartbeat_at = ? where id = ?").run(timestamp, row.id);
  emitIngestTelemetry(database, {
    newEvents,
    newOffset,
    sessionId: row.id,
    sessionName: options.sessionName,
    skippedLines: parsed.skipped,
    startOffset,
    timestamp,
  });

  return {
    new_events: newEvents,
    new_offset: newOffset,
    skipped_lines: parsed.skipped,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function emitIngestTelemetry(
  database: DatabaseSync,
  options: {
    newEvents: number;
    newOffset: number;
    sessionId: string;
    sessionName: string;
    skippedLines: number;
    startOffset: number;
    timestamp: string;
  },
): void {
  const taskId = activeTaskIdForSession(database, options.sessionId);
  const eventId = `telemetry-${randomUUID()}`;
  const correlationJson = stableJson({
    session: options.sessionName,
    session_id: options.sessionId,
  });
  const attributesJson = stableJson({
    new_events: options.newEvents,
    new_offset: options.newOffset,
    skipped_lines: options.skippedLines,
    start_offset: options.startOffset,
  });
  database.prepare(`
    insert into telemetry_events(
      id, run_id, task_id, timestamp, actor, event_type, severity,
      summary, correlation_json, attributes_json
    )
    values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    eventId,
    null,
    taskId,
    options.timestamp,
    "workerctl",
    "codex_events_ingested",
    "info",
    `Ingested Codex events for session ${options.sessionName}.`,
    correlationJson,
    attributesJson,
  );
  database.prepare(`
    insert into telemetry_events_fts(
      event_id, task_id, run_id, actor, event_type, summary, attributes
    )
    values (?, ?, ?, ?, ?, ?, ?)
  `).run(
    eventId,
    taskId,
    null,
    "workerctl",
    "codex_events_ingested",
    `Ingested Codex events for session ${options.sessionName}.`,
    attributesJson,
  );
}

function activeTaskIdForSession(database: DatabaseSync, sessionId: string): string | null {
  const row = database.prepare(`
    select task_id
    from bindings
    where state in ('active', 'ending')
      and (worker_session_id = ? or manager_session_id = ?)
    order by id desc
    limit 1
  `).get(sessionId, sessionId) as { task_id: string } | undefined;
  return row?.task_id ?? null;
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, sortJson(child)]),
    );
  }
  return value;
}
