/// <reference types="@cloudflare/workers-types" />

import type { IAtomicStore, IStoreTransaction } from '../interfaces.ts';
import { TransactConflictError } from '../interfaces.ts';
import type { VersionId } from '../../brand.ts';
import { generateVersionId } from '../../brand.ts';

// ══════════════════════════════════════════════════════════════════
// TTL system — every stored entry carries _expiresAt.
//
// Callers MUST pass ttlSeconds to set() for expirable data.
// null _expiresAt = permanent (explicit choice, never auto-expired).
//
// A lightweight TTL marker index (__ttl:{ts}:{key}) avoids full
// storage scans — alarm only reads marker keys in expiry order.
// ══════════════════════════════════════════════════════════════════

const TTL_MARKER_PREFIX = '__ttl:';
const TTL_TS_PAD = 20; // zero-padded timestamp width for lex sort
const IDLE_ALARM_MS = 3_600_000; // 1 h — recheck when nothing pending

interface StoredValue {
  v: unknown;
  _ver: string;
  _expiresAt: number | null; // null = permanent
}

function padTs(ts: number): string {
  return String(ts).padStart(TTL_TS_PAD, '0');
}

function markerKey(expiresAt: number, originalKey: string): string {
  return TTL_MARKER_PREFIX + padTs(expiresAt) + ':' + originalKey;
}

/** Extract the original storage key from a TTL marker key. */
function originalKeyFromMarker(mk: string): string {
  // '__ttl:'.length = 6, TTL_TS_PAD = 20, ':' = 1 → total prefix = 27
  return mk.substring(27);
}

// ═══════════════════════════════════════════════════════════
// DO class — runs inside the Durable Object, uses ctx.storage
// ═══════════════════════════════════════════════════════════

export class AtomicStoreDO implements DurableObject {
  #alarmBootstrapped = false;

  public constructor(readonly ctx: DurableObjectState, _env: unknown) {}

