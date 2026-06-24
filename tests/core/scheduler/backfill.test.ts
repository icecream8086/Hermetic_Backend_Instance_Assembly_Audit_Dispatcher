import { describe, it, expect } from 'vitest';
import {
  cronToIntervalMs,
  computeBackfillStart,
  backfillDagRuns,
} from '../../../src/core/scheduler/backfill.ts';
import type { DagDef, DagRun, DagId } from '../../../src/core/dag/types.ts';
import { createDagId, createDagRunId } from '../../../src/core/dag/types.ts';

function dummyDag(schedule?: string, catchup?: boolean, createdAt?: number): DagDef {
  return {
    id: createDagId('dag_test' as string),
    name: 'test-dag',
    tasks: [],
    ...(schedule ? { schedule } : {}),
    ...(catchup !== undefined ? { catchup } : {}),
    createdAt: createdAt ?? Date.now() - 3_600_000 * 3, // 3 hours ago
    updatedAt: Date.now(),
    version: 'v1' as any,
  };
}

function dummyRun(execDate: number, status: DagRun['status'] = 'SUCCESS'): DagRun {
  return {
    id: createDagRunId(`dr_dag_test_${execDate}_uuid` as string),
    dagId: createDagId('dag_test' as string),
    status,
    executionDate: execDate,
    trigger: 'manual',
    env: {},
    version: 'v1' as any,
  };
}

describe('cronToIntervalMs', () => {
  it('parses */N patterns', () => {
    expect(cronToIntervalMs('*/5 * * * *')).toBe(300_000);
    expect(cronToIntervalMs('*/30 * * * *')).toBe(1_800_000);
    expect(cronToIntervalMs('*/1 * * * *')).toBe(60_000);
  });

  it('parses * * * * * as 1 minute', () => {
    expect(cronToIntervalMs('* * * * *')).toBe(60_000);
  });

  it('parses hourly patterns', () => {
    expect(cronToIntervalMs('0 * * * *')).toBe(3_600_000);
    expect(cronToIntervalMs('30 * * * *')).toBe(3_600_000);
  });

  it('returns null for unsupported patterns', () => {
    expect(cronToIntervalMs('0 0 * * *')).toBeNull(); // daily
    expect(cronToIntervalMs('invalid')).toBeNull();
  });
});

describe('computeBackfillStart', () => {
  it('starts from DAG creation when no runs exist', () => {
    const dag = dummyDag('*/5 * * * *', true, 100_000);
    const start = computeBackfillStart(dag, []);
    expect(start).toBe(100_000);
  });

  it('starts from last completed run + interval', () => {
    const dag = dummyDag('*/10 * * * *', true);
    const runs = [
      dummyRun(200_000, 'SUCCESS'),
      dummyRun(100_000, 'FAILED'),
    ];
    const start = computeBackfillStart(dag, runs);
    expect(start).toBe(200_000 + 600_000); // 10 min interval
  });

  it('uses default interval when no schedule', () => {
    const dag = dummyDag(undefined, true);
    const runs = [dummyRun(200_000)];
    const start = computeBackfillStart(dag, runs);
    expect(start).toBe(200_000 + 3_600_000); // 1 hour default
  });
});

describe('backfillDagRuns', () => {
  it('skips when no schedule', async () => {
    const dag = dummyDag(undefined, true);
    const result = await backfillDagRuns(dag, [], { startDate: 0 }, async () => true);
    expect(result.created).toBe(0);
  });

  it('skips when catchup is false', async () => {
    const dag = dummyDag('*/5 * * * *', false);
    const result = await backfillDagRuns(dag, [], { startDate: 0 }, async () => true);
    expect(result.created).toBe(0);
  });

  it('creates runs for missed intervals', async () => {
    const dag = dummyDag('*/5 * * * *', true);
    // DAG created 3 hours ago, so there are 36 five-minute intervals
    // But the interval is very small, let's narrow the window
    const startDate = Date.now() - 600_000; // 10 min ago
    const endDate = Date.now();
    const created: number[] = [];

    const result = await backfillDagRuns(
      dag,
      [],
      { startDate, endDate },
      async (run) => { created.push(run.executionDate); return true; },
    );

    // 10 minutes with 5-min interval = at least 2, possibly 3 (edge)
    expect(result.created).toBeGreaterThanOrEqual(2);
    expect(result.created).toBeLessThanOrEqual(3);
    expect(created[0]).toBeGreaterThanOrEqual(startDate);
    expect(created[created.length - 1]!).toBeLessThan(endDate);
  });

  it('skips existing runs', async () => {
    const dag = dummyDag('*/5 * * * *', true);
    const startDate = Date.now() - 600_000;
    const existing = [dummyRun(startDate)];

    const result = await backfillDagRuns(dag, existing, { startDate, endDate: Date.now() }, async () => true);
    expect(result.skipped).toBeGreaterThanOrEqual(1);
  });

  it('reports errors from factory', async () => {
    const dag = dummyDag('*/5 * * * *', true);
    const startDate = Date.now() - 600_000;

    const result = await backfillDagRuns(
      dag,
      [],
      { startDate, endDate: Date.now() },
      async () => { throw new Error('boom'); },
    );
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('reports unsupported schedule', async () => {
    const dag = dummyDag('0 0 * * *', true); // daily — unsupported
    const result = await backfillDagRuns(dag, [], { startDate: 0 }, async () => true);
    expect(result.errors.length).toBe(1);
    expect(result.errors[0]).toContain('Unsupported');
  });
});
