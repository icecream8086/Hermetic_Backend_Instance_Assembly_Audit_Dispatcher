/// <reference types="@cloudflare/workers-types" />

import { describe, it, expect } from 'vitest';
import {
  DurableObjectAtomicStore,
  AtomicStoreDO,
} from '../../../../src/core/store/adapters/durable-object.ts';

// ─── Mock helpers ───

/** In-memory "DO storage" that mimics DurableObjectStorage. */
function createMockStorage(): DurableObjectStorage {
  const data = new Map<string, unknown>();
  return {
    get: async <T>(key: string) => data.get(key) as T | undefined,
    put: async (key: string, value: unknown) => { data.set(key, value); },
    delete: async (key: string) => { data.delete(key); },
    list: async () => data,
    transaction: async <T>(fn: () => T) => fn(),
    getAlarm: async () => undefined,
    setAlarm: async () => {},
    deleteAlarm: async () => {},
    sync: async () => {},
    sql: undefined,
  } as unknown as DurableObjectStorage;
}

/** Create a mock DurableObjectStub backed by an in-memory store.
 *  `dataRef` lets white-box tests inspect the internal Map after operations. */
function createMockStub(dataRef?: { current: Map<string, { v: unknown; _ver: string }> }): DurableObjectStub {
  const data = new Map<string, { v: unknown; _ver: string }>();
  if (dataRef) dataRef.current = data;

  const handler = async (req: Request): Promise<Response> => {
    const { op, key, value, expectedVersion, txnOps } = await req.json() as {
      op: string;
      key?: string;
      value?: unknown;
      expectedVersion?: string | null;
      txnOps?: Array<{ op: string; key: string; value?: unknown }>;
    };

    switch (op) {
      case 'get': {
        const entry = data.get(key!);
        if (!entry) return Response.json({ value: null, version: null });
        return Response.json({ value: entry.v, version: entry._ver });
      }
      case 'set': {
        const current = data.get(key!) ?? null;
        const curVer = (current as { _ver?: string } | null)?._ver ?? null;
        if (expectedVersion !== curVer) return Response.json({ version: null, conflict: true });

        const newVersion = crypto.randomUUID();
        data.set(key!, { v: value, _ver: newVersion });
        return Response.json({ version: newVersion });
      }
      case 'transact': {
        if (!txnOps) return Response.json({ error: 'Missing txnOps' }, { status: 400 });
        const results: unknown[] = [];
        for (const txnOp of txnOps) {
          if (txnOp.op === 'get') {
            const entry = data.get(txnOp.key);
            results.push(entry ? (entry as { v: unknown }).v : null);
          } else {
            const newVersion = crypto.randomUUID();
            data.set(txnOp.key, { v: txnOp.value, _ver: newVersion });
            results.push(null);
          }
        }
        return Response.json({ results });
      }
      default:
        return Response.json({ error: `Unknown op: ${op}` }, { status: 400 });
    }
  };

  return {
    fetch: async (url: string | URL, init?: RequestInit | Request) => {
      const req = init instanceof Request ? init : new Request(url, init);
      return handler(req);
    },
  } as unknown as DurableObjectStub;
}

/** Create a mock DurableObjectNamespace that returns the given stub. */
function createMockNs(stub: DurableObjectStub): DurableObjectNamespace {
  return {
    idFromName: (_name: string) => 'test-do-id' as unknown as DurableObjectId,
    idFromString: (_s: string) => 'test-do-id' as unknown as DurableObjectId,
    get: (_id: DurableObjectId) => stub,
    newUniqueId: () => 'new-id' as unknown as DurableObjectId,
  } as unknown as DurableObjectNamespace;
}

// ─── DurableObjectAtomicStore adapter tests ───

