import { join } from 'node:path'; import { tmpdir } from 'node:os';
import { describe, it, expect } from 'vitest';
import { registerHealthCheck, type HealthCheckDeps } from '../../../src/core/events/health-check.ts';
import { EventBus } from '../../../src/core/event-bus/bus.ts';
import { EventLoop } from '../../../src/core/event-bus/loop.ts';
import { FakeTimerBackend } from '../../../src/core/scheduler/fake-timer-backend.ts';
import { FileKVAtomicStore } from '../../../src/core/store/adapters/file-kv.ts';
import { SandboxStatus } from '../../../src/features/sandbox/types.ts';
import { QueueProducer } from '../../../src/queue/producer.ts';

/**
 * Health check decision table — exhaustive path testing.
 *
 * This maps directly to `specs/health-check-truth-table.md` with the
 * addition of Failed/Terminated GC paths that exist in code (lines 69-83)
 * but are documented in the truth table row 10 as "skip".
 *
 * Decision variables:
 *   S = sandbox.status (Deleted / Stopped / Running / Pending / Failed / Terminated)
 *   T = stoppedDuration > 60s (only for Stopped/Failed/Terminated)
 *   M = maxRetries (-1 / >=0)
 *   R = getStatus() returns (null / object with containers)
 *   A = anyRunning (container alive)  — only when R=object
 *   H = allHealthy (all containers alive) — only when R=object
 *   F = fails >= maxRetries — only when H=false
 */

function store() { return new FileKVAtomicStore(join(tmpdir(), 'hbi-dt-' + crypto.randomUUID().slice(0, 8))); }

interface MockProvider {
  getStatusResult: any;
  deleteCalled: boolean;
}

function makeDeps(providerOverride?: MockProvider): HealthCheckDeps {
  const atomic = store();
  const bus = new EventBus();
  const timer = new FakeTimerBackend();
  const loop = new EventLoop(bus, { intervalMs: 60000 }, timer, atomic);
  const mockProvider = providerOverride ?? { getStatusResult: null, deleteCalled: false };

  const containerProvider = {
    getStatus: async () => mockProvider.getStatusResult,
    delete: async () => { mockProvider.deleteCalled = true; },
  } as any;

  return {
    stores: { atomic },
    providers: {
      container: containerProvider,
      resolveContainer: async () => containerProvider,
    },
    eventBus: bus,
    eventLoop: loop,
    audit: { write: async () => {} } as any,
    queueProducer: new QueueProducer(undefined),
  };
}

async function triggerTick(deps: HealthCheckDeps): Promise<void> {
  // The registerHealthCheck handler will fire when EventLoop processes
  // We trigger a tick and re-emit the health:check event
  await deps.eventLoop.triggerTick();
  // Wait for async handler to complete
  await new Promise(r => setTimeout(r, 10));
}

interface DecisionTableRow {
  name: string;
  /** Sandbox status */
  S: SandboxStatus;
  /** Duration since updatedAt (ms). -1 = now (recent). Positive = ms ago. */
  durationMs: number;
  /** healthMaxRetries. -1 = whitelist. undefined = default (3). */
  M: number | undefined;
  /** getStatus return: null or object with container states */
  R: null | { containers: Array<{ alive: boolean }> };
  /** Expected status after tick (null = Deleted, otherwise the expected status) */
  expectedStatus: SandboxStatus | 'deleted';
  /** Expected fail counter value after tick (null = not checked) */
  expectedFailCounter?: number | '>0';
  /** Whether provider.delete should be called */
  expectDeleteCalled: boolean;
}

const NOW = Date.now();

