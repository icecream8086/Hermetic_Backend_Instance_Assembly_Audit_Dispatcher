/**
 * Real-time log tail — journalctl -f model.
 *
 * Provides cursor-based incremental log streaming via:
 *   - WebSocket push (active connection)
 *   - Poll mode (HTTP long-poll with cursor)
 *
 * The consumer stores the last consumed cursor and resumes from that point.
 * This mirrors journald's `--after-cursor` + `--cursor-file` pattern (§5).
 */

import type { IAuditReader, StoredAuditEntry, LogQuery } from './types.ts';

// ─── Tail session ───

export interface TailSession {
  /** Last consumed cursor position. */
  cursor: string;
  /** Poll interval in ms. */
  intervalMs: number;
  /** Max entries per poll. */
  batchSize: number;
  /** Subscribers that receive each batch. */
  subscribers: Set<(entries: readonly StoredAuditEntry[]) => void>;
  /** Timer handle for cleanup. */
  timer?: ReturnType<typeof setInterval>;
}

export function createTailSession(intervalMs = 2000, batchSize = 50): TailSession {
  return {
    cursor: '',
    intervalMs,
    batchSize,
    subscribers: new Set(),
  };
}

// ─── Poll-based tail ───

export interface TailOptions {
  /** Facility filter (optional). */
  facility?: string;
  /** Minimum severity level (0-7). */
  minLevel?: number;
}

export async function pollTail(
  reader: IAuditReader,
  session: TailSession,
  options: TailOptions = {},
): Promise<{ entries: readonly StoredAuditEntry[]; newCursor: string }> {
  const params: LogQuery = {
    limit: session.batchSize,
    ...(options.facility ? { facility: options.facility } : {}),
    ...(session.cursor ? { afterCursor: session.cursor } : {}),
  };

  const result = await reader.query(params);
  const entries = result.entries;
  const newCursor = result.nextCursor ?? session.cursor;

  if (entries.length > 0) {
    session.cursor = newCursor;
    for (const sub of session.subscribers) {
      try { sub(entries); } catch {
        console.debug("subscriber error");
      }
    }
  }

  return { entries, newCursor };
}

/** Start a tail session that polls at regular intervals. */
export function startTail(
  reader: IAuditReader,
  session: TailSession,
  options: TailOptions = {},
): () => void {
  const timer = setInterval(() => {
    try { pollTail(reader, session, options); } catch {
      console.debug("noop");
    }
  }, session.intervalMs);
  session.timer = timer;
  return () => { clearInterval(timer); };
}

/** Stop a tail session. */
export function stopTail(session: TailSession): void {
  if (session.timer) clearInterval(session.timer);
  session.subscribers.clear();
}

// ─── WebSocket message format ───

export interface TailWsMessage {
  type: 'tail:batch' | 'tail:error' | 'tail:ping';
  cursor?: string;
  entries?: StoredAuditEntry[];
  error?: string;
}

/** Create a WebSocket tail handler that pushes log batches to connected clients. */
export function createWsTailHandler(
  reader: IAuditReader,
  options: TailOptions = {},
): { handle(send: (msg: TailWsMessage) => void, close: () => void, pollIntervalMs?: number): Promise<void> } {
  return {
    /** Upgrade an HTTP request to a WebSocket tail session. */
    async handle(
      send: (msg: TailWsMessage) => void,
      close: () => void,
      pollIntervalMs = 2000,
    ) {
      const session = createTailSession(pollIntervalMs);
      session.subscribers.add((entries) => {
        send({ type: 'tail:batch', cursor: session.cursor, entries: [...entries] });
      });

      // Send initial batch
      const { entries, newCursor } = await pollTail(reader, session, options);
      if (entries.length > 0) {
        send({ type: 'tail:batch', cursor: newCursor, entries: [...entries] });
      }

      // Start polling
      const stop = startTail(reader, session, options);

      // Ping every 30s
      const pingTimer = setInterval(() => { send({ type: 'tail:ping' }); }, 30000);

      return () => {
        stop();
        clearInterval(pingTimer);
        close();
      };
    },
  };
}