describe('DurableObjectAtomicStore (white-box)', () => {
  describe('get / set', () => {
    it('get returns null for non-existent key', async () => {
      const store = new DurableObjectAtomicStore(createMockNs(createMockStub()));
      const result = await store.get('missing');
      expect(result).toBeNull();
    });

    it('set with expectedVersion=null creates a new entry', async () => {
      const store = new DurableObjectAtomicStore(createMockNs(createMockStub()));
      const version = await store.set('key', { data: 42 }, null);

      expect(version).toBeTruthy();
      expect(typeof version).toBe('string');

      // White-box: read back to verify
      const result = await store.get<{ data: number }>('key');
      expect(result).not.toBeNull();
      expect(result!.value).toEqual({ data: 42 });
      expect(result!.version).toBe(version);
    });

    it('set with expectedVersion=null rejects existing key', async () => {
      const store = new DurableObjectAtomicStore(createMockNs(createMockStub()));
      await store.set('key', 'first', null);
      const v2 = await store.set('key', 'second', null);

      expect(v2).toBeNull();

      // Value unchanged
      const result = await store.get<string>('key');
      expect(result!.value).toBe('first');
    });

    it('set with matching version succeeds (update)', async () => {
      const store = new DurableObjectAtomicStore(createMockNs(createMockStub()));
      const v1 = await store.set('key', 'v1', null);
      const v2 = await store.set('key', 'v2', v1);

      expect(v2).toBeTruthy();
      expect(v2).not.toBe(v1);

      const result = await store.get<string>('key');
      expect(result!.value).toBe('v2');
      expect(result!.version).toBe(v2);
    });

    it('set with stale version fails (concurrent write)', async () => {
      const store = new DurableObjectAtomicStore(createMockNs(createMockStub()));
      await store.set('key', 'real', null);
      const v2 = await store.set('key', 'stale', 'wrong-version' as any);

      expect(v2).toBeNull();

      const result = await store.get<string>('key');
      expect(result!.value).toBe('real');
    });

    it('version changes on each successful set', async () => {
      const store = new DurableObjectAtomicStore(createMockNs(createMockStub()));
      const v1 = await store.set('k', 1, null);
      const v2 = await store.set('k', 2, v1);
      const v3 = await store.set('k', 3, v2);

      expect(v1).not.toBe(v2);
      expect(v2).not.toBe(v3);
    });

    it('get retrieves complex nested objects', async () => {
      const store = new DurableObjectAtomicStore(createMockNs(createMockStub()));
      const obj = { arr: [1, 'two', false], nested: { x: 1 } };
      await store.set('complex', obj, null);

      const result = await store.get<typeof obj>('complex');
      expect(result!.value).toEqual(obj);
    });
  });

  describe('transact', () => {
    it('writes a single key and returns action result', async () => {
      const dataRef: { current: Map<string, { v: unknown; _ver: string }> } = { current: new Map() };
      const store = new DurableObjectAtomicStore(createMockNs(createMockStub(dataRef)));

      const result = await store.transact(async (txn) => {
        await txn.set('k', 'value');
        return 42;
      });

      expect(result).toBe(42);
      // White-box: verify the mock's internal storage
      const entry = dataRef.current.get('k');
      expect(entry).toBeDefined();
      expect(entry!.v).toBe('value');
      expect(typeof entry!._ver).toBe('string');
    });

    it('multiple writes in one transaction all commit', async () => {
      const dataRef: { current: Map<string, { v: unknown; _ver: string }> } = { current: new Map() };
      const store = new DurableObjectAtomicStore(createMockNs(createMockStub(dataRef)));

      await store.transact(async (txn) => {
        await txn.set('x', 1);
        await txn.set('y', 2);
        await txn.set('z', 3);
      });

      // White-box: inspect internal storage
      const all: Record<string, unknown> = {};
      for (const [k, v] of dataRef.current) all[k] = v;
      expect(all).toEqual({
        x: { v: 1, _ver: expect.any(String) },
        y: { v: 2, _ver: expect.any(String) },
        z: { v: 3, _ver: expect.any(String) },
      });
    });
  });
});

// ─── AtomicStoreDO class (white-box: DO runtime internals) ───