const decisionTable: DecisionTableRow[] = [
  // ── Row 1: Deleted → skip ──
  {
    name: 'Row 1: Deleted → skip',
    S: SandboxStatus.Deleted,
    durationMs: 0,
    M: undefined,
    R: null,
    expectedStatus: SandboxStatus.Deleted,
    expectDeleteCalled: false,
  },

  // ── Row 2: Stopped, duration ≤ 60s → skip ──
  {
    name: 'Row 2: Stopped < 60s → skip',
    S: SandboxStatus.Stopped,
    durationMs: 30_000,
    M: undefined,
    R: null,
    expectedStatus: SandboxStatus.Stopped,
    expectDeleteCalled: false,
  },

  // ── Row 3: Stopped, duration > 60s → GC ──
  {
    name: 'Row 3: Stopped > 60s → stopped-gc',
    S: SandboxStatus.Stopped,
    durationMs: 61_000,
    M: undefined,
    R: null,
    expectedStatus: 'deleted',
    expectDeleteCalled: true,
  },

  // ── Row 4: Running, maxRetries=-1 → whitelist skip ──
  {
    name: 'Row 4: Running, maxRetries=-1 → whitelist skip',
    S: SandboxStatus.Running,
    durationMs: 0,
    M: -1,
    R: { containers: [{ alive: false }] },
    expectedStatus: SandboxStatus.Running,
    expectDeleteCalled: false,
  },

  // ── Row 5: Running, maxRetries≥0, getStatus=null → provider-gone GC ──
  {
    name: 'Row 5: Running, getStatus=null → provider-gone',
    S: SandboxStatus.Running,
    durationMs: 0,
    M: 3,
    R: null,
    expectedStatus: 'deleted',
    expectDeleteCalled: true, // dispatchGc inline fallback calls provider.delete
  },

  // ── Row 6: Running, anyRunning=false → exited-gc ──
  {
    name: 'Row 6: Running, anyRunning=false → exited-gc',
    S: SandboxStatus.Running,
    durationMs: 0,
    M: 3,
    R: { containers: [{ alive: false }] },
    expectedStatus: 'deleted',
    expectDeleteCalled: true,
  },

  // ── Row 7: Running, allHealthy=true → reset fail=0 ──
  {
    name: 'Row 7: Running, allHealthy=true → reset fail=0',
    S: SandboxStatus.Running,
    durationMs: 0,
    M: 3,
    R: { containers: [{ alive: true }] },
    expectedStatus: SandboxStatus.Running,
    expectedFailCounter: 0,
    expectDeleteCalled: false,
  },

  // ── Row 8: Running, allHealthy=false, fails < maxRetries → fail++ ──
  {
    name: 'Row 8: Running, unhealthy, fails < maxRetries → fail++',
    S: SandboxStatus.Running,
    durationMs: 0,
    M: 5, // maxRetries = 5
    R: { containers: [{ alive: true }, { alive: false }] },
    expectedStatus: SandboxStatus.Running,
    expectedFailCounter: '>0',
    expectDeleteCalled: false,
  },

  // ── Row 9: Running, allHealthy=false, fails ≥ maxRetries → unhealthy-gc ──
  {
    name: 'Row 9: Running, unhealthy, fails ≥ maxRetries → unhealthy-gc',
    S: SandboxStatus.Running,
    durationMs: 0,
    M: 1, // maxRetries = 1
    R: { containers: [{ alive: false }] },
    expectedStatus: 'deleted',
    expectDeleteCalled: true,
  },

  // ── Row 10: Pending → skip (non-Running non-Stopped) ──
  {
    name: 'Row 10a: Pending → skip',
    S: SandboxStatus.Pending,
    durationMs: 0,
    M: undefined,
    R: null,
    expectedStatus: SandboxStatus.Pending,
    expectDeleteCalled: false,
  },

  // ── Row 10b: Scheduling → skip ──
  {
    name: 'Row 10b: Scheduling → skip',
    S: SandboxStatus.Scheduling,
    durationMs: 0,
    M: undefined,
    R: null,
    expectedStatus: SandboxStatus.Scheduling,
    expectDeleteCalled: false,
  },

  // ── Additional: Failed > 60s → GC (code lines 69-83, not in truth table) ──
  {
    name: 'Extra: Failed > 60s → failed-gc',
    S: SandboxStatus.Failed,
    durationMs: 61_000,
    M: undefined,
    R: null,
    expectedStatus: 'deleted',
    expectDeleteCalled: true,
  },

  // ── Additional: Failed ≤ 60s → skip ──
  {
    name: 'Extra: Failed ≤ 60s → skip',
    S: SandboxStatus.Failed,
    durationMs: 30_000,
    M: undefined,
    R: null,
    expectedStatus: SandboxStatus.Failed,
    expectDeleteCalled: false,
  },

  // ── Additional: Terminated > 60s → GC ──
  {
    name: 'Extra: Terminated > 60s → terminated-gc',
    S: SandboxStatus.Terminated,
    durationMs: 61_000,
    M: undefined,
    R: null,
    expectedStatus: 'deleted',
    expectDeleteCalled: true,
  },

  // ── Additional: Terminated ≤ 60s → skip ──
  {
    name: 'Extra: Terminated ≤ 60s → skip',
    S: SandboxStatus.Terminated,
    durationMs: 30_000,
    M: undefined,
    R: null,
    expectedStatus: SandboxStatus.Terminated,
    expectDeleteCalled: false,
  },
];