  public async fetch(request: Request): Promise<Response> {
    // Lazy bootstrap alarm on first request
    if (!this.#alarmBootstrapped) {
      this.#alarmBootstrapped = true;
      this.ctx.storage.setAlarm(Date.now() + IDLE_ALARM_MS).catch(() => {});
    }

    const { op, key, keys, value, expectedVersion, ttlSeconds, txnOps } = await request.json();

    try {
      switch (op) {
        case 'get': {
          if (key === undefined) {
            return Response.json({ error: 'Missing key for get operation' }, { status: 400 });
          }
          const entry = await this.ctx.storage.get<StoredValue>(key);
          if (!entry) return Response.json({ value: null, version: null });

          // Passive expiry — clean up expired entries on read
          if (entry._expiresAt !== null && entry._expiresAt <= Date.now()) {
            const mk = markerKey(entry._expiresAt, key);
            await this.ctx.storage.delete([key, mk]);
            return Response.json({ value: null, version: null });
          }

          return Response.json({ value: entry.v, version: entry._ver });
        }

        case 'set': {
          if (key === undefined) {
            return Response.json({ error: 'Missing key for set operation' }, { status: 400 });
          }
          const current = await this.ctx.storage.get<StoredValue>(key);
          const curVer = current?._ver ?? null;
          if (expectedVersion !== curVer) return Response.json({ version: null, conflict: true });

          const newVersion = generateVersionId();
          const now = Date.now();
          const newExpiresAt = ttlSeconds !== undefined ? now + ttlSeconds * 1000 : null;

          // Clean up old TTL marker if the entry had one
          if (current?._expiresAt !== null && current?._expiresAt !== undefined) {
            await this.ctx.storage.delete(markerKey(current._expiresAt, key));
          }

          // Store value with explicit expiry metadata
          await this.ctx.storage.put(key, { v: value, _ver: newVersion, _expiresAt: newExpiresAt } satisfies StoredValue);

          // Create TTL marker for non-permanent entries
          if (newExpiresAt !== null) {
            const mk = markerKey(newExpiresAt, key);
            await this.ctx.storage.put(mk, { expiresAt: newExpiresAt });

            // Advance alarm if this entry expires sooner than current schedule
            const currentAlarm = await this.ctx.storage.getAlarm().catch(() => null);
            if (currentAlarm === null || newExpiresAt < currentAlarm) {
              await this.ctx.storage.setAlarm(newExpiresAt);
            }
          }

          return Response.json({ version: newVersion });
        }

        case 'batchGet': {
          if (!keys || keys.length === 0) {
            return Response.json({ error: 'Missing keys for batchGet operation' }, { status: 400 });
          }
          const stored = await this.ctx.storage.get<StoredValue>(keys);
          const now = Date.now();
          const expiredKeys: string[] = [];
          const results: { key: string; value: unknown; version: string | null }[] = [];

          for (const k of keys) {
            const entry = stored.get(k);
            if (!entry) {
              results.push({ key: k, value: null, version: null });
              continue;
            }
            if (entry._expiresAt !== null && entry._expiresAt <= now) {
              expiredKeys.push(k, markerKey(entry._expiresAt, k));
              results.push({ key: k, value: null, version: null });
              continue;
            }
            results.push({ key: k, value: entry.v, version: entry._ver });
          }

          if (expiredKeys.length > 0) {
            await this.ctx.storage.delete(expiredKeys);
          }

          return Response.json({ results });
        }

        case 'transact': {
          if (!txnOps) return Response.json({ error: 'Missing txnOps' }, { status: 400 });

          // Phase 1: collect all keys to read (get / check ops)
          const readKeys = new Set<string>();
          for (const op of txnOps) {
            if (op.op === 'get' || op.op === 'check') readKeys.add(op.key);
          }

          // Phase 2: single batch read — 1 I/O instead of N
          const stored = readKeys.size > 0
            ? await this.ctx.storage.get<StoredValue>([...readKeys])
            : new Map<string, StoredValue>();

          // Phase 3: process ops in memory; collect writes.
          // Reads check in-memory writes first so a set → get to the same
          // key within one transaction sees the just-written value.
          const results: unknown[] = [];
          const writes = new Map<string, StoredValue>();

          for (const txnOp of txnOps) {
            if (txnOp.op === 'get') {
              const pending = writes.get(txnOp.key);
              results.push(pending ? pending.v : (stored.get(txnOp.key)?.v ?? null));
            } else if (txnOp.op === 'check') {
              // Pending writes within the same txn always pass the check.
              if (writes.has(txnOp.key)) {
                results.push(null);
              } else {
                const curVer = stored.get(txnOp.key)?._ver ?? null;
                if (curVer !== txnOp.expectedVersion) {
                  return Response.json(
                    { error: `Version conflict on key "${txnOp.key}"` },
                    { status: 409 },
                  );
                }
                results.push(null);
              }
            } else {
              const newVersion = generateVersionId();
              writes.set(txnOp.key, { v: txnOp.value, _ver: newVersion, _expiresAt: null } satisfies StoredValue);
              results.push(null);
            }
          }

          // Phase 4: single batch write — 1 I/O instead of N
          if (writes.size > 0) await this.ctx.storage.put(Object.fromEntries(writes));

          return Response.json({ results });
        }

        default:
          return Response.json({ error: `Unknown op: ${op}` }, { status: 400 });
      }
    } catch (err) {
      return Response.json(
        { error: `Storage error: ${err instanceof Error ? err.message : err}` },
        { status: 503 },
      );
    }
  }