describe('AtomicStoreDO (white-box)', () => {
  function createDO(): { do: AtomicStoreDO; storage: DurableObjectStorage } {
    const storage = createMockStorage();
    const doInstance = new AtomicStoreDO();
    // The DO runtime injects ctx — we wire up a minimal mock
    (doInstance as any).ctx = { storage } as DurableObjectState;
    return { do: doInstance, storage };
  }

  describe('op: get', () => {
    it('returns null for missing key', async () => {
      const { do: doInst } = createDO();
      const req = new Request('https://do/op', {
        method: 'POST',
        body: JSON.stringify({ op: 'get', key: 'missing' }),
      });
      const resp = await doInst.fetch(req);
      const body = await resp.json() as { value: unknown; version: unknown };
      expect(body.value).toBeNull();
      expect(body.version).toBeNull();
    });

    it('returns stored value and version', async () => {
      const { do: doInst, storage } = createDO();
      await storage.put('k', { v: 'hello', _ver: 'v1' });

      const resp = await doInst.fetch(new Request('https://do/op', {
        method: 'POST',
        body: JSON.stringify({ op: 'get', key: 'k' }),
      }));
      const body = await resp.json() as { value: string; version: string };
      expect(body.value).toBe('hello');
      expect(body.version).toBe('v1');
    });
  });

  describe('op: set', () => {
    it('creates a new entry with expectedVersion=null', async () => {
      const { do: doInst } = createDO();
      const resp = await doInst.fetch(new Request('https://do/op', {
        method: 'POST',
        body: JSON.stringify({ op: 'set', key: 'k', value: 42, expectedVersion: null }),
      }));
      const body = await resp.json() as { version: string };
      expect(body.version).toBeTruthy();
    });

    it('rejects write on version conflict', async () => {
      const { do: doInst, storage } = createDO();
      await storage.put('k', { v: 'original', _ver: 'v1' });

      const resp = await doInst.fetch(new Request('https://do/op', {
        method: 'POST',
        body: JSON.stringify({ op: 'set', key: 'k', value: 'stale', expectedVersion: 'wrong' }),
      }));
      const body = await resp.json() as { version: null; conflict: boolean };
      expect(body.version).toBeNull();
      expect(body.conflict).toBe(true);

      // White-box: storage unchanged
      const entry = await storage.get<{ v: string; _ver: string }>('k');
      expect(entry!.v).toBe('original');
    });
  });

  describe('op: transact', () => {
    it('executes multiple operations atomically', async () => {
      const { do: doInst } = createDO();
      const resp = await doInst.fetch(new Request('https://do/op', {
        method: 'POST',
        body: JSON.stringify({
          op: 'transact',
          txnOps: [
            { op: 'set', key: 'a', value: 1 },
            { op: 'set', key: 'b', value: 2 },
          ],
        }),
      }));
      const body = await resp.json() as { results: unknown[] };
      expect(body.results).toHaveLength(2);
    });

    it('returns stored values for get operations', async () => {
      const { do: doInst, storage } = createDO();
      await storage.put('x', { v: 'stored', _ver: 'v1' });

      const resp = await doInst.fetch(new Request('https://do/op', {
        method: 'POST',
        body: JSON.stringify({
          op: 'transact',
          txnOps: [
            { op: 'get', key: 'x' },
          ],
        }),
      }));
      const body = await resp.json() as { results: unknown[] };
      expect(body.results[0]).toBe('stored');
    });

    it('returns 400 for missing txnOps', async () => {
      const { do: doInst } = createDO();
      const resp = await doInst.fetch(new Request('https://do/op', {
        method: 'POST',
        body: JSON.stringify({ op: 'transact' }),
      }));
      expect(resp.status).toBe(400);
    });
  });

  describe('op: unknown', () => {
    it('returns 400 for unrecognised operation', async () => {
      const { do: doInst } = createDO();
      const resp = await doInst.fetch(new Request('https://do/op', {
        method: 'POST',
        body: JSON.stringify({ op: 'delete' }),
      }));
      expect(resp.status).toBe(400);
      const body = await resp.json() as { error: string };
      expect(body.error).toContain('Unknown op');
    });
  });
});
