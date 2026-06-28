/**
 * Cloudflare Log Reader — queries from R2/Logpush persistent logs.
 */
import type { IBlobStore } from '../../core/store/interfaces.ts';
import type { IAuditReader, StoredAuditEntry, LogQuery } from '../../core/audit/types.ts';
import type { LogId } from '../../core/brand.ts';

const LINE_REGEX = /^\[(.+?)\]\s+(\w+):\s+\[(\w[\w-]*)\]\s+(.+)$/;

export class CloudflareLogReader implements IAuditReader {
  public constructor(
    private readonly blob: IBlobStore,
    private readonly prefix = 'logs',
  ) {}

  public async query(params?: LogQuery): Promise<{ entries: StoredAuditEntry[]; nextCursor?: string; total?: number }> {
    return this.queryAsync(params ?? { facility: 'logs' });
  }

  public async getById(_id: LogId): Promise<StoredAuditEntry | null> {
    return null; // Logpush logs are line-based, not id-indexed
  }

  public async queryAsync(params: LogQuery): Promise<{ entries: StoredAuditEntry[]; nextCursor?: string; total?: number }> {
    const since = params.startTs ?? 0;
    const until = params.endTs ?? Date.now();
    const facility = params.facility;
    const limit = params.limit ?? 50;

    const keys = this.#buildDateKeys(since, until);
    const results: StoredAuditEntry[] = [];

    for (const key of keys) {
      if (results.length >= limit) break;
      try {
        const stream = await this.blob.get(key);
        if (!stream) continue;
        const reader = stream.getReader();
        const chunks: Uint8Array[] = [];
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
        }
        const totalSize = chunks.reduce((s, c) => s + c.byteLength, 0);
        const merged = new Uint8Array(totalSize);
        let offset = 0;
        for (const c of chunks) { merged.set(c, offset); offset += c.byteLength; }
        const text = new TextDecoder().decode(merged);
        const lines = text.split('\n').filter(Boolean);

        for (const line of lines) {
          if (results.length >= limit) break;
          const entry = this.#parseLine(line, since, until, facility);
          if (entry) results.push(entry);
        }
      } catch { /* skip unreadable R2 keys */ }
    }
    return { entries: results, total: results.length };
  }

  #buildDateKeys(since: number, until: number): string[] {
    const keys: string[] = [];
    const d = new Date(since);
    d.setUTCHours(0, 0, 0, 0);
    while (d.getTime() <= until) {
      const yyyy = d.getUTCFullYear();
      const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
      const dd = String(d.getUTCDate()).padStart(2, '0');
      for (let h = 0; h < 24; h++) {
        keys.push(`${this.prefix}/${yyyy}/${mm}/${dd}/${String(h).padStart(2, '0')}/`);
      }
      d.setUTCDate(d.getUTCDate() + 1);
    }
    return keys;
  }

  #parseLine(line: string, since: number, until: number, facility?: string): StoredAuditEntry | null {
    const match = LINE_REGEX.exec(line);
    if (!match) return null;
    const [, ts, _level, lineFacility, message] = match;
    const timestamp = new Date(ts!).getTime();
    if (timestamp < since || timestamp > until) return null;
    if (facility && lineFacility !== facility) return null;
    return {
      id: crypto.randomUUID(),
      timestamp,
      level: 6, // default INFO
      facility: lineFacility ?? 'unknown',
      message: message ?? '',
    };
  }
}
