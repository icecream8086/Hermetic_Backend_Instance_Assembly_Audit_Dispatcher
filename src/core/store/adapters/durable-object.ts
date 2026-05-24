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

  constructor(readonly ctx: DurableObjectState, _env: unknown) {}

  async fetch(request: Request): Promise<Response> {
    // Lazy bootstrap alarm on first request
    if (!this.#alarmBootstrapped) {
      this.#alarmBootstrapped = true;
      this.ctx.storage.setAlarm(Date.now() + IDLE_ALARM_MS).catch(() => {});
    }

    const { op, key, value, expectedVersion, ttlSeconds, txnOps } = await request.json() as {
      op: 'get' | 'set' | 'transact';
      key?: string;
      value?: unknown;
      expectedVersion?: string | null;
      ttlSeconds?: number;
      txnOps?: Array<{ op: 'get' | 'set' | 'check'; key: string; value?: unknown; expectedVersion?: string | null }>;
    };

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
            await this.ctx.storage.delete(markerKey(current!._expiresAt, key));
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

  async alarm(): Promise<void> {
    try {
      const now = Date.now();
      let start: string | undefined;
      let nextExpiry = Infinity;

      // Scan TTL markers in expiry order — never touches non-expirable keys
      for (let batch = 0; batch < 10; batch++) {
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
  #ns: DurableObjectNamespace;

  constructor(ns: DurableObjectNamespace) {
    this.#ns = ns;
  }

  /** Derive DO stub from key prefix — different prefixes hit different DOs. */
  #stubForKey(key: string): DurableObjectStub {
    const colonIdx = key.indexOf(':');
    const prefix = colonIdx === -1 ? '_global' : key.substring(0, colonIdx);
    return this.#ns.get(this.#ns.idFromName('tx_' + prefix));
  }

  async get<T>(key: string): Promise<{ value: T; version: VersionId } | null> {
    const resp = await this.#stubForKey(key).fetch('https://do/op', {
      method: 'POST',
      body: JSON.stringify({ op: 'get', key }),
    });
    const body = await resp.json() as { value: T | null; version: string | null };
    if (body.value === null || body.value === undefined) return null;
    if (body.version === null || body.version === undefined) return null;
    return { value: body.value, version: body.version as VersionId };
  }

  async set<T>(key: string, value: T, expectedVersion: VersionId | null, ttlSeconds?: number): Promise<VersionId | null> {
    const resp = await this.#stubForKey(key).fetch('https://do/op', {
      method: 'POST',
      body: JSON.stringify({ op: 'set', key, value, expectedVersion, ttlSeconds }),
    });
    const body = await resp.json() as { version: string | null; conflict?: boolean };
    return body.version as VersionId | null;
  }

  async transact<T>(action: (txn: IStoreTransaction) => Promise<T>): Promise<T> {
    const readSet = new Map<string, string | null>();
    const deferredWrites: Array<{ key: string; value: unknown }> = [];

    const txn: IStoreTransaction = {
      get: async <V>(key: string) => {
        const local = deferredWrites.find(w => w.key === key);
        if (local !== undefined) return local.value as V;

        const resp = await this.#stubForKey(key).fetch('https://do/op', {
          method: 'POST',
          body: JSON.stringify({ op: 'get', key }),
        });
        const body = await resp.json() as { value: V | null; version: string | null };
        if (body.version === undefined) return null;
        readSet.set(key, body.version);
        return body.value ?? null;
      },
      set: async <V>(key: string, value: V, _ttlSeconds?: number) => {
        deferredWrites.push({ key, value });
      },
    };

    const userResult = await action(txn);

    if (deferredWrites.length > 0) {
      const txnOps: Array<{
        op: 'get' | 'set' | 'check';
        key: string;
        value?: unknown;
        expectedVersion?: string | null;
      }> = [];

      for (const [key, version] of readSet) {
        txnOps.push({ op: 'check', key, expectedVersion: version });
      }
      for (const w of deferredWrites) {
        txnOps.push({ op: 'set', key: w.key, value: w.value });
      }

      // Route to the correct DO shard: all keys in a transaction share a
      // common prefix (the event bus only transacts on events:pending).
      // Use the first read or write key to determine the shard.
      const firstKey = readSet.keys().next().value ?? deferredWrites[0]!.key;
      const resp = await this.#stubForKey(firstKey).fetch('https://do/op', {
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
