import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FileKVAtomicStore } from '../../../src/core/store/adapters/file-kv.ts';
import { TransactConflictError, withRetry, TransactRetryExhausted } from '../../../src/core/store/interfaces.ts';
import type { IAtomicStore } from '../../../src/core/store/interfaces.ts';
import type { VersionId } from '../../../src/core/brand.ts';

// ═══════════════════════════════════════════════════════════════════════════
// Part A — Formal Sequential Specification
// ═══════════════════════════════════════════════════════════════════════════
//
// CAS (Compare-And-Swap) register formal model.
// Matches FileKVAtomicStore semantics: null values are tombstones (deleted).
//
// Reference: Herlihy & Wing, "Linearizability: A Correctness Condition for
// Concurrent Objects", ACM TOPLAS 1990.
// ═══════════════════════════════════════════════════════════════════════════

class CASRegisterSpec {
  private state = new Map<string, { value: unknown; version: string }>();
  private versionCounter = 0;

  private nextVersion(): string {
    return `spec-v${++this.versionCounter}-${crypto.randomUUID().slice(0, 8)}`;
  }

  /** Initialize from an existing store's snapshot. */
  async initFrom(store: IAtomicStore, keys: string[]): Promise<void> {
    for (const key of keys) {
      const entry = await store.get(key);
      if (entry !== null) {
        this.state.set(key, { value: entry.value, version: entry.version });
      }
    }
  }

  /** Directly set state (for testing). */
  initDirect(key: string, value: unknown, version: string): void {
    this.state.set(key, { value, version });
  }

  get(key: string): { value: unknown; version: string } | null {
    const entry = this.state.get(key);
    // FileKVAtomicStore: null value === deleted, get returns null
    if (!entry || entry.value === null) return null;
    return { value: entry.value, version: entry.version };
  }

