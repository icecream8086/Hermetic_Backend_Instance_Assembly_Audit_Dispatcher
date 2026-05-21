/// <reference types="@cloudflare/workers-types" />

import { describe, it, expect } from 'vitest';
import {
  DurableObjectAtomicStore,
  AtomicStoreDO,
} from '../../../../src/core/store/adapters/durable-object.ts';
import { TransactConflictError } from '../../../../src/core/store/interfaces.ts';

// ─── Mock helpers ───

/** In-memory "DO storage" that mimics DurableObjectStorage. */
function createMockStorage(): DurableObjectStorage {
  const data = new Map<string, unknown>();
  return {
    get: async <T>(key: string | string[]) => {
      if (Array.isArray(key)) {
        const result = new Map<string, T>();
        for (const k of key) {
          if (data.has(k)) result.set(k, data.get(k) as T);
        }
        return result as Map<string, T>;
      }
      return data.get(key) as T | undefined;
    },
    put: async (key: string | Record<string, unknown>, value?: unknown) => {
      if (typeof key === 'object') {
        for (const [k, v] of Object.entries(key)) data.set(k, v);
      } else {
        data.set(key, value);
      }
    },
    delete: async (key: string | string[]) => {
      const keys = Array.isArray(key) ? key : [key];
      for (const k of keys) data.delete(k);
    },
    list: async <T>(options?: DurableObjectListOptions) => {
      let entries = [...data.entries()];
      if (options?.prefix) {
        entries = entries.filter(([k]) => k.startsWith(options.prefix!));
      }
      // Lexicographic sort (DO storage contract)
      entries.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
      if (options?.start) {
        const idx = entries.findIndex(([k]) => k >= options.start!);
        entries = idx === -1 ? [] : entries.slice(idx);
      }
      if (options?.limit && options.limit < entries.length) {
        entries = entries.slice(0, options.limit);
      }
      return new Map(entries) as Map<string, T>;
    },
    transaction: async <T>(fn: () => T) => fn(),
    getAlarm: async () => undefined,
    setAlarm: async () => {},
    deleteAlarm: async () => {},
    sync: async () => {},
    sql: undefined,
  } as unknown as DurableObjectStorage;
}

interface MockStubOptions {
  /** When set, these operations return HTTP 500 with an error message. */
  failOps?: Set<'get' | 'set' | 'transact'>;
  /** When true, transact set on a key that already exists returns 409 conflict. */
  txnConflictOnExisting?: boolean;
}

/** Create a mock DurableObjectStub backed by an in-memory store.
 *  `dataRef` lets white-box tests inspect the internal Map after operations.
 *  `options` controls error-simulation behavior for the adapter error-handling tests. */
