/// <reference types="@cloudflare/workers-types" />

import type { IAtomicStore, IStoreTransaction } from '../interfaces.ts';
import { TransactConflictError } from '../interfaces.ts';
import type { VersionId } from '../../brand.ts';
import { generateVersionId } from '../../brand.ts';

// ═══════════════════════════════════════════════════════════
// DO class — runs inside the Durable Object, uses ctx.storage
// ═══════════════════════════════════════════════════════════

/** DO-based IAtomicStore. Provides strong consistency via single-threaded DO execution. */
// DurableObject is an interface in @cloudflare/workers-types.
// The runtime provides ctx and the DO lifecycle — we just implement fetch().
export class AtomicStoreDO implements DurableObject {
  // Injected by the DO runtime
  readonly ctx!: DurableObjectState;

  async fetch(request: Request): Promise<Response> {
    const { op, key, value, expectedVersion, txnOps } = await request.json() as {
      op: 'get' | 'set' | 'transact';
      key?: string;
      value?: unknown;
      expectedVersion?: string | null;
      txnOps?: Array<{ op: 'get' | 'set' | 'check'; key: string; value?: unknown; expectedVersion?: string | null }>;
    };

    switch (op) {
      case 'get': {
        const entry = await this.ctx.storage.get<{ v: unknown; _ver: string }>(key!);
        if (!entry) return Response.json({ value: null, version: null });
        return Response.json({ value: entry.v, version: entry._ver });
      }

      case 'set': {
        const current = await this.ctx.storage.get<{ v: unknown; _ver: string }>(key!);
        const curVer = current?._ver ?? null;
        if (expectedVersion !== curVer) return Response.json({ version: null, conflict: true });

        const newVersion = generateVersionId();
        await this.ctx.storage.put(key!, { v: value, _ver: newVersion });
        return Response.json({ version: newVersion });
      }

      case 'transact': {
        if (!txnOps) return Response.json({ error: 'Missing txnOps' }, { status: 400 });
        const results: unknown[] = [];

        for (const txnOp of txnOps) {
          if (txnOp.op === 'get') {
            const entry = await this.ctx.storage.get<{ v: unknown }>(txnOp.key);
            results.push(entry?.v ?? null);
          } else if (txnOp.op === 'check') {
            // Optimistic lock check: verify key has the expected version
            const entry = await this.ctx.storage.get<{ v: unknown; _ver: string }>(txnOp.key);
            const curVer = entry?._ver ?? null;
            if (curVer !== txnOp.expectedVersion) {
              return Response.json(
                { error: `Version conflict on key "${txnOp.key}" during transact` },
                { status: 409 },
              );
            }
            results.push(null);
          } else {
            const newVersion = generateVersionId();
            await this.ctx.storage.put(txnOp.key, { v: txnOp.value, _ver: newVersion });
            results.push(null);
          }
        }
        return Response.json({ results });
      }

      default:
        return Response.json({ error: `Unknown op: ${op}` }, { status: 400 });
    }
  }
}

// ═══════════════════════════════════════════════════════════
// Adapter — the Worker calls this, it forwards to the DO
// ═══════════════════════════════════════════════════════════

export class DurableObjectAtomicStore implements IAtomicStore {
  #doId: DurableObjectId;
  #stub: DurableObjectStub;

  constructor(ns: DurableObjectNamespace, idName: string = 'global-store') {
    this.#doId = ns.idFromName(idName);
    this.#stub = ns.get(this.#doId);
  }

  async get<T>(key: string): Promise<{ value: T; version: VersionId } | null> {
    const resp = await this.#stub.fetch('https://do/op', {
      method: 'POST',
      body: JSON.stringify({ op: 'get', key }),
    });
    const body = await resp.json() as { value: T | null; version: string | null };
    if (body.value === null || body.value === undefined) return null;
    if (body.version === null || body.version === undefined) return null;
    return { value: body.value, version: body.version as VersionId };
  }

  async set<T>(key: string, value: T, expectedVersion: VersionId | null): Promise<VersionId | null> {
    const resp = await this.#stub.fetch('https://do/op', {
      method: 'POST',
      body: JSON.stringify({ op: 'set', key, value, expectedVersion }),
    });
    const body = await resp.json() as { version: string | null; conflict?: boolean };
    return body.version as VersionId | null;
  }

  async transact<T>(action: (txn: IStoreTransaction) => Promise<T>): Promise<T> {
    const readSet = new Map<string, string | null>();   // key → version (null = key didn't exist)
    const deferredWrites: Array<{ key: string; value: unknown }> = [];

    const txn: IStoreTransaction = {
      get: async <V>(key: string) => {
        // Read-your-own-writes: if this key was written earlier in the
        // same transaction, return the local value without fetching.
        const local = deferredWrites.find(w => w.key === key);
        if (local !== undefined) return local.value as V;

        // Immediate read-through to the DO. The DO is single-threaded
        // so this gives us the latest committed value.
        const resp = await this.#stub.fetch('https://do/op', {
          method: 'POST',
          body: JSON.stringify({ op: 'get', key }),
        });
        const body = await resp.json() as { value: V | null; version: string | null };

        // Track dependency: null version means "key does not exist", which
        // is a legitimate read dependency — a phantom-read where another
        // transaction later creates this key must be detected as a conflict.
        if (body.version === undefined) return null; // error response
        readSet.set(key, body.version);  // null = "key didn't exist"
        return body.value ?? null;
      },
      set: async <V>(key: string, value: V) => {
        deferredWrites.push({ key, value });
      },
    };

    const userResult = await action(txn);

    // Batch-write all deferred writes atomically to the DO. Include
    // optimistic-lock checks for every key that was read (unless it was
    // also written by this transaction, since we only care about
    // concurrent external modifications).
    if (deferredWrites.length > 0) {
      const txnOps: Array<{
        op: 'get' | 'set' | 'check';
        key: string;
        value?: unknown;
        expectedVersion?: string | null;
      }> = [];

      // Checks come before writes in the same batch, so the DO
      // validates every read-key version against the current store
      // before any write takes effect. Since DO processes one fetch
      // at a time, this is truly atomic.
      for (const [key, version] of readSet) {
        txnOps.push({ op: 'check', key, expectedVersion: version });
      }
      for (const w of deferredWrites) {
        txnOps.push({ op: 'set', key: w.key, value: w.value });
      }

      const resp = await this.#stub.fetch('https://do/op', {
        method: 'POST',
        body: JSON.stringify({ op: 'transact', txnOps }),
      });

      if (!resp.ok) {
        const body = await resp.json() as { error?: string };
        if (resp.status === 409) {
          throw new TransactConflictError(body.error ?? 'Transaction conflict in DO transact');
        }
        throw new Error(body.error ?? 'DO transact error');
      }
    }

    return userResult;
  }
}