  public async alarm(): Promise<void> {
    try {
      const now = Date.now();
      let start: string | undefined;
      let nextExpiry = Infinity;

      // Scan TTL markers in expiry order — never touches non-expirable keys.
      // Uses a while loop so ALL expired keys are cleaned up in one alarm
      // cycle regardless of volume (no artificial 2000-key cap).
      while (true) {
        const listOpts: DurableObjectListOptions = { prefix: TTL_MARKER_PREFIX, limit: 200 };
        if (start !== undefined) listOpts.start = start;
        const result = await this.ctx.storage.list<{ expiresAt: number }>(listOpts);

        if (result.size === 0) break;

        const toDelete: string[] = [];
        let allExpired = true;

        for (const [mk, meta] of result) {
          if (meta.expiresAt <= now) {
            toDelete.push(mk, originalKeyFromMarker(mk));
          } else {
            nextExpiry = Math.min(nextExpiry, meta.expiresAt);
            allExpired = false;
            break; // rest are sorted later — not due yet
          }
        }

        if (toDelete.length > 0) {
          await this.ctx.storage.delete(toDelete);
        }

        if (!allExpired) break;

        // Advance cursor past this batch
        const lastKey = [...result.keys()].pop()!;
        start = lastKey.slice(0, -1) + String.fromCharCode(lastKey.charCodeAt(lastKey.length - 1) + 1);
      }

      // Dynamic reschedule: next expiry, or long idle poll
      const delay = nextExpiry < Infinity
        ? Math.max(nextExpiry - Date.now(), 1_000)
        : IDLE_ALARM_MS;
      await this.ctx.storage.setAlarm(Date.now() + delay);
    } catch (err) {
      console.error('AtomicStoreDO alarm error:', err);
      // Reschedule anyway to avoid silent stall
      await this.ctx.storage.setAlarm(Date.now() + IDLE_ALARM_MS).catch(() => {});
    }
  }
}

// ═══════════════════════════════════════════════════════════
// Adapter — the Worker calls this, it forwards to the DO
// ═══════════════════════════════════════════════════════════

export class DurableObjectAtomicStore implements IAtomicStore {
  readonly #ns: DurableObjectNamespace;
  /** Cache idFromName() results per prefix — called on every get/set/transact */
  readonly #idCache = new Map<string, DurableObjectId>();

  public constructor(ns: DurableObjectNamespace) {
    this.#ns = ns;
  }

