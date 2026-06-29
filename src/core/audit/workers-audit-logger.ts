import type { IAuditWriter, IAuditReader, IAuditAdmin, AuditEntry, StoredAuditEntry, LogQuery } from './types.ts';
import type { LogId } from '../brand.ts';
import { generateLogId } from '../brand.ts';
import { KernLevel, kernLevelName, resolveFacility, encodePriority } from './kern-level.ts';
import { shouldLogAudit } from './log-policy.ts';
import { encodeCursor, decodeCursor, cursorFromEntry, xorHash } from './types.ts';
import { getBootId } from './context.ts';

const MAX_IN_MEMORY = 500;

/** Strip _-prefixed keys to prevent trusted field forgery (journald convention). */
function sanitizeMetadata(meta: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!meta) return undefined;
  const cleaned: Record<string, unknown> = {};
  let hasKeys = false;
  for (const [k, v] of Object.entries(meta)) {
    if (!k.startsWith('_')) { cleaned[k] = v; hasKeys = true; }
  }
  return hasKeys ? cleaned : undefined;
}

/**
 * Cloudflare Workers audit logger.
 *
 * Write: console.log/warn/error → Workers Logs (platform-level, free)
 * Query: in-memory ring buffer (last 500 entries) — no persistent storage.
 *
 * Workers Logs has no historical query API on the platform.
 * For persistent queryable audit, use AUDIT_BACKEND=hybrid (DO/KV) instead.
 */
export class WorkersAuditLogger implements IAuditWriter, IAuditReader, IAuditAdmin {
  readonly #memory: StoredAuditEntry[] = [];
  #seq = 0;
  readonly #bootId: string;
  readonly #machineHash: string;

  public constructor() {
    this.#bootId = getBootId() ?? '00000000-0000-0000-0000-000000000000';
    this.#machineHash = hashBootIdStr(this.#bootId);
  }

  public write(entry: AuditEntry): void {
    this.#output(entry);
  }

  #output(entry: AuditEntry): void {
    const ts = new Date().toISOString();
    const facility = entry.facility ?? 'audit';
    const levelName = kernLevelName(entry.level);

    if (!shouldLogAudit(facility, entry.level)) return;

    // Platform log line
    const line = `[${ts}] ${levelName}: [${facility}] ${entry.message}`;
    // Strip _-prefixed keys from metadata to prevent trusted field forgery (journald convention).
    const safeMeta = sanitizeMetadata(entry.metadata);
    const meta = safeMeta ? JSON.stringify(safeMeta) : undefined;

    if (entry.level <= KernLevel.ERR) {
      if (meta) { console.error(line, meta); } else { console.error(line); }
    } else if (entry.level === KernLevel.WARNING) {
      if (meta) { console.warn(line, meta); } else { console.warn(line); }
    } else {
      if (meta) { console.log(line, meta); } else { console.log(line); }
    }

    // Keep in-memory ring buffer for recent query
    const seq = ++this.#seq;
    const id = generateLogId();
    const now = Date.now();
    const cursor = encodeCursor(cursorFromEntry(
      { id, timestamp: now } as unknown as StoredAuditEntry,
      this.#bootId,
      seq,
      this.#machineHash,
    ));
    const stored: StoredAuditEntry = {
      id,
      timestamp: now,
      priority: encodePriority(resolveFacility(facility), entry.level),
      level: entry.level,
      facility,
      message: entry.message,
      actorId: entry.actorId,
      cursor,
      ...(entry.trusted ? { trusted: entry.trusted } : {}),
      ...(safeMeta ? { metadata: safeMeta } : {}),
    };
    this.#memory.push(stored);
    if (this.#memory.length > MAX_IN_MEMORY) this.#memory.shift();
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- interface contract requires Promise<T>
  public async query(params?: LogQuery): Promise<{ entries: StoredAuditEntry[]; nextCursor?: string; total?: number }> {
    let f = [...this.#memory].reverse(); // newest first
    if (params?.facility) f = f.filter(e => e.facility === params.facility);
    if (params?.startTs !== undefined) f = f.filter(e => e.timestamp >= params.startTs!);
    if (params?.endTs !== undefined) f = f.filter(e => e.timestamp <= params.endTs!);
    // Apply afterCursor filter with tamper validation.
    if (params?.afterCursor) {
      const cursor = decodeCursor(params.afterCursor);
      if (cursor && validateCursor(cursor)) {
        f = f.filter(e => {
          if (!e.cursor) return true;
          const ec = decodeCursor(e.cursor);
          return ec ? ec.i > cursor.i : true;
        });
      }
    }
    // Compute total BEFORE slicing (SPEC: total = full matching count, not page size).
    const total = f.length;
    // Apply offset + limit for page-based pagination.
    if (params?.offset) f = f.slice(params.offset);
    if (params?.limit) f = f.slice(0, params.limit);
    const lastCursor: string | undefined = f.at(-1)?.cursor;
    return { entries: f, total, ...(lastCursor ? { nextCursor: lastCursor } : {}) };
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- interface contract requires Promise<T>
  public async getById(id: LogId): Promise<StoredAuditEntry | null> {
    return this.#memory.find(e => e.id === id) ?? null;
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- interface contract requires Promise<T>
  public async prune(_beforeTs: number): Promise<number> { return 0; }
  // eslint-disable-next-line @typescript-eslint/require-await -- interface contract requires Promise<T>
  public async pruneByIds(_ids: readonly string[]): Promise<number> { return 0; }
}

/** Validate cursor integrity via xor_hash. Returns false if tampered. */
function validateCursor(c: { s: string; i: number; b: string; m: number; t: number; x: string }): boolean {
  const expected = xorHash({ s: c.s, i: c.i, b: c.b, m: c.m, t: c.t });
  return c.x === expected;
}

/** Derive a short machine hash from a boot UUID for cursor.s field. */
function hashBootIdStr(bootId: string): string {
  let h = 0;
  for (let i = 0; i < bootId.length; i++) h ^= bootId.charCodeAt(i) << ((i % 4) * 8);
  return (h >>> 0).toString(16).padStart(8, '0');
}