function createMockStub(
  dataRef?: { current: Map<string, { v: unknown; _ver: string }> },
  options?: MockStubOptions,
): DurableObjectStub {
  const data = new Map<string, { v: unknown; _ver: string }>();
  if (dataRef) dataRef.current = data;

  const handler = async (req: Request): Promise<Response> => {
    const { op, key, value, expectedVersion, txnOps } = await req.json() as {
      op: string;
      key?: string;
      value?: unknown;
      expectedVersion?: string | null;
      txnOps?: Array<{ op: string; key: string; value?: unknown; expectedVersion?: string | null }>;
    };

    // Simulate DO returning a server error for specific operations
    if (options?.failOps?.has(op as 'get' | 'set' | 'transact')) {
      return Response.json({ error: `Internal error processing ${op}` }, { status: 500 });
    }

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
          } else if (txnOp.op === 'check') {
            const entry = data.get(txnOp.key);
            const curVer = (entry as { _ver?: string } | undefined)?._ver ?? null;
            if (curVer !== txnOp.expectedVersion) {
              return Response.json(
                { error: `Version conflict on key "${txnOp.key}" during transact`, conflict: true },
                { status: 409 },
              );
            }
            results.push(null);
          } else {
            if (options?.txnConflictOnExisting) {
              const current = data.get(txnOp.key);
              if (current) {
                return Response.json(
                  { error: `Version conflict on key: ${txnOp.key}`, conflict: true },
                  { status: 409 },
                );
              }
            }
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

/** Create a mock stub whose fetch() always throws (simulates network error / stub unavailable). */
function createNetworkErrorStub(): DurableObjectStub {
  return {
    fetch: async () => { throw new Error('Network error: stub unavailable'); },
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

    it('can read and write within a transaction (read-modify-write)', async () => {
      const dataRef: { current: Map<string, { v: unknown; _ver: string }> } = { current: new Map() };
      const store = new DurableObjectAtomicStore(createMockNs(createMockStub(dataRef)));

      // Seed data via individual set (bypasses transact)
      await store.set('a', 3, null);
      await store.set('b', 7, null);

      // Transact: read a, b → compute sum → write sum
      const result = await store.transact(async (txn) => {
        const va = await txn.get<number>('a');
        const vb = await txn.get<number>('b');
        await txn.set('sum', va! + vb!);
        return 'done';
      });

      expect(result).toBe('done');

      // White-box: sum was written correctly
      const sumEntry = dataRef.current.get('sum');
      expect(sumEntry).toBeDefined();
      expect(sumEntry!.v).toBe(10);
    });

    it('can read own writes within a transaction', async () => {
      const dataRef: { current: Map<string, { v: unknown; _ver: string }> } = { current: new Map() };
      const store = new DurableObjectAtomicStore(createMockNs(createMockStub(dataRef)));

      const result = await store.transact(async (txn) => {
        // Write, then read back in same transaction
        await txn.set('x', 'hello');
        const val = await txn.get<string>('x');
        return val;
      });

      expect(result).toBe('hello');
    });

    it('transaction get returns null for missing key', async () => {
      const store = new DurableObjectAtomicStore(createMockNs(createMockStub()));
      const val = await store.transact(async (txn) => {
        return txn.get<unknown>('nonexistent');
      });
      expect(val).toBeNull();
    });

    it('detects concurrent modification via TransactConflictError', async () => {
      const dataRef: { current: Map<string, { v: unknown; _ver: string }> } = { current: new Map() };
      const store = new DurableObjectAtomicStore(createMockNs(createMockStub(dataRef)));

      await store.set('k', 'original', null);

      await expect(store.transact(async (txn) => {
        // Read key — records version in readSet
        const val = await txn.get<string>('k');
        expect(val).toBe('original');

        // Simulate concurrent modification by an external request while
        // this transaction is in-flight.
        dataRef.current.set('k', { v: 'concurrent', _ver: 'other-version' });

        // Try to write — the deferred batch-write will send a check op
        // and detect that the read-set version no longer matches.
        await txn.set('k', 'overwrite');
        return 'done';
      })).rejects.toThrow(TransactConflictError);
    });

    it('two concurrent transactions on same key — one wins, one conflicts', async () => {
      const dataRef: { current: Map<string, { v: unknown; _ver: string }> } = { current: new Map() };
      const store = new DurableObjectAtomicStore(createMockNs(createMockStub(dataRef)));

      await store.set('counter', 0, null);

      // Launch two overlapping transactions that both read counter and increment
      const t1 = store.transact(async (txn) => {
        const val = await txn.get<number>('counter');
        await txn.set('counter', val! + 1);
        return 't1';
      });

      const t2 = store.transact(async (txn) => {
        const val = await txn.get<number>('counter');
        await txn.set('counter', val! + 1);
        return 't2';
      });

      const results = await Promise.allSettled([t1, t2]);

      const succeeded = results.filter(r => r.status === 'fulfilled');
      const failed = results.filter(r => r.status === 'rejected');

      expect(succeeded.length).toBe(1);
      expect(failed.length).toBe(1);
      // The one that failed should be a TransactConflictError
      expect(failed[0]).toHaveProperty('reason');
      expect((failed[0] as PromiseRejectedResult).reason).toBeInstanceOf(TransactConflictError);

      // Counter should have been incremented exactly once
      const final = await store.get<number>('counter');
      expect(final!.value).toBe(1);
    });
  });

  describe('error handling', () => {
    it('get returns null when DO returns non-200', async () => {
      const store = new DurableObjectAtomicStore(
        createMockNs(createMockStub(undefined, { failOps: new Set(['get']) })),
      );
      const result = await store.get('k');
      expect(result).toBeNull();
    });

    it('set returns undefined when DO returns non-200', async () => {
      const store = new DurableObjectAtomicStore(
        createMockNs(createMockStub(undefined, { failOps: new Set(['set']) })),
      );
      const version = await store.set('k', 'value', null);
      // Adapter returns body.version directly (undefined from the error JSON)
      expect(version).toBeUndefined();
    });

    it('transact throws when DO returns non-200', async () => {
      const store = new DurableObjectAtomicStore(
        createMockNs(createMockStub(undefined, { failOps: new Set(['transact']) })),
      );
      await expect(store.transact(async (txn) => {
        await txn.set('k', 'v');
        return 'ok';
      })).rejects.toThrow('Internal error processing transact');
    });

    it('transact detects phantom read via null dependency tracking', async () => {
      const dataRef: { current: Map<string, { v: unknown; _ver: string }> } = { current: new Map() };
      const store = new DurableObjectAtomicStore(createMockNs(createMockStub(dataRef)));

      await expect(store.transact(async (txn) => {
        // Read non-existent key — records null dependency in readSet
        const val = await txn.get<string>('x');
        expect(val).toBeNull();

        // Simulate another transaction creating key 'x' while this one is running
        dataRef.current.set('x', { v: 'created-by-B', _ver: 'v1' });

        // Write a different key — the batch will include a check op for 'x'
        // with expectedVersion=null. The DO finds 'x' now has 'v1' → conflict.
        await txn.set('y', 'based_on_x_absent');
        return 'done';
      })).rejects.toThrow(TransactConflictError);

      // The concurrent write survived
      const entry = dataRef.current.get('x') as { v: string; _ver: string };
      expect(entry.v).toBe('created-by-B');
    });

    it('get propagates fetch network error', async () => {
      const store = new DurableObjectAtomicStore(createMockNs(createNetworkErrorStub()));
      await expect(store.get('k')).rejects.toThrow('Network error');
    });

    it('set propagates fetch network error', async () => {
      const store = new DurableObjectAtomicStore(createMockNs(createNetworkErrorStub()));
      await expect(store.set('k', 'v', null)).rejects.toThrow('Network error');
    });

    it('transact propagates fetch network error', async () => {
      const store = new DurableObjectAtomicStore(createMockNs(createNetworkErrorStub()));
      await expect(store.transact(async (txn) => {
        await txn.set('k', 'v');
        return 'ok';
      })).rejects.toThrow('Network error');
    });
  });

  describe('boundary values', () => {
    it('set and get with empty string key', async () => {
      const store = new DurableObjectAtomicStore(createMockNs(createMockStub()));
      const version = await store.set('', 'empty-val', null);
      expect(version).toBeTruthy();

      const result = await store.get<string>('');
      expect(result).not.toBeNull();
      expect(result!.value).toBe('empty-val');
      expect(result!.version).toBe(version);
    });

    it('set with null value — get conflates stored null with not-found', async () => {
      const store = new DurableObjectAtomicStore(createMockNs(createMockStub()));
      const version = await store.set('k', null, null);
      expect(version).toBeTruthy();

      // NOTE: adapter's get() returns null when body.value is null,
      // so stored null is indistinguishable from a missing key.
      const result = await store.get('k');
      expect(result).toBeNull();
    });

    it('set and get with special characters in key', async () => {
      const store = new DurableObjectAtomicStore(createMockNs(createMockStub()));
      const specialKey = 'key:with/special#chars?and=query&params';
      const version = await store.set(specialKey, 'special', null);
      expect(version).toBeTruthy();

      const result = await store.get<string>(specialKey);
      expect(result!.value).toBe('special');
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

  /** Helper: create a DO with a storage that tracks setAlarm calls. */
  function createDOWithAlarmTracking(): {
    do: AtomicStoreDO;
    storage: DurableObjectStorage;
    alarmTimes: number[];
  } {
    const alarmTimes: number[] = [];
    const storage = createMockStorage();
    storage.setAlarm = async (t: number) => { alarmTimes.push(t); };
    const doInstance = new AtomicStoreDO();
    (doInstance as any).ctx = { storage } as DurableObjectState;
    return { do: doInstance, storage, alarmTimes };
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

    it('returns 400 when key is missing', async () => {
      const { do: doInst } = createDO();
      const resp = await doInst.fetch(new Request('https://do/op', {
        method: 'POST',
        body: JSON.stringify({ op: 'get' }),
      }));
      expect(resp.status).toBe(400);
      const body = await resp.json() as { error: string };
      expect(body.error).toContain('Missing key');
    });

    it('get with empty string key returns stored value and version', async () => {
      const { do: doInst, storage } = createDO();
      await storage.put('', { v: 'empty-key', _ver: 'v1' });

      const resp = await doInst.fetch(new Request('https://do/op', {
        method: 'POST',
        body: JSON.stringify({ op: 'get', key: '' }),
      }));
      const body = await resp.json() as { value: string; version: string };
      expect(body.value).toBe('empty-key');
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

    it('returns 400 when key is missing for set', async () => {
      const { do: doInst } = createDO();
      const resp = await doInst.fetch(new Request('https://do/op', {
        method: 'POST',
        body: JSON.stringify({ op: 'set', value: 42, expectedVersion: null }),
      }));
      expect(resp.status).toBe(400);
      const body = await resp.json() as { error: string };
      expect(body.error).toContain('Missing key');
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

    it('set with matching expectedVersion succeeds (update)', async () => {
      const { do: doInst, storage } = createDO();
      await storage.put('k', { v: 'original', _ver: 'v1' });

      const resp = await doInst.fetch(new Request('https://do/op', {
        method: 'POST',
        body: JSON.stringify({ op: 'set', key: 'k', value: 'updated', expectedVersion: 'v1' }),
      }));
      const body = await resp.json() as { version: string };
      expect(body.version).toBeTruthy();
      expect(typeof body.version).toBe('string');
      expect(body.version).not.toBe('v1');

      // White-box: storage updated with new value and version
      const entry = await storage.get<{ v: string; _ver: string }>('k');
      expect(entry!.v).toBe('updated');
      expect(entry!._ver).toBe(body.version);
    });

    it('set stores { v, _ver } structure in storage', async () => {
      const { do: doInst, storage } = createDO();

      await doInst.fetch(new Request('https://do/op', {
        method: 'POST',
        body: JSON.stringify({ op: 'set', key: 'k', value: { hello: 'world' }, expectedVersion: null }),
      }));

      const entry = await storage.get<{ v: unknown; _ver: string }>('k');
      expect(entry).toBeDefined();
      expect(entry!.v).toEqual({ hello: 'world' });
      expect(typeof entry!._ver).toBe('string');
    });

    it('set with empty string key stores successfully', async () => {
      const { do: doInst, storage } = createDO();

      await doInst.fetch(new Request('https://do/op', {
        method: 'POST',
        body: JSON.stringify({ op: 'set', key: '', value: 'empty-key', expectedVersion: null }),
      }));

      const entry = await storage.get<{ v: string; _ver: string }>('');
      expect(entry!.v).toBe('empty-key');
    });

    it('set with null value stores entry with null v', async () => {
      const { do: doInst, storage } = createDO();

      await doInst.fetch(new Request('https://do/op', {
        method: 'POST',
        body: JSON.stringify({ op: 'set', key: 'k', value: null, expectedVersion: null }),
      }));

      const entry = await storage.get<{ v: null; _ver: string }>('k');
      expect(entry).toBeDefined();
      expect(entry!.v).toBeNull();
      expect(typeof entry!._ver).toBe('string');
    });

    it('set with large value stores successfully', async () => {
      const { do: doInst, storage } = createDO();
      const largeValue = 'x'.repeat(100_000);

      const resp = await doInst.fetch(new Request('https://do/op', {
        method: 'POST',
        body: JSON.stringify({ op: 'set', key: 'large', value: largeValue, expectedVersion: null }),
      }));
      const body = await resp.json() as { version: string };
      expect(body.version).toBeTruthy();

      const entry = await storage.get<{ v: string; _ver: string }>('large');
      expect(entry!.v).toBe(largeValue);
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

    it('writes are persisted in storage after transact', async () => {
      const { do: doInst, storage } = createDO();

      await doInst.fetch(new Request('https://do/op', {
        method: 'POST',
        body: JSON.stringify({
          op: 'transact',
          txnOps: [
            { op: 'set', key: 'a', value: 1 },
            { op: 'set', key: 'b', value: 2 },
          ],
        }),
      }));

      const entryA = await storage.get<{ v: number; _ver: string }>('a');
      expect(entryA).toBeDefined();
      expect(entryA!.v).toBe(1);
      expect(typeof entryA!._ver).toBe('string');

      const entryB = await storage.get<{ v: number; _ver: string }>('b');
      expect(entryB).toBeDefined();
      expect(entryB!.v).toBe(2);
    });

    it('get returns null for non-existent key in transact', async () => {
      const { do: doInst } = createDO();

      const resp = await doInst.fetch(new Request('https://do/op', {
        method: 'POST',
        body: JSON.stringify({
          op: 'transact',
          txnOps: [
            { op: 'get', key: 'nonexistent' },
          ],
        }),
      }));
      const body = await resp.json() as { results: unknown[] };
      expect(body.results[0]).toBeNull();
    });

    it('read-modify-write within transact works', async () => {
      const { do: doInst, storage } = createDO();
      await storage.put('counter', { v: 1, _ver: 'v1' });

      // Read old value, then write new value in one batch
      const resp = await doInst.fetch(new Request('https://do/op', {
        method: 'POST',
        body: JSON.stringify({
          op: 'transact',
          txnOps: [
            { op: 'get', key: 'counter' },
            { op: 'set', key: 'counter', value: 2 },
          ],
        }),
      }));
      const body = await resp.json() as { results: unknown[] };
      // get returns old value
      expect(body.results[0]).toBe(1);
      // set returns null
      expect(body.results[1]).toBeNull();

      // Storage reflects the write
      const entry = await storage.get<{ v: number; _ver: string }>('counter');
      expect(entry!.v).toBe(2);
      expect(entry!._ver).not.toBe('v1');
    });

    it('transact set overwrites regardless of version (no OCC in transact)', async () => {
      const { do: doInst, storage } = createDO();
      await storage.put('k', { v: 'original', _ver: 'v1' });

      // transact protocol does not carry expectedVersion; it always writes
      await doInst.fetch(new Request('https://do/op', {
        method: 'POST',
        body: JSON.stringify({
          op: 'transact',
          txnOps: [
            { op: 'set', key: 'k', value: 'overwritten' },
          ],
        }),
      }));

      const entry = await storage.get<{ v: string; _ver: string }>('k');
      expect(entry!.v).toBe('overwritten');
      expect(entry!._ver).not.toBe('v1');
    });

    it('transact with empty string key works', async () => {
      const { do: doInst, storage } = createDO();

      const resp = await doInst.fetch(new Request('https://do/op', {
        method: 'POST',
        body: JSON.stringify({
          op: 'transact',
          txnOps: [
            { op: 'set', key: '', value: 'empty' },
            { op: 'get', key: '' },
          ],
        }),
      }));
      const body = await resp.json() as { results: unknown[] };
      expect(body.results[0]).toBeNull();
      expect(body.results[1]).toBe('empty');

      const entry = await storage.get<{ v: string; _ver: string }>('');
      expect(entry!.v).toBe('empty');
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

  describe('alarm', () => {
    it('bootstraps alarm on first fetch', async () => {
      const { do: doInst, alarmTimes } = createDOWithAlarmTracking();

      // Before any fetch, no alarm should have been set
      expect(alarmTimes).toHaveLength(0);

      // First fetch triggers alarm bootstrap
      await doInst.fetch(new Request('https://do/op', {
        method: 'POST',
        body: JSON.stringify({ op: 'get', key: 'k' }),
      }));

      expect(alarmTimes).toHaveLength(1);
      expect(alarmTimes[0]).toBeGreaterThan(Date.now());
    });

    it('only bootstraps alarm once across multiple fetches', async () => {
      const { do: doInst, alarmTimes } = createDOWithAlarmTracking();

      await doInst.fetch(new Request('https://do/op', {
        method: 'POST',
        body: JSON.stringify({ op: 'get', key: 'k' }),
      }));
      await doInst.fetch(new Request('https://do/op', {
        method: 'POST',
        body: JSON.stringify({ op: 'get', key: 'k' }),
      }));

      // Alarm should have been set exactly once
      expect(alarmTimes).toHaveLength(1);
    });

    it('removes entries past their TTL via alarm', async () => {
      const { do: doInst, storage } = createDO();

      const now = Date.now();

      // Entry with TTL that has expired (past its _expiresAt)
      await storage.put('session:old', {
        v: { data: 'stale' },
        _ver: 'v1',
        _expiresAt: now - 100_000_000,
      });
      await storage.put('__ttl:' + String(now - 100_000_000).padStart(20, '0') + ':session:old', {
        expiresAt: now - 100_000_000,
      });

      // Entry with TTL still in the future
      await storage.put('session:new', {
        v: { data: 'fresh' },
        _ver: 'v2',
        _expiresAt: now + 100_000_000,
      });
      await storage.put('__ttl:' + String(now + 100_000_000).padStart(20, '0') + ':session:new', {
        expiresAt: now + 100_000_000,
      });

      // Entry without TTL (permanent)
      await storage.put('config:foo', {
        v: { setting: 'bar' },
        _ver: 'v3',
        _expiresAt: null,
      });

      await doInst.alarm();

      const staleEntry = await storage.get('session:old');
      expect(staleEntry).toBeUndefined();

      const freshEntry = await storage.get('session:new');
      expect(freshEntry).toBeDefined();

      const configEntry = await storage.get('config:foo');
      expect(configEntry).toBeDefined();

      // TTL marker for expired entry should also be gone
      const staleMarker = await storage.get('__ttl:' + String(now - 100_000_000).padStart(20, '0') + ':session:old');
      expect(staleMarker).toBeUndefined();
    });

    it('does not delete entries without TTL markers', async () => {
      const { do: doInst, storage } = createDO();

      // Entry without _expiresAt field (pre-migration format) — treated as permanent
      await storage.put('session:legacy', {
        v: { someData: true },
        _ver: 'v1',
      });

      await doInst.alarm();

      const entry = await storage.get('session:legacy');
      expect(entry).toBeDefined();
    });

    it('reschedules alarm based on next expiry', async () => {
      const { do: doInst, alarmTimes } = createDOWithAlarmTracking();

      // No TTL markers — alarm should set idle poll (1h)
      await doInst.alarm();

      expect(alarmTimes).toHaveLength(1);
      expect(alarmTimes[0]).toBeGreaterThan(Date.now() + 3_000_000); // well within 1h
    });
  });
});