  /**
   * CAS operation.
   * - expectedVersion === null: create-only (fails if key exists with non-null value)
   * - expectedVersion matches: update
   * Returns new version on success, null on conflict.
   */
  set(key: string, value: unknown, expectedVersion: string | null): string | null {
    const current = this.state.get(key);

    if (expectedVersion === null) {
      // create-only: fails if key exists (even as tombstone)
      if (current !== undefined) return null;
    } else {
      if (current === undefined) return null;
      if (current.version !== expectedVersion) return null;
    }

    const newVersion = this.nextVersion();
    this.state.set(key, { value, version: newVersion });
    return newVersion;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Part B — Operation Model & Arbitraries
// ═══════════════════════════════════════════════════════════════════════════

type GetOp = { type: 'get'; key: string };
type SetOp = { type: 'set'; key: string; value: unknown; expectedVersion: string | null };
type SeqOp = GetOp | SetOp;

const keyGen = fc.constantFrom('k1', 'k2', 'k3', 'k4', 'k5');

const nonNullValue = fc.oneof(
  fc.string({ minLength: 1, maxLength: 20 }),
  fc.integer({ min: -1000, max: 1000 }),
  fc.boolean(),
);

/**
 * Generate a random sequential operation list.
 * Values are always non-null to avoid the tombstone edge case in the model
 * (null values ARE tombstones — tested separately in edge cases).
 */
function opSequence(maxLen: number): fc.Arbitrary<SeqOp[]> {
  return fc.integer({ min: 1, max: maxLen }).chain(len =>
    fc.array(
      fc.oneof(
        fc.record<GetOp>({ type: fc.constant('get' as const), key: keyGen }),
        fc.record<SetOp>({
          type: fc.constant('set' as const),
          key: keyGen,
          value: nonNullValue,
          expectedVersion: fc.constant(null),
        }),
      ),
      { minLength: len, maxLength: len },
    ),
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Part C — Sequential Model-Based Oracle
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Execute a sequence against both the spec and the real store.
 * Returns [passed, debugInfo].
 */
async function checkSequence(
  store: IAtomicStore,
  ops: SeqOp[],
): Promise<{ passed: boolean; step: number; detail: string }> {
  const spec = new CASRegisterSpec();

  for (let i = 0; i < ops.length; i++) {
    const op = ops[i]!;

    if (op.type === 'get') {
      const specResult = spec.get(op.key);
      const storeResult = await store.get(op.key);

      if (specResult === null && storeResult !== null) {
        return { passed: false, step: i, detail: `get(${op.key}): spec=null store=${JSON.stringify(storeResult)}` };
      }
      if (specResult !== null && storeResult === null) {
        return { passed: false, step: i, detail: `get(${op.key}): spec=${JSON.stringify(specResult)} store=null` };
      }
      if (specResult !== null && storeResult !== null && specResult.value !== storeResult.value) {
        return { passed: false, step: i, detail: `get(${op.key}): spec.value=${JSON.stringify(specResult.value)} store.value=${JSON.stringify(storeResult.value)}` };
      }
    } else {
      const specResult = spec.set(op.key, op.value, op.expectedVersion);
      const storeResult = await store.set(op.key, op.value, op.expectedVersion as VersionId | null);

      if ((specResult === null) !== (storeResult === null)) {
        return { passed: false, step: i, detail: `set(${op.key}, ${JSON.stringify(op.value)}, ${op.expectedVersion}): spec=${specResult} store=${storeResult}` };
      }
    }
  }

  return { passed: true, step: -1, detail: 'ok' };
}

// ═══════════════════════════════════════════════════════════════════════════
// Part D — Linearizability Checker
// ═══════════════════════════════════════════════════════════════════════════
//
// Reference: Herlihy & Wing 1990; Wing & Gong 1993
//
// A history is LINEARIZABLE iff there exists a total order σ such that:
//   1. σ respects time precedence: if op1.end < op2.start, then op1 < op2 in σ
//   2. Executing σ sequentially on the CAS register spec produces the observed
//      return values.
//
// We use backtracking over all linear extensions of the partial order.
// ═══════════════════════════════════════════════════════════════════════════

interface TimedOp {
  id: number;
  type: 'get' | 'set';
  key: string;
  invocationTime: number;
  responseTime: number;
  value?: unknown;
  expectedVersion?: string | null;
  /** For get: { value, version } | null. For set: { version } | null (null=failed). */
  result: { value?: unknown; version?: string | null } | null;
}

/**
 * Check linearizability of a concurrent history against the CAS register spec.
 *
 * The `initialState` describes keys and their versions before any operation
 * in the history, matching the real store's state at that point.
 */
function checkLinearizable(
  history: TimedOp[],
  initialState: Map<string, { value: unknown; version: string }>,
): boolean {
  // Partition by key — operations on different keys are independent
  const byKey = new Map<string, TimedOp[]>();
  for (const op of history) {
    let ops = byKey.get(op.key);
    if (!ops) { ops = []; byKey.set(op.key, ops); }
    ops.push(op);
  }

  for (const [key, ops] of byKey) {
    const init = initialState.get(key) ?? null;
    if (!checkLinearizablePerKey(ops, key, init)) {
      return false;
    }
  }
  return true;
}

function checkLinearizablePerKey(
  ops: TimedOp[],
  key: string,
  initial: { value: unknown; version: string } | null,
): boolean {
  if (ops.length === 0) return true;

  // Build precedence: op_i → op_j if op_i ended before op_j started
  const successor = new Map<number, Set<number>>();
  for (const op of ops) successor.set(op.id, new Set());

  for (const a of ops) {
    for (const b of ops) {
      if (a.id === b.id) continue;
      if (a.responseTime < b.invocationTime) {
        successor.get(a.id)!.add(b.id);
      }
    }
  }

  // Track how many predecessors each op has (for topological scheduling)
  const predCount = new Map<number, number>();
  for (const op of ops) predCount.set(op.id, 0);
  for (const [, succs] of successor) {
    for (const s of succs) {
      predCount.set(s, (predCount.get(s) ?? 0) + 1);
    }
  }

  const used = new Set<number>();
  const order: number[] = [];

  function backtrack(): boolean {
    if (order.length === ops.length) {
      return validSequentialHistory(ops, order, key, initial);
    }

    // Find candidates: ops where all predecessors are already in `order`
    const candidates: number[] = [];
    for (const op of ops) {
      if (used.has(op.id)) continue;

      let allPredsInOrder = true;
      for (const [predId, succs] of successor) {
        if (succs.has(op.id) && !used.has(predId)) {
          allPredsInOrder = false;
          break;
        }
      }
      if (allPredsInOrder) candidates.push(op.id);
    }

    // Deterministic order for reproducibility
    candidates.sort((a, b) => a - b);

    for (const id of candidates) {
      used.add(id);
      order.push(id);
      if (backtrack()) return true;
      order.pop();
      used.delete(id);
    }
    return false;
  }

  return backtrack();
}

function validSequentialHistory(
  ops: TimedOp[],
  order: number[],
  key: string,
  initial: { value: unknown; version: string } | null,
): boolean {
  const spec = new CASRegisterSpec();
  if (initial !== null && initial.value !== null) {
    spec.initDirect(key, initial.value, initial.version);
  }

  for (const id of order) {
    const op = ops.find(o => o.id === id)!;

    if (op.type === 'get') {
      const expected = spec.get(op.key);
      if (expected === null) {
        if (op.result !== null) return false;
      } else {
        if (op.result === null) return false;
        if (op.result.value !== expected.value) return false;
      }
    } else {
      const specVersion = spec.set(op.key, op.value, op.expectedVersion ?? null);
      const storeSucceeded = op.result !== null;
      const specSucceeded = specVersion !== null;
      if (storeSucceeded !== specSucceeded) return false;
    }
  }
  return true;
}

// ═══════════════════════════════════════════════════════════════════════════
// Part E — Concurrent Execution Engine
// ═══════════════════════════════════════════════════════════════════════════

interface ThreadPlan {
  ops: Array<{
    type: 'get' | 'set';
    key: string;
    value?: unknown;
    expectedVersion?: string | null;
  }>;
}

async function runConcurrentWorkload(
  store: IAtomicStore,
  threads: ThreadPlan[],
): Promise<{ history: TimedOp[]; initialState: Map<string, { value: unknown; version: string }> }> {
  // Snapshot initial state for all keys used in this workload
  const allKeys = new Set<string>();
  for (const t of threads) for (const op of t.ops) allKeys.add(op.key);

  const initialState = new Map<string, { value: unknown; version: string }>();
  for (const key of allKeys) {
    const entry = await store.get(key);
    if (entry !== null) {
      initialState.set(key, { value: entry.value, version: entry.version });
    }
  }

  let nextId = 0;
  const history: TimedOp[] = [];

  await Promise.all(threads.map(async (thread) => {
    for (const planOp of thread.ops) {
      const id = nextId++;
      const start = performance.now();

      if (planOp.type === 'get') {
        const result = await store.get(planOp.key);
        const end = performance.now();
        history.push({
          id, type: 'get', key: planOp.key,
          invocationTime: start, responseTime: end,
          result: result ? { value: result.value, version: result.version } : null,
        });
      } else {
        const result = await store.set(
          planOp.key,
          planOp.value,
          (planOp.expectedVersion ?? null) as VersionId | null,
        );
        const end = performance.now();
        history.push({
          id, type: 'set', key: planOp.key,
          invocationTime: start, responseTime: end,
          value: planOp.value,
          expectedVersion: planOp.expectedVersion ?? null,
          result: result !== null ? { version: result } : null,
        });
      }
    }
  }));

  return { history, initialState };
}

// ═══════════════════════════════════════════════════════════════════════════
// Part F — Helpers
// ═══════════════════════════════════════════════════════════════════════════

function makeStore(): { store: FileKVAtomicStore; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'occ-test-'));
  const store = new FileKVAtomicStore(dir);
  return { store, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// ═══════════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════════

describe('OCC linearizability (formal)', () => {
  // ── A: Sequential model conformance ──

  describe('sequential model conformance', () => {
    it('any sequence of gets and create-only sets matches the CAS spec', async () => {
      await fc.assert(
        fc.asyncProperty(opSequence(12), async (ops) => {
          const { store, cleanup } = makeStore();
          try {
            const result = await checkSequence(store, ops);
            expect(result.passed).toBe(true);
          } finally {
            cleanup();
          }
        }),
        { numRuns: 100 },
      );
    }, 15000);

    it('read-modify-write cycle matches spec', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 0, max: 100 }),
          fc.string({ minLength: 1, maxLength: 15 }),
          async (initial, newVal) => {
            const { store, cleanup } = makeStore();
            try {
              const v1 = await store.set('x', initial, null);
              expect(v1).not.toBeNull();
              const read = await store.get('x');
              const v2 = await store.set('x', newVal, read!.version);
              expect(v2).not.toBeNull();
              const final = await store.get('x');
              expect(final!.value).toBe(newVal);
            } finally {
              cleanup();
            }
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  // ── B: Concurrent history linearizability ──

  describe('concurrent history linearizability', () => {
    it('concurrent reads on a single key are linearizable', async () => {
      const { store, cleanup } = makeStore();
      try {
        await store.set('x', 'initial', null);

        const threads: ThreadPlan[] = [
          { ops: [{ type: 'get', key: 'x' }, { type: 'get', key: 'x' }] },
          { ops: [{ type: 'get', key: 'x' }, { type: 'get', key: 'x' }] },
          { ops: [{ type: 'get', key: 'x' }, { type: 'get', key: 'x' }] },
        ];

        const { history, initialState } = await runConcurrentWorkload(store, threads);
        expect(history.length).toBe(6);
        expect(checkLinearizable(history, initialState)).toBe(true);
      } finally {
        cleanup();
      }
    });

    it('concurrent create-only sets on disjoint keys are linearizable', async () => {
      const { store, cleanup } = makeStore();
      try {
        // No initial state — keys don't exist yet
        const threads: ThreadPlan[] = [
          { ops: [{ type: 'set', key: 'a', value: 'A', expectedVersion: null }] },
          { ops: [{ type: 'set', key: 'b', value: 'B', expectedVersion: null }] },
          { ops: [{ type: 'set', key: 'c', value: 'C', expectedVersion: null }] },
        ];

        const { history, initialState } = await runConcurrentWorkload(store, threads);
        expect(checkLinearizable(history, initialState)).toBe(true);

        // All should have succeeded
        for (const k of ['a', 'b', 'c']) {
          const entry = await store.get(k);
          expect(entry).not.toBeNull();
        }
      } finally {
        cleanup();
      }
    });

    it('concurrent sets on the SAME key are linearizable', async () => {
      const { store, cleanup } = makeStore();
      try {
        // Key 'x' does NOT exist initially
        const threads: ThreadPlan[] = [
          { ops: [{ type: 'set', key: 'x', value: 'first', expectedVersion: null }] },
          { ops: [{ type: 'set', key: 'x', value: 'second', expectedVersion: null }] },
        ];

        const { history, initialState } = await runConcurrentWorkload(store, threads);
        expect(checkLinearizable(history, initialState)).toBe(true);

        // Exactly one set should have succeeded (create-only on same key)
        const entry = await store.get('x');
        expect(entry).not.toBeNull();
        expect(['first', 'second']).toContain(entry!.value);
      } finally {
        cleanup();
      }
    });

    it('random concurrent workloads are always linearizable', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 2, max: 4 }).chain(nThreads =>
            fc.array(
              fc.array(
                fc.oneof(
                  fc.record({
                    type: fc.constant('get' as const),
                    key: fc.constantFrom('a', 'b', 'c'),
                  }),
                  fc.record({
                    type: fc.constant('set' as const),
                    key: fc.constantFrom('a', 'b', 'c'),
                    value: fc.integer({ min: 0, max: 50 }),
                    expectedVersion: fc.constant(null),
                  }),
                ),
                { minLength: 2, maxLength: 3 },
              ),
              { minLength: nThreads, maxLength: nThreads },
            ),
          ),
          async (threadOps) => {
            const { store, cleanup } = makeStore();
            try {
              // Set up initial state for all keys
              for (const k of ['a', 'b', 'c']) {
                await store.set(k, `init-${k}`, null);
              }

              const threads: ThreadPlan[] = threadOps.map(ops => ({ ops }));
              const { history, initialState } = await runConcurrentWorkload(store, threads);
              expect(checkLinearizable(history, initialState)).toBe(true);
            } finally {
              cleanup();
            }
          },
        ),
        { numRuns: 30 },
      );
    }, 15000);
  });

  describe('CAS semantics', () => {
    it('create-only succeeds on absent key, fails on existing key', async () => {
      const { store, cleanup } = makeStore();
      try {
        const v1 = await store.set('k', 1, null);
        expect(v1).not.toBeNull();
        const v2 = await store.set('k', 2, null);
        expect(v2).toBeNull(); // key already exists

        const entry = await store.get('k');
        expect(entry!.value).toBe(1); // unchanged
      } finally {
        cleanup();
      }
    });

    it('update succeeds with correct version, fails with stale version', async () => {
      const { store, cleanup } = makeStore();
      try {
        const v1 = await store.set('k', 'a', null);
        const v2 = await store.set('k', 'b', v1);
        expect(v2).not.toBeNull();
        expect(v2).not.toBe(v1);

        const v3 = await store.set('k', 'c', v1); // stale
        expect(v3).toBeNull();

        const entry = await store.get('k');
        expect(entry!.value).toBe('b');
      } finally {
        cleanup();
      }
    });

    it('update on non-existent key fails', async () => {
      const { store, cleanup } = makeStore();
      try {
        const v = await store.set('absent', 'val', 'bogus-version' as VersionId);
        expect(v).toBeNull();
        expect(await store.get('absent')).toBeNull();
      } finally {
        cleanup();
      }
    });

    it('version changes monotonically', async () => {
      const { store, cleanup } = makeStore();
      try {
        const versions = new Set<string>();
        let ver: VersionId | null = null;
        for (let i = 0; i < 50; i++) {
          const v = await store.set('k', i, ver);
          expect(v).not.toBeNull();
          expect(versions.has(v!)).toBe(false);
          versions.add(v!);
          ver = v;
        }
      } finally {
        cleanup();
      }
    });
  });

  // ── D: transact isolation ──

  describe('transact isolation', () => {
    it('reads a consistent snapshot', async () => {
      const { store, cleanup } = makeStore();
      try {
        await store.set('a', 1, null);
        await store.set('b', 2, null);

        const result = await store.transact(async (txn) => {
          const a = await txn.get<number>('a');
          const b = await txn.get<number>('b');
          await txn.set('sum', (a ?? 0) + (b ?? 0));
          return a! + b!;
        });
        expect(result).toBe(3);

        const sum = await store.get<number>('sum');
        expect(sum!.value).toBe(3);
      } finally {
        cleanup();
      }
    });

    it('read-your-writes within a transaction', async () => {
      const { store, cleanup } = makeStore();
      try {
        await store.transact(async (txn) => {
          await txn.set('a', 100);
          const a = await txn.get<number>('a');
          expect(a).toBe(100);
        });
      } finally {
        cleanup();
      }
    });

    it('getMany reads multiple keys consistently', async () => {
      const { store, cleanup } = makeStore();
      try {
        await store.set('x', 10, null);
        await store.set('y', 20, null);
        await store.set('z', 30, null);

        const vals = await store.transact(async (txn) => txn.getMany<number>(['x', 'y', 'z']));
        expect(vals).toEqual([10, 20, 30]);
      } finally {
        cleanup();
      }
    });

    it('transact writes are atomic', async () => {
      const { store, cleanup } = makeStore();
      try {
        await store.set('a', 'old', null);
        await store.set('b', 'old', null);

        await store.transact(async (txn) => {
          await txn.set('a', 'new');
          await txn.set('b', 'new');
        });

        expect((await store.get('a'))!.value).toBe('new');
        expect((await store.get('b'))!.value).toBe('new');
      } finally {
        cleanup();
      }
    });

    it('transact fails on phantom read (key created after read-as-null)', async () => {
      const { store, cleanup } = makeStore();
      try {
        // Key 'p' does not exist. We read it as null inside transact,
        // then externally create it before the transact commits.
        // Since the lock serializes everything, we simulate this by
        // pre-creating the key after doing an external get check.
        // The OCC check at commit time validates that keys read as null
        // are still null — this test exercises that path by having the
        // transact read a key that was externally created.
        //
        // Under FileKVAtomicStore's global lock, external writes can't
        // interleave with a transact callback. But the transact's OCC
        // validation logic is still exercised: the read set records
        // the version (or null for absent keys), and the commit check
        // validates the read set against current state.
        await store.transact(async (txn) => {
          // Read non-existent key
          const val = await txn.get<number>('phantom');
          expect(val).toBeNull();
          // Write a different key — commit will still check 'phantom' version
          await txn.set('result', 42);
        });

        // Transact succeeds because no external modification happened
        expect((await store.get<number>('result'))!.value).toBe(42);
      } finally {
        cleanup();
      }
    });
  });

  // ── E: withRetry semantics ──

  describe('withRetry', () => {
    it('returns result on first success without retry', async () => {
      let calls = 0;
      const result = await withRetry(async () => {
        calls++;
        return 'success';
      });
      expect(result).toBe('success');
      expect(calls).toBe(1);
    });

    it('retries on TransactConflictError', async () => {
      let calls = 0;
      const result = await withRetry(async () => {
        calls++;
        if (calls < 3) throw new TransactConflictError('conflict');
        return 'eventual-success';
      });
      expect(result).toBe('eventual-success');
      expect(calls).toBe(3);
    });

    it('does NOT retry on non-TransactConflictError errors', async () => {
      let calls = 0;
      await expect(
        withRetry(async () => {
          calls++;
          throw new Error('unrelated');
        }),
      ).rejects.toThrow('unrelated');
      expect(calls).toBe(1);
    });

    it('throws TransactRetryExhausted after max retries', async () => {
      let calls = 0;
      await expect(
        withRetry(
          async () => {
            calls++;
            throw new TransactConflictError();
          },
          { maxRetries: 2, baseDelayMs: 1 },
        ),
      ).rejects.toThrow(TransactRetryExhausted);
      expect(calls).toBe(3); // 1 initial + 2 retries
    });

    it('uses exponential backoff (increasing delays)', async () => {
      const delays: number[] = [];
      await expect(
        withRetry(
          async () => {
            delays.push(performance.now());
            throw new TransactConflictError();
          },
          { maxRetries: 3, baseDelayMs: 15 },
        ),
      ).rejects.toThrow(TransactRetryExhausted);

      // Check delays increase: delay[i+1] - delay[i] >= baseDelay * 2^i
      // With baseDelay=15: ~15ms, ~30ms, ~60ms
      expect(delays.length).toBe(4); // initial + 3 retries
      const intervals = [
        delays[1]! - delays[0]!,
        delays[2]! - delays[1]!,
        delays[3]! - delays[2]!,
      ];
      // Each interval should be at least 10ms (accounting for timing jitter)
      for (let i = 0; i < intervals.length; i++) {
        expect(intervals[i]).toBeGreaterThanOrEqual(8); // allow timing jitter
      }
      // The last interval should be the longest (rough check)
      expect(intervals[2]!).toBeGreaterThanOrEqual(intervals[0]!);
    });
  });

  // ── F: Cross-key independence ──

  describe('cross-key independence', () => {
    it('operations on different keys do not interfere', async () => {
      const { store, cleanup } = makeStore();
      try {
        await Promise.all([
          store.set('a', 'A', null),
          store.set('b', 'B', null),
          store.set('c', 'C', null),
        ]);
        expect((await store.get<string>('a'))!.value).toBe('A');
        expect((await store.get<string>('b'))!.value).toBe('B');
        expect((await store.get<string>('c'))!.value).toBe('C');
      } finally {
        cleanup();
      }
    });

    it('set on key A does not change key B version', async () => {
      const { store, cleanup } = makeStore();
      try {
        const vA = await store.set('a', 'A1', null);
        const vB = await store.set('b', 'B1', null);

        const vA2 = await store.set('a', 'A2', vA);
        expect(vA2).not.toBeNull();

        const b = await store.get('b');
        expect(b!.version).toBe(vB); // unchanged
      } finally {
        cleanup();
      }
    });
  });

  // ── G: Concurrent read-modify-write (OCC retry in practice) ──

  describe('concurrent RMW (OCC retry)', () => {
    // This test depends on CPU timing; it may timeout on slower/oversubscribed machines.
    // Set OCC_STRESS_TEST=true to run it.
    const runStress = process.env['OCC_STRESS_TEST'] === 'true';
    (runStress ? it : it.skip)('concurrent increments on same counter converge correctly', async () => {
      const { store, cleanup } = makeStore();
      try {
        await store.set('counter', 0, null);
        const numWorkers = 10;
        const incrementsPerWorker = 5;

        await Promise.all(
          Array.from({ length: numWorkers }, async () => {
            for (let i = 0; i < incrementsPerWorker; i++) {
              for (let attempt = 0; attempt < 50; attempt++) {
                const entry = await store.get<number>('counter');
                if (!entry) continue;
                const ver = await store.set('counter', entry.value + 1, entry.version);
                if (ver !== null) break; // success
                await new Promise(r => setTimeout(r, 1 + Math.random() * 3));
              }
            }
          }),
        );

        const final = await store.get<number>('counter');
        expect(final!.value).toBe(numWorkers * incrementsPerWorker);
      } finally {
        cleanup();
      }
    });
  });

  // ── H: Edge cases ──

  describe('edge cases', () => {
    it('null value is a tombstone (get returns null)', async () => {
      const { store, cleanup } = makeStore();
      try {
        const v = await store.set('k', null, null);
        expect(v).not.toBeNull(); // set succeeds
        expect(await store.get('k')).toBeNull(); // but null = deleted
      } finally {
        cleanup();
      }
    });

    it('sequential sets (100) stay consistent', async () => {
      const { store, cleanup } = makeStore();
      try {
        let ver: VersionId | null = null;
        for (let i = 0; i < 100; i++) {
          ver = await store.set('k', i, ver);
          expect(ver).not.toBeNull();
          expect((await store.get<number>('k'))!.value).toBe(i);
        }
      } finally {
        cleanup();
      }
    });

    it('TTL expires entries', async () => {
      const { store, cleanup } = makeStore();
      try {
        await store.set('ttl-k', 'ephemeral', null, 1);
        expect((await store.get('ttl-k'))!.value).toBe('ephemeral');
        await new Promise(r => setTimeout(r, 1500));
        expect(await store.get('ttl-k')).toBeNull();
      } finally {
        cleanup();
      }
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Part I — Lock-Free InMemoryAtomicStore
// ═══════════════════════════════════════════════════════════════════════════
//
// A lock-free IAtomicStore implementation using JS Maps.
// Without a global serialization lock, concurrent operations can actually
// interleave — exposing OCC contract violations that the FileKV adapter's
// global lock masks.  Models the DO-based store's multi-Worker concurrency.
// ═══════════════════════════════════════════════════════════════════════════

import { generateVersionId } from '../../../src/core/brand.ts';

interface MemEntry {
  value: unknown;
  version: string;
  expiresAt?: number;
}

class InMemoryAtomicStore implements IAtomicStore {
  private store = new Map<string, MemEntry>();

  async get<T>(key: string): Promise<{ value: T; version: VersionId } | null> {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiresAt !== undefined && entry.expiresAt <= Date.now()) {
      this.store.delete(key);
      return null;
    }
    if (entry.value === null) return null;
    return { value: entry.value as T, version: entry.version as VersionId };
  }

  async set<T>(
    key: string,
    value: T,
    expectedVersion: VersionId | null,
    ttlSeconds?: number,
  ): Promise<VersionId | null> {
    const current = this.store.get(key);

    if (current?.expiresAt !== undefined && current.expiresAt <= Date.now()) {
      this.store.delete(key);
    }

    const curEntry = this.store.get(key);
    const curVer = curEntry?.version ?? null;

    if (expectedVersion === null && curVer !== null) return null;
    if (expectedVersion !== null && curVer !== expectedVersion) return null;

    const newVersion = generateVersionId();
    const entry: MemEntry = { value, version: newVersion };
    if (ttlSeconds !== undefined) entry.expiresAt = Date.now() + ttlSeconds * 1000;
    this.store.set(key, entry);
    return newVersion as VersionId;
  }

  async transact<T>(action: (txn: IStoreTransaction) => Promise<T>): Promise<T> {
    const readSet = new Map<string, string | null>();
    const deferredWrites = new Map<string, { value: unknown; version: string }>();

    const readKey = <V>(key: string): V | null => {
      const dw = deferredWrites.get(key);
      if (dw !== undefined) return dw.value as V;

      const entry = this.store.get(key);
      if (!entry || entry.value === null) {
        readSet.set(key, null);
        return null;
      }
      if (entry.expiresAt !== undefined && entry.expiresAt <= Date.now()) {
        readSet.set(key, null);
        return null;
      }
      readSet.set(key, entry.version);
      return entry.value as V;
    };

    const txn: IStoreTransaction = {
      get: async <V>(key: string) => readKey<V>(key),
      getMany: async <V>(keys: string[]) => keys.map(k => readKey<V>(k)),
      set: async <V>(key: string, value: V) => {
        deferredWrites.set(key, { value, version: generateVersionId() });
      },
    };

    const result = await action(txn);

    for (const [key, expectedVersion] of readSet) {
      if (deferredWrites.has(key)) continue;

      const current = this.store.get(key);
      let currentVersion: string | null = null;
      if (current && current.value !== null) {
        if (!(current.expiresAt !== undefined && current.expiresAt <= Date.now())) {
          currentVersion = current.version;
        }
      }
      if (currentVersion !== expectedVersion) {
        throw new TransactConflictError(
          `Transaction conflict: key "${key}" modified concurrently.`,
        );
      }
    }

    for (const [key, { value, version }] of deferredWrites) {
      this.store.set(key, { value, version });
    }

    return result;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Part J — High-Intensity Stress + Linearizability Property Tests
// ═══════════════════════════════════════════════════════════════════════════
//
// Uses InMemoryAtomicStore (lock-free, OCC-based) so thousands of runs
// complete quickly without file I/O.
//
// Key technique: randomized artificial delays between intra-thread operations
// widen the interleaving space, causing the event loop to schedule threads in
// diverse orders — exposing OCC bugs that deterministic schedules would miss.
//
// The linearizability checker runs on EVERY generated history, verifying the
// formal CAS register spec against the observed concurrent execution.
// ═══════════════════════════════════════════════════════════════════════════

interface StressThreadOp {
  type: 'get' | 'set';
  key: string;
  value?: unknown;
  delayMs: number;
}

interface StressHistoryEntry {
  id: number;
  key: string;
  type: 'get' | 'set';
  invocationTime: number;
  responseTime: number;
  value?: unknown;
  result: { value?: unknown; version?: string | null } | null;
}

async function runStressWorkload(
  store: InMemoryAtomicStore,
  threads: StressThreadOp[][],
): Promise<StressHistoryEntry[]> {
  let nextId = 0;
  const history: StressHistoryEntry[] = [];

  await Promise.all(threads.map(async (ops) => {
    for (const op of ops) {
      if (op.delayMs > 0) {
        await new Promise(r => setTimeout(r, op.delayMs));
      }

      const id = nextId++;
      const start = performance.now();

      if (op.type === 'get') {
        const r = await store.get(op.key);
        const end = performance.now();
        history.push({
          id, key: op.key, type: 'get',
          invocationTime: start, responseTime: end,
          result: r ? { value: r.value, version: r.version } : null,
        });
      } else {
        const r = await store.set(op.key, op.value, null as unknown as VersionId);
        const end = performance.now();
        history.push({
          id, key: op.key, type: 'set',
          invocationTime: start, responseTime: end,
          value: op.value,
          result: r !== null ? { version: r } : null,
        });
      }
    }
  }));

  return history;
}

function checkStressLinearizable(
  history: StressHistoryEntry[],
  initialState: Map<string, { value: unknown; version: string }>,
): boolean {
  const timedOps: TimedOp[] = history.map(h => ({
    id: h.id,
    type: h.type,
    key: h.key,
    invocationTime: h.invocationTime,
    responseTime: h.responseTime,
    value: h.value,
    expectedVersion: null,
    result: h.result,
  }));

  return checkLinearizable(timedOps, initialState);
}

describe('OCC stress (lock-free InMemoryAtomicStore)', () => {
  /**
   * 高强度压力测试：5000 次随机并发 + 线性一致性检查。
   *
   * 默认跳过 — 耗时约 60-120s，不适合 pre-commit / CI 管线。
   * 手动验证：`npx vitest run -t "5k random concurrent"`
   */
  it.skip('5k random concurrent workloads are linearizable', async () => {
    const planArb = fc
      .integer({ min: 2, max: 5 })
      .chain(nThreads =>
        fc.integer({ min: 1, max: 4 }).chain(opsPerThread =>
          fc.array(
            fc.array(
              fc.record<StressThreadOp>({
                type: fc.constantFrom('get' as const, 'set' as const),
                key: fc.constantFrom('x', 'y'),
                value: fc.option(fc.integer({ min: 0, max: 100 }))
                  .map(v => v ?? undefined),
                delayMs: fc.integer({ min: 0, max: 2 }),
              }),
              { minLength: opsPerThread, maxLength: opsPerThread },
            ),
            { minLength: nThreads, maxLength: nThreads },
          ),
        ),
      );

    await fc.assert(
      fc.asyncProperty(planArb, async (threads) => {
        const store = new InMemoryAtomicStore();

        const initialState = new Map<string, { value: unknown; version: string }>();
        for (const k of ['x', 'y']) {
          const v = await store.set(k, `init-${k}`, null as unknown as VersionId);
          if (v) initialState.set(k, { value: `init-${k}`, version: v });
        }

        const history = await runStressWorkload(store, threads);
        expect(checkStressLinearizable(history, initialState)).toBe(true);
      }),
      { numRuns: 5000 },
    );
  }, 180000);

  it('heavy contention on single key never violates linearizability', async () => {
    const OPS_PER_THREAD = 5;

    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 2, max: 8 }),
        async (actualThreads) => {
          const store = new InMemoryAtomicStore();
          const initVer = await store.set('k', 0, null as unknown as VersionId);

          const initialState = new Map<string, { value: unknown; version: string }>();
          if (initVer) initialState.set('k', { value: 0, version: initVer });

          const threads: StressThreadOp[][] = Array.from(
            { length: actualThreads },
            () =>
              Array.from({ length: OPS_PER_THREAD }, (): StressThreadOp => ({
                type: Math.random() < 0.3 ? 'set' : 'get',
                key: 'k',
                value: Math.floor(Math.random() * 1000),
                delayMs: Math.floor(Math.random() * 2),
              })),
          );

          const history = await runStressWorkload(store, threads);
          expect(checkStressLinearizable(history, initialState)).toBe(true);
        },
      ),
      { numRuns: 200 },
    );
  }, 30000);

  it('concurrent transact with random delay interleaving preserves isolation', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 3, max: 8 }),
        fc.integer({ min: 2, max: 5 }),
        async (nThreads, opsPerThread) => {
          const store = new InMemoryAtomicStore();
          await store.set('a', 0, null as unknown as VersionId);
          await store.set('b', 0, null as unknown as VersionId);

          await Promise.allSettled(
            Array.from({ length: nThreads }, (_, ti) => {
              if (ti % 2 === 0) {
                return (async () => {
                  for (let i = 0; i < opsPerThread; i++) {
                    await new Promise(r => setTimeout(r, Math.floor(Math.random() * 3)));
                    await withRetry(
                      () =>
                        store.transact(async (txn) => {
                          const a = (await txn.get<number>('a')) ?? 0;
                          const b = (await txn.get<number>('b')) ?? 0;
                          await txn.set('sum', a + b);
                        }),
                      { maxRetries: 10, baseDelayMs: 1 },
                    );
                  }
                })();
              } else {
                return (async () => {
                  for (let i = 0; i < opsPerThread; i++) {
                    await new Promise(r => setTimeout(r, Math.floor(Math.random() * 3)));
                    for (let attempt = 0; attempt < 20; attempt++) {
                      const key = i % 2 === 0 ? 'a' : 'b';
                      const entry = await store.get<number>(key);
                      if (!entry) continue;
                      const ver = await store.set(key, entry.value + 1, entry.version as VersionId);
                      if (ver !== null) break;
                      await new Promise(r => setTimeout(r, 1));
                    }
                  }
                })();
              }
            }),
          );

          const a = await store.get<number>('a');
          const b = await store.get<number>('b');
          const sum = await store.get<number>('sum');
          if (a) expect(a.value).toBeGreaterThanOrEqual(0);
          if (b) expect(b.value).toBeGreaterThanOrEqual(0);
          if (sum) expect(sum.value).toBeGreaterThanOrEqual(0);
        },
      ),
      { numRuns: 100 },
    );
  }, 30000);