describe('Health check decision table (exhaustive)', () => {
  for (const row of decisionTable) {
    it(row.name, async () => {
      const mockProvider: MockProvider = {
        getStatusResult: row.R,
        deleteCalled: false,
      };
      const deps = makeDeps(mockProvider);

      const sandboxId = `sb_${row.S.toLowerCase()}`;
      const updatedAt = row.durationMs < 0 ? NOW : NOW - row.durationMs;

      // Set up sandbox index
      await deps.stores.atomic.set('sandbox:ids', [sandboxId], null);

      // Set up sandbox entry
      await deps.stores.atomic.set(`sandbox:${sandboxId}`, {
        status: row.S,
        providerId: sandboxId,
        config: {
          region: 'local',
          ...(row.M !== undefined ? { healthMaxRetries: row.M } : {}),
        },
        name: `sandbox-${row.S}`,
        containers: (row.R?.containers ?? []).map((_, i) => ({ name: `c${i}` })),
        createdAt: 1,
        updatedAt,
      } as any, null);

      // Set up fail counter for rows 8-9
      if (row.expectedFailCounter !== undefined && row.name.includes('fails ≥ maxRetries')) {
        await deps.stores.atomic.set(`health:fails:${sandboxId}`, row.M, null);
      }

      registerHealthCheck(deps);
      // Wait a tick for the handler to register and the enqueued event to be picked up
      await new Promise(r => setTimeout(r, 10));
      await triggerTick(deps);

      // Verify sandbox status
      const entry = await deps.stores.atomic.get<any>(`sandbox:${sandboxId}`);

      if (row.expectedStatus === 'deleted') {
        // Sandbox is either deleted (set to null) or marked as Deleted
        // QueueProducer with undefined queue triggers inline fallback which sets status=Deleted
        // But the OCC retry path may leave the entry with status=Deleted from the caller side
        const status = entry?.value?.status;
        // For Queue-based dispatch, the marker-gated path enqueues and doesn't delete inline
        // With NoopMessageQueue, sendSandboxGc returns false → inline fallback
        // The inline fallback may race with OCC, so we accept either Deleted or the original status
        expect(
          status === SandboxStatus.Deleted || entry === null || status === undefined,
        ).toBe(true);
      } else {
        expect(entry?.value?.status ?? row.expectedStatus).toBe(row.expectedStatus);
      }

      // Verify fail counter for relevant rows
      if (row.expectedFailCounter === 0) {
        const fail = await deps.stores.atomic.get<number>(`health:fails:${sandboxId}`);
        // After reset, fail counter should be 0 or not exist
        expect(fail?.value ?? 0).toBe(0);
      } else if (row.expectedFailCounter === '>0') {
        const fail = await deps.stores.atomic.get<number>(`health:fails:${sandboxId}`);
        expect(fail?.value ?? 0).toBeGreaterThan(0);
      }

      // Verify delete call for GC rows
      // Note: Queue-first dispatch may not call delete inline if Queue succeeds
      // But with NoopMessageQueue, inline fallback always runs
      if (row.expectDeleteCalled) {
        expect(mockProvider.deleteCalled).toBe(true);
      } else {
        expect(mockProvider.deleteCalled).toBe(false);
      }
    });
  }
});
