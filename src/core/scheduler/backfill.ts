import type { DagDef, DagRun } from '../dag/types.ts';
import { createDagRunId } from '../dag/types.ts';

// ─── Types ───

export interface BackfillConfig {
  /** Start of the catchup window (epoch ms). */
  startDate: number;
  /** End of the catchup window (epoch ms). Default: now. */
  endDate?: number;
  /** If true, reset existing DagRuns in the window before backfilling. */
  resetDagRuns?: boolean;
}

export interface BackfillResult {
  created: number;
  skipped: number;
  errors: string[];
}

// ─── Default cron → interval mapping ───

const DEFAULT_SCHEDULE_INTERVAL_MS = 3_600_000; // 1 hour

/**
 * Parse a simple cron expression to a millisecond interval.
 * Supports: every N minutes pattern and every minute pattern.
 * Returns null for unsupported patterns.
 */
export function cronToIntervalMs(cron: string): number | null {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return null;

  const [minute, hour, day, month, weekday] = parts;

  // */N * * * *
  if (minute?.startsWith('*/') && hour === '*' && day === '*' && month === '*' && weekday === '*') {
    const n = parseInt(minute!.slice(2), 10);
    if (n > 0 && n <= 60) return n * 60_000;
  }

  // * * * * *
  if (minute === '*' && hour === '*' && day === '*' && month === '*' && weekday === '*') return 60_000;

  // N * * * * (every hour at minute N)
  const min = parseInt(minute!, 10);
  if (!isNaN(min) && min >= 0 && min < 60 && hour === '*' && day === '*' && month === '*' && weekday === '*') return 3_600_000;

  return null;
}

// ─── Backfill engine ───

/**
 * Create DagRuns for missed schedule intervals (catchup).
 *
 * Given a DagDef with `schedule` and `catchup: true`, compute the missed
 * execution dates between the last completed DagRun and now, and create
 * one DagRun per interval.
 *
 * @param dagDef  — The DAG definition with schedule info.
 * @param existingRuns — Already-created DagRuns (to avoid duplicates).
 * @param config  — Backfill window configuration.
 * @param factory — Callback that creates and persists a DagRun.
 */
export async function backfillDagRuns(
  dagDef: DagDef,
  existingRuns: readonly DagRun[],
  config: BackfillConfig,
  factory: (dagRun: Omit<DagRun, 'version'>) => Promise<boolean>,
): Promise<BackfillResult> {
  const result: BackfillResult = { created: 0, skipped: 0, errors: [] };

  if (!dagDef.schedule || !dagDef.catchup) return result;

  const intervalMs = cronToIntervalMs(dagDef.schedule);
  if (!intervalMs) {
    result.errors.push(`Unsupported schedule: ${dagDef.schedule}`);
    return result;
  }

  const endDate = config.endDate ?? Date.now();
  const existingDates = new Set(existingRuns.map(r => r.executionDate));

  // Generate execution dates for the window
  const dates: number[] = [];
  for (let d = config.startDate; d < endDate; d += intervalMs) {
    dates.push(d);
  }

  // Skip if there's less than 1 interval between runs
  if (dates.length <= 1) return result;

  for (const execDate of dates) {
    if (existingDates.has(execDate)) {
      result.skipped++;
      continue;
    }

    const dagRun: Omit<DagRun, 'version'> = {
      id: createDagRunId(`dr_${dagDef.id}_${execDate}_${crypto.randomUUID()}` as string),
      dagId: dagDef.id,
      status: 'QUEUED',
      executionDate: execDate,
      trigger: 'backfill',
      env: {},
    };

    try {
      const ok = await factory(dagRun);
      if (ok) {
        result.created++;
      } else {
        result.errors.push(`Factory returned false for execution date ${execDate}`);
      }
    } catch (err) {
      result.errors.push(
        `Failed to create DagRun for ${execDate}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return result;
}

/**
 * Compute the start date for backfill: either the DAG's createdAt, or the
 * last completed DagRun's execution date + one interval.
 */
export function computeBackfillStart(
  dagDef: DagDef,
  existingRuns: readonly DagRun[],
): number {
  const completed = existingRuns
    .filter(r => r.status === 'SUCCESS' || r.status === 'FAILED')
    .sort((a, b) => b.executionDate - a.executionDate);

  if (completed.length > 0) {
    const lastDate = completed[0]!.executionDate;
    const intervalMs = (dagDef.schedule ? cronToIntervalMs(dagDef.schedule) : null) ?? DEFAULT_SCHEDULE_INTERVAL_MS;
    return lastDate + intervalMs;
  }

  // No runs exist — start from DAG creation
  return dagDef.createdAt;
}
