/// <reference types="@cloudflare/workers-types" />

import type { IAtomicStore, IStoreTransaction } from '../interfaces.ts';
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
      txnOps?: Array<{ op: 'get' | 'set'; key: string; value?: unknown }>;
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
    if (!body.value || !body.version) return null;
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
    // Collect operations, send them in one shot to the DO where they execute sequentially
    const txnOps: Array<{ op: 'get' | 'set'; key: string; value?: unknown }> = [];
    let resultIndex = 0;
    const getResults: unknown[] = [];

    const txn: IStoreTransaction = {
      get: async <V>(key: string) => {
        const idx = resultIndex++;
        txnOps.push({ op: 'get', key });
        // Placeholder — actual values come back from the DO response
        return getResults[idx] as V | null;
      },
      set: async <V>(key: string, value: V) => {
        txnOps.push({ op: 'set', key, value });
      },
    };

    // Start the action — it records operations via txn.set()/txn.get()
    const userPromise = action(txn);

    // Wait for the action to finish recording. This is necessary because
    // sequential `await txn.set(...)` calls are chained via microtasks:
    // the first push is synchronous but control returns before subsequent
    // pushes have executed. Awaiting userPromise drains the microtask queue
    // so ALL operations are recorded in txnOps before serialization.
    try { await userPromise; } catch { /* ops already recorded */ }

    // Send the complete batch to the DO
    const resp = await this.#stub.fetch('https://do/op', {
      method: 'POST',
      body: JSON.stringify({ op: 'transact', txnOps }),
    });
    const body = await resp.json() as { results?: unknown[]; error?: string };
    if (body.error) throw new Error(`DO transact error: ${body.error}`);

    // Fill in the get results (for any gets that occurred)
    for (let i = 0; i < (body.results?.length ?? 0); i++) {
      getResults[i] = body.results![i];
    }

    // Return the user action result (may reject if the action threw)
    return userPromise;
  }
}
