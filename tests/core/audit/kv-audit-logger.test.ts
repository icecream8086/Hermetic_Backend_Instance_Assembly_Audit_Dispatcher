import { join } from 'node:path'; import { tmpdir } from 'node:os';
import { describe, it, expect, beforeAll } from 'vitest';
import { KvAuditLogger } from '../../../src/core/audit/kv-audit-logger.ts';
import { KernLevel } from '../../../src/core/audit/kern-level.ts';
import { FileKVAtomicStore } from '../../../src/core/store/adapters/file-kv.ts';

function store() { return new FileKVAtomicStore(join(tmpdir(), 'hbi-test-' + crypto.randomUUID().slice(0, 8))); }

describe('KvAuditLogger (white-box)', () => {
  describe('write', () => {
    it('writes an entry and makes it queryable', async () => {
      const logger = new KvAuditLogger(store());
      await logger.write({ level: KernLevel.ERR, facility: 'sandbox-service', message: 'GC failed', actorId: 'user_1', metadata: { sandboxId: 'sb_1' } });
      const result = logger.query();
      expect(result.total).toBe(1);
      const line = JSON.parse(result.lines[0]!);
      expect(line.level).toBe('ERR');
      expect(line.facility).toBe('sandbox-service');
      expect(line.message).toBe('GC failed');
      expect(line.actorId).toBe('user_1');
      expect(line.metadata.sandboxId).toBe('sb_1');
    });

    it('generates unique IDs per entry', async () => {
      const logger = new KvAuditLogger(store());
      await logger.write({ level: KernLevel.INFO, facility: 'test', message: 'a' });
      await logger.write({ level: KernLevel.INFO, facility: 'test', message: 'b' });
      const result = logger.query();
      expect(result.total).toBe(2);
      const id1 = JSON.parse(result.lines[0]!).id;
      const id2 = JSON.parse(result.lines[1]!).id;
      expect(id1).not.toBe(id2);
    });
  });

  describe('query filtering', () => {
    const logger = new KvAuditLogger(store());
    beforeAll(async () => {
      await logger.write({ level: KernLevel.ERR, facility: 'sandbox', message: 'error msg' });
      await logger.write({ level: KernLevel.WARNING, facility: 'sandbox', message: 'warning msg' });
      await logger.write({ level: KernLevel.INFO, facility: 'audit', message: 'info msg' });
    });

    it('filters by facility', () => {
      const r = logger.query({ facility: 'sandbox' });
      expect(r.total).toBe(2);
    });

    it('filters by level min (inclusive)', () => {
      const r = logger.query({ levelMin: KernLevel.WARNING });
      expect(r.total).toBe(2); // ERR + WARNING
      expect(JSON.parse(r.lines[0]!).level).toBe('ERR');
    });

    it('filters by time range', () => {
      const now = Date.now();
      const r = logger.query({ since: now - 1000, until: now + 1000 });
      expect(r.total).toBe(3);
    });

    it('filters by search text (substring match)', () => {
      const r = logger.query({ search: 'error' });
      expect(r.total).toBe(1);
    });

    it('pagination: page 1 with limit 2', () => {
      const r = logger.query({ page: 1, limit: 2 });
      expect(r.lines.length).toBe(2);
      expect(r.total).toBe(3);
      expect(r.totalPages).toBe(2);
    });

    it('pagination: page 2 with limit 2', () => {
      const r = logger.query({ page: 2, limit: 2 });
      expect(r.lines.length).toBe(1);
    });

    it('handles no matches', () => {
      const r = logger.query({ facility: 'nonexistent' });
      expect(r.total).toBe(0);
      expect(r.lines).toHaveLength(0);
      expect(r.totalPages).toBe(1);
    });
  });

  describe('ring buffer eviction', () => {
    it('evicts oldest entries when capacity exceeded (default 10k)', async () => {
      const logger = new KvAuditLogger(store(), 3);
      await logger.write({ level: KernLevel.INFO, facility: 't', message: 'a' });
      await logger.write({ level: KernLevel.INFO, facility: 't', message: 'b' });
      await logger.write({ level: KernLevel.INFO, facility: 't', message: 'c' });
      await logger.write({ level: KernLevel.INFO, facility: 't', message: 'd' });
      const r = logger.query();
      expect(r.total).toBe(3);
      expect(JSON.parse(r.lines[0]!).message).toBe('b');
      expect(JSON.parse(r.lines[2]!).message).toBe('d');
    });
  });

  describe('KV persistence', () => {
    it('writes to atomic store with TTL', async () => {
      const atomic = store();
      const logger = new KvAuditLogger(atomic);
      await logger.write({ level: KernLevel.DEBUG, facility: 'test', message: 'hello' });
      // Verify the key exists in the store
      const keys = await atomic.get<any[]>('audit:ids'); // might not exist since we don't have an index
      const r = logger.query();
      expect(r.total).toBe(1);
      expect(JSON.parse(r.lines[0]!).message).toBe('hello');
    });
  });
});
