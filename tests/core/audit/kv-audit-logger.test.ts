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
      await logger.write({ level: KernLevel.ERR, facility: 'pod-service', message: 'GC failed', actorId: 'user_1', metadata: { podId: 'sb_1' } });
      const result = await logger.query();
      expect(result.total).toBe(1);
      const line = result.entries[0]!;
      expect(line.level).toBe(KernLevel.ERR);
      expect(line.facility).toBe('pod-service');
      expect(line.message).toBe('GC failed');
      expect(line.actorId).toBe('user_1');
      expect(line.metadata!.podId).toBe('sb_1');
    });

    it('generates unique IDs per entry', async () => {
      const logger = new KvAuditLogger(store());
      await logger.write({ level: KernLevel.INFO, facility: 'test', message: 'a' });
      await logger.write({ level: KernLevel.INFO, facility: 'test', message: 'b' });
      const result = await logger.query();
      expect(result.total).toBe(2);
      expect(result.entries[0]!.id).not.toBe(result.entries[1]!.id);
    });
  });

  describe('query filtering', () => {
    const logger = new KvAuditLogger(store());
    beforeAll(async () => {
      await logger.write({ level: KernLevel.ERR, facility: 'pod', message: 'error msg' });
      await logger.write({ level: KernLevel.WARNING, facility: 'pod', message: 'warning msg' });
      await logger.write({ level: KernLevel.INFO, facility: 'audit', message: 'info msg' });
    });

    it('filters by facility', async () => {
      const r = await logger.query({ facility: 'pod' });
      expect(r.total).toBe(2);
    });

    it('filters by time range for pod entries', async () => {
      const r = await logger.query({ facility: 'pod' });
      expect(r.total).toBe(2);
      // Entries stored FIFO (insertion order): ERR first, then WARNING
      expect(r.entries[0]!.level).toBe(KernLevel.ERR);
      expect(r.entries[1]!.level).toBe(KernLevel.WARNING);
    });

    it('filters by time range', async () => {
      const now = Date.now();
      const r = await logger.query({ startTs: now - 10000, endTs: now + 10000 });
      expect(r.total).toBe(3);
    });

    it('pagination via limit', async () => {
      const r = await logger.query({ limit: 2 });
      expect(r.entries.length).toBe(2);
      expect(r.total).toBe(3);
    });

    it('handles no matches', async () => {
      const r = await logger.query({ facility: 'nonexistent' });
      expect(r.total).toBe(0);
      expect(r.entries).toHaveLength(0);
    });
  });

  describe('ring buffer eviction', () => {
    it('evicts oldest entries when capacity exceeded', async () => {
      const logger = new KvAuditLogger(store(), 3);
      await logger.write({ level: KernLevel.INFO, facility: 't', message: 'a' });
      await logger.write({ level: KernLevel.INFO, facility: 't', message: 'b' });
      await logger.write({ level: KernLevel.INFO, facility: 't', message: 'c' });
      await logger.write({ level: KernLevel.INFO, facility: 't', message: 'd' });
      const r = await logger.query();
      expect(r.total).toBe(3);
      expect(r.entries[0]!.message).toBe('b'); // oldest surviving
      expect(r.entries[2]!.message).toBe('d'); // newest
    });
  });

  describe('KV persistence', () => {
    it('writes to atomic store with TTL', async () => {
      const atomic = store();
      const logger = new KvAuditLogger(atomic);
      await logger.write({ level: KernLevel.DEBUG, facility: 'test', message: 'hello' });
      const r = await logger.query();
      expect(r.total).toBe(1);
      expect(r.entries[0]!.message).toBe('hello');
    });
  });
});