  /** Derive DO stub from key prefix — different prefixes hit different DOs. */
  #stubForKey(key: string): DurableObjectStub {
    const colonIdx = key.indexOf(':');
    const prefix = colonIdx === -1 ? '_global' : key.substring(0, colonIdx);
    const name = 'tx_' + prefix;
    let id = this.#idCache.get(name);
    if (!id) {
      id = this.#ns.idFromName(name);
      this.#idCache.set(name, id);
    }
    return this.#ns.get(id);
  }

  public async get<T>(key: string): Promise<{ value: T; version: VersionId } | null> {
    const resp = await this.#stubForKey(key).fetch('https://do/op', {
      method: 'POST',
      body: JSON.stringify({ op: 'get', key }),
    });
    const body = await resp.json();
    if (body.value === null || body.value === undefined) return null;
    if (body.version === null || body.version === undefined) return null;
    return { value: body.value, version: body.version as VersionId };
  }

  public async set<T>(key: string, value: T, expectedVersion: VersionId | null, ttlSeconds?: number): Promise<VersionId | null> {
    const resp = await this.#stubForKey(key).fetch('https://do/op', {
      method: 'POST',
      body: JSON.stringify({ op: 'set', key, value, expectedVersion, ttlSeconds }),
    });
    const body = await resp.json();
    return body.version as VersionId | null;
  }

  public async transact<T>(action: (txn: IStoreTransaction) => Promise<T>): Promise<T> {
    const readSet = new Map<string, string | null>();
    const deferredWrites: { key: string; value: unknown }[] = [];

    // ── 生产者-消费者：延迟批量读 ──
    interface ReadRequest {
      key: string;
      resolve: (v: unknown) => void;
    }
    let pendingReads: ReadRequest[] = [];
    let flushScheduled = false;

    const flushPendingReads = async (): Promise<void> => {
      if (pendingReads.length === 0) return;
      const batch = pendingReads;
      pendingReads = [];
      flushScheduled = false;

      const keys = [...new Set(batch.map(r => r.key))];
      const firstKey = keys[0]!;
      const resp = await this.#stubForKey(firstKey).fetch('https://do/op', {
        method: 'POST',
        body: JSON.stringify({ op: 'batchGet', keys }),
      });
      const body = await resp.json();

      // Build lookup and record versions for OCC (null = phantom read tracking)
      const lookup = new Map<string, unknown>();
      for (const r of body.results) {
        lookup.set(r.key, r.value);
        readSet.set(r.key, r.version);
      }

      // Resolve all pending promises
      for (const req of batch) {
        req.resolve(lookup.get(req.key) ?? null);
      }
    };

    const txn: IStoreTransaction = {
      get: async <V>(key: string) => {
        // 1) Read-your-writes: check locally deferred writes first
        const local = deferredWrites.find(w => w.key === key);
        if (local !== undefined) return local.value as V;

        // 2) Register deferred read, schedule batch flush.
        //    Duplicate keys are fine: the flush dedupes the DO fetch
        //    but resolves each pending entry individually.
        return new Promise<V>(resolve => {
          pendingReads.push({ key, resolve: resolve as (v: unknown) => void });

          if (!flushScheduled) {
            flushScheduled = true;
            queueMicrotask(() => { void flushPendingReads(); });
          }
        });
      },
      getMany: async <V>(keys: string[]) => {
        // Check local writes first
        const localResults: (V | null)[] = [];
        const remoteKeys: string[] = [];
        for (const key of keys) {
          const local = deferredWrites.find(w => w.key === key);
          if (local !== undefined) {
            localResults.push(local.value as V);
          } else {
            localResults.push(null as V | null);
            remoteKeys.push(key);
          }
        }
        if (remoteKeys.length === 0) return localResults;

        const resp = await this.#stubForKey(remoteKeys[0]!).fetch('https://do/op', {
          method: 'POST',
          body: JSON.stringify({ op: 'batchGet', keys: remoteKeys }),
        });
        const body = await resp.json();
        for (const r of body.results) {
          readSet.set(r.key, r.version);
          const idx = keys.indexOf(r.key);
          if (idx !== -1) localResults[idx] = (r.value ?? null) as V | null;
        }
        return localResults;
      },
      set: async <V>(key: string, value: V, _ttlSeconds?: number) => {
        deferredWrites.push({ key, value });
      },
    };

    const userResult = await action(txn);

    // Flush any reads that never got flushed (e.g. action didn't await the last get)
    if (pendingReads.length > 0) {
      await flushPendingReads();
    }

    if (deferredWrites.length > 0) {
      const txnOps: {
        op: 'get' | 'set' | 'check';
        key: string;
        value?: unknown;
        expectedVersion?: string | null;
      }[] = [];

      for (const [key, version] of readSet) {
        txnOps.push({ op: 'check', key, expectedVersion: version });
      }
      for (const w of deferredWrites) {
        txnOps.push({ op: 'set', key: w.key, value: w.value });
      }

      // Validate all keys share the same shard prefix.
      // Keys without ':' are treated as global (_global prefix).
      const allKeys = [...readSet.keys(), ...deferredWrites.map(w => w.key)];
      const prefixes = new Set(allKeys.map(k => { const i = k.indexOf(':'); return i === -1 ? '_global' : k.slice(0, i); }));
      if (prefixes.size > 1) {
        throw new Error(
          `Cross-shard transaction: keys span multiple prefixes ${[...prefixes].join(', ')}. ` +
          'All keys in a transaction must share the same key prefix (e.g. all "user:*" or all "sandbox:*").',
        );
      }

      const firstKey = readSet.keys().next().value ?? deferredWrites[0]!.key;
      const resp = await this.#stubForKey(firstKey).fetch('https://do/op', {
        method: 'POST',
        body: JSON.stringify({ op: 'transact', txnOps }),
      });

      if (!resp.ok) {
        const body = await resp.json();
        if (resp.status === 409) {
          throw new TransactConflictError(body.error ?? 'Transaction conflict in DO transact');
        }
        throw new Error(body.error ?? 'DO transact error');
      }
    }

    return userResult;
  }
}