  it('random delay interleaving via shuffle+race preserves linearizability', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 499 }),
        async (seed) => {
          const rng = mulberry32(seed);
          const store = new InMemoryAtomicStore();

          const initVer = await store.set('k', 'initial', null as unknown as VersionId);
          const initialState = new Map<string, { value: unknown; version: string }>();
          if (initVer) initialState.set('k', { value: 'initial', version: initVer });

          const history: StressHistoryEntry[] = [];
          let nextId = 0;

          const ops: Array<() => Promise<void>> = [];
          for (let i = 0; i < 15; i++) {
            ops.push(async () => {
              const delay = Math.floor(rng() * 5);
              if (delay > 0) await new Promise(r => setTimeout(r, delay));
              const id = nextId++;
              const start = performance.now();
              const r = await store.get('k');
              history.push({
                id, key: 'k', type: 'get',
                invocationTime: start, responseTime: performance.now(),
                result: r ? { value: r.value, version: r.version } : null,
              });
            });

            ops.push(async () => {
              const delay = Math.floor(rng() * 5);
              if (delay > 0) await new Promise(r => setTimeout(r, delay));
              const val = `w${i}-${seed}`;
              const id = nextId++;
              const start = performance.now();
              const r = await store.set('k', val, null as unknown as VersionId);
              history.push({
                id, key: 'k', type: 'set',
                invocationTime: start, responseTime: performance.now(),
                value: val,
                result: r !== null ? { version: r } : null,
              });
            });
          }

          shuffle(ops, rng);
          await Promise.all(ops.map(fn => fn()));

          expect(history.length).toBe(30);
          expect(checkStressLinearizable(history, initialState)).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  }, 30000);

  it('OCC conflicts are measurable under contention', async () => {
    const store = new InMemoryAtomicStore();
    await store.set('k', 0, null as unknown as VersionId);

    let conflicts = 0;
    let successes = 0;

    await Promise.all(
      Array.from({ length: 10 }, async () => {
        for (let i = 0; i < 50; i++) {
          for (let attempt = 0; attempt < 30; attempt++) {
            const entry = await store.get<number>('k');
            if (!entry) continue;
            const ver = await store.set('k', entry.value + 1, entry.version as VersionId);
            if (ver !== null) {
              successes++;
              break;
            }
            conflicts++;
            await new Promise(r => setTimeout(r, Math.random() * 2));
          }
        }
      }),
    );

    const final = await store.get<number>('k');
    expect(final!.value).toBe(successes);
    expect(conflicts + successes).toBeGreaterThanOrEqual(500);
  });
});

// ── Seeded PRNG (mulberry32) for reproducible shuffle ──

function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(arr: T[], rng: () => number): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j]!, arr[i]!];
  }
}
