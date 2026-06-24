import type { ITimerBackend, SchedulerStatus } from './interfaces.ts';
import type {
  DagRun,
  TaskInstanceState,
  SchedulerContext,
  ITaskExecutor,
} from '../dag/types.ts';
import { isTaskTerminal, DEFAULT_TRIGGER_RULE } from '../dag/types.ts';
import { evaluateTriggerRule } from '../dag/trigger-rule.ts';
import {
  createTaskInstance,
  transitionState,
  shouldRetry,
  markSuccess,
  markFailed,
  markUpstreamFailed,
} from './task-instance.ts';
import { ConcurrencyMap } from './concurrency-map.ts';
import { filterScheduledTasks, type FilterContext } from './filter.ts';
import { openSlots, DEFAULT_POOL_NAME } from './pool.ts';
import { generateVersionId } from '../brand.ts';

// ─── Config ───

export interface DagSchedulerConfig {
  /** Tick interval in milliseconds. */
  intervalMs: number;
  /** Maximum concurrent executing tasks across all DAGs. */
  parallelism: number;
  /** Auto-start the scheduler loop. */
  autoStart: boolean;
}

const DEFAULT_CONFIG: DagSchedulerConfig = {
  intervalMs: 5000,
  parallelism: 8,
  autoStart: true,
};

// ─── Scheduler job ───

/**
 * DAG Scheduler — Airflow `SchedulerJobRunner` main loop.
 *
 * On each tick:
 *   1. schedule  — evaluate trigger rules, move NONE→SCHEDULED
 *   2. process   — 5-step filter, move SCHEDULED→QUEUED
 *   3. execute   — claim slots, dispatch QUEUED→RUNNING to executors
 *   4. heartbeat — check RUNNING tasks for completion/timeout
 *
 * The scheduler uses {@link SchedulerContext} for all persistence and
 * {@link ITimerBackend} for the timing loop. Executors are resolved
 * via the context's `getExecutor()` method.
 */
export class DagScheduler {
  private config: DagSchedulerConfig;
  private running = false;
  private paused = false;
  private startedAt = 0;
  private timerHandle: ReturnType<ITimerBackend['start']> | null = null;
  private tickCount = 0;
  private readonly executorCache = new Map<string, ITaskExecutor>();

  constructor(
    private readonly ctx: SchedulerContext,
    private readonly timer: ITimerBackend,
    config: Partial<DagSchedulerConfig> = {},
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // ─── Lifecycle ───

  start(): void {
    if (this.running) return;
    this.running = true;
    this.paused = false;
    this.startedAt = Date.now();
    this.timerHandle = this.timer.start(() => this.tick(), this.config.intervalMs);
  }

  stop(): void {
    this.running = false;
    this.timerHandle?.clear();
    this.timerHandle = null;
  }

  pause(): void { this.paused = true; }
  resume(): void { this.paused = false; }

  configure(partial: Partial<DagSchedulerConfig>): DagSchedulerConfig {
    this.config = { ...this.config, ...partial };
    // Restart timer if interval changed and running
    if (this.running) {
      this.timerHandle?.clear();
      this.timerHandle = this.timer.start(() => this.tick(), this.config.intervalMs);
    }
    return this.config;
  }

  status(): SchedulerStatus {
    return {
      running: this.running,
      paused: this.paused,
      uptimeMs: Date.now() - this.startedAt,
      config: { intervalMs: this.config.intervalMs, autoStart: this.config.autoStart },
    };
  }

  // ─── Main tick ───

  async tick(): Promise<void> {
    if (!this.running || this.paused) return;
    this.tickCount++;

    try {
      await this.schedule();
      await this.process();
      await this.execute();
      await this.heartbeat();
    } catch (err) {
      // Log but don't crash the scheduler
      console.error(`[DagScheduler] tick #${this.tickCount} error:`, err);
    }
  }

  // ─── Phase 1: Schedule ───

  private async schedule(): Promise<void> {
    const dagRuns = await this.ctx.getActiveDagRuns();
    if (dagRuns.length === 0) return;

    for (const run of dagRuns) {
      if (run.status !== 'QUEUED' && run.status !== 'RUNNING') continue;

      // Transition to RUNNING if this is the first active tick
      let currentRun = run;
      if (currentRun.status === 'QUEUED') {
        const runEntry = await this.ctx.getDagRun(currentRun.id);
        if (!runEntry) continue;
        currentRun = { ...currentRun, status: 'RUNNING', startedAt: Date.now(), version: generateVersionId() };
        await this.ctx.updateDagRun(currentRun, runEntry.version);
      }

      const dagDefEntry = await this.ctx.getDagDef(currentRun.dagId);
      if (!dagDefEntry) continue;
      const dagDef = dagDefEntry.value;

      const tis = await this.ctx.getTaskInstances(currentRun.id);

      // Build upstream state lookup per task
      const tiMap = new Map(tis.map(ti => [ti.taskId, ti]));

      for (const task of dagDef.tasks) {
        let ti = tiMap.get(task.id);
        if (!ti) {
          // First encounter — create TaskInstance
          ti = createTaskInstance({
            id: `ti_${crypto.randomUUID()}` as any,
            taskId: task.id,
            dagRunId: currentRun.id,
          });
          await this.ctx.saveTaskInstance(ti, null);
          continue;
        }

        // Only schedule NONE and UP_FOR_RETRY tasks
        if (ti.state !== 'NONE' && ti.state !== 'UP_FOR_RETRY') continue;

        // Evaluate trigger rule
        const upstreamStates: TaskInstanceState[] = task.dependsOn.map(depId => {
          const depTi = tiMap.get(depId);
          return depTi?.state ?? 'NONE';
        });

        const rule = task.triggerRule ?? DEFAULT_TRIGGER_RULE;
        if (ti.state === 'NONE' && evaluateTriggerRule(rule, upstreamStates)) {
          ti = transitionState(ti, 'SCHEDULED');
          await this.ctx.saveTaskInstance(ti);
          tiMap.set(task.id, ti);
        }

        // UP_FOR_RETRY → QUEUED (when retry delay elapsed)
        if (ti.state === 'UP_FOR_RETRY') {
          const retryDelay = task.retryDelayMs ?? 30_000;
          if (ti.completedAt && Date.now() - ti.completedAt >= retryDelay) {
            ti = transitionState(ti, 'QUEUED');
            ti = { ...ti, tryNumber: ti.tryNumber + 1 };
            await this.ctx.saveTaskInstance(ti);
            tiMap.set(task.id, ti);
          }
        }

        // Handle upstream failures
        if (ti.state === 'NONE') {
          const anyUpstreamFailed = upstreamStates.some(
            s => s === 'FAILED' || s === 'UPSTREAM_FAILED',
          );
          if (anyUpstreamFailed && rule !== 'always') {
            ti = markUpstreamFailed(ti, 'Upstream task failed');
            await this.ctx.saveTaskInstance(ti);
            tiMap.set(task.id, ti);
          }
        }
      }

      // Check if all tasks are terminal → complete the DagRun
      const allTerminal = dagDef.tasks.every(t => {
        const ti = tiMap.get(t.id);
        return ti && isTaskTerminal(ti.state);
      });
      if (allTerminal && dagDef.tasks.length > 0) {
        const anyFailed = dagDef.tasks.some(t => {
          const ti = tiMap.get(t.id);
          return ti && (ti.state === 'FAILED' || ti.state === 'UPSTREAM_FAILED');
        });
        const runEntry = await this.ctx.getDagRun(currentRun.id);
        if (runEntry) {
          const finalRun: DagRun = {
            ...currentRun,
            status: anyFailed ? 'FAILED' : 'SUCCESS',
            completedAt: Date.now(),
            version: generateVersionId(),
          };
          await this.ctx.updateDagRun(finalRun, runEntry.version);
        }
      }
    }
  }

  // ─── Phase 2: Process (filter) ───

  private async process(): Promise<void> {
    const dagRuns = await this.ctx.getActiveDagRuns();
    if (dagRuns.length === 0) return;

    for (const run of dagRuns) {
      if (run.status !== 'RUNNING') continue;

      const dagDefEntry = await this.ctx.getDagDef(run.dagId);
      if (!dagDefEntry) continue;
      const dagDef = dagDefEntry.value;

      const tis = await this.ctx.getTaskInstances(run.id);
      const scheduled = tis.filter(ti => ti.state === 'SCHEDULED');
      if (scheduled.length === 0) continue;

      // Build context for filter
      const taskMap = new Map(dagDef.tasks.map(t => [t.id, t]));

      // Pool slots
      const poolNames = new Set(dagDef.tasks.map(t => t.pool ?? DEFAULT_POOL_NAME));
      const poolSlots = new Map<string, number>();
      for (const pn of poolNames) {
        const pool = await this.ctx.getPool(pn);
        poolSlots.set(pn, pool ? openSlots(pool) : 128);
      }

      // Dag max active
      const dagMaxActive = new Map<string, number>();
      dagMaxActive.set(dagDef.id, dagDef.maxActiveTasks ?? 16);

      const concurrencyMap = new ConcurrencyMap(
        tis.filter(ti => !isTaskTerminal(ti.state)),
      );

      const alreadyQueued = tis.filter(ti => ti.state === 'QUEUED').length;

      const filterCtx: FilterContext = {
        tasks: taskMap as ReadonlyMap<string, import('../dag/types.ts').Task>,
        poolSlots,
        dagMaxActive,
        concurrencyMap,
        parallelism: this.config.parallelism,
        alreadyQueued,
      };

      const result = filterScheduledTasks(scheduled, filterCtx);

      // Advance passed tasks to QUEUED
      for (const ti of result.passed) {
        const updated = transitionState(ti, 'QUEUED');
        await this.ctx.saveTaskInstance(updated);
      }
    }
  }

  // ─── Phase 3: Execute ───

  private async execute(): Promise<void> {
    const dagRuns = await this.ctx.getActiveDagRuns();
    if (dagRuns.length === 0) return;

    for (const run of dagRuns) {
      if (run.status !== 'RUNNING') continue;

      const tis = await this.ctx.getTaskInstances(run.id);
      const queued = tis.filter(ti => ti.state === 'QUEUED');
      if (queued.length === 0) continue;

      const dagDefEntry = await this.ctx.getDagDef(run.dagId);
      if (!dagDefEntry) continue;
      const dagDef = dagDefEntry.value;
      const taskMap = new Map(dagDef.tasks.map(t => [t.id, t]));

      for (const ti of queued) {
        const task = taskMap.get(ti.taskId);
        if (!task) continue;

        // Claim pool slot
        const poolName = task.pool ?? DEFAULT_POOL_NAME;
        const pool = await this.ctx.getPool(poolName);
        if (pool) {
          const open = openSlots(pool);
          if (open <= 0) continue; // pool full, try next tick
          await this.ctx.updatePool({ ...pool, occupiedSlots: pool.occupiedSlots + 1 });
        }

        // Resolve and dispatch to executor
        const executorKey = task.executorKey ?? task.operatorType;
        const executor = await this.getExecutor(executorKey);
        if (!executor) {
          // No executor — release slot and skip
          if (pool) await this.ctx.updatePool({ ...pool, occupiedSlots: Math.max(0, pool.occupiedSlots - 1) });
          continue;
        }

        // Transition to RUNNING
        let running = transitionState(ti, 'RUNNING');
        await this.ctx.saveTaskInstance(running);

        // Execute
        try {
          const result = await executor.execute(task, running);

          if (pool) {
            const p2 = await this.ctx.getPool(poolName);
            if (p2) await this.ctx.updatePool({ ...p2, occupiedSlots: Math.max(0, p2.occupiedSlots - 1) });
          }

          if (result.success) {
            running = markSuccess(running, result.output);
          } else {
            if (shouldRetry(running, task.retries)) {
              running = transitionState(running, 'UP_FOR_RETRY');
            } else {
              running = markFailed(running, result.error ?? 'Task failed', result.exitCode);
            }
          }
          await this.ctx.saveTaskInstance(running);
        } catch (err) {
          if (pool) {
            const p2 = await this.ctx.getPool(poolName);
            if (p2) await this.ctx.updatePool({ ...p2, occupiedSlots: Math.max(0, p2.occupiedSlots - 1) });
          }

          const msg = err instanceof Error ? err.message : String(err);
          if (shouldRetry(running, task.retries)) {
            running = transitionState(running, 'UP_FOR_RETRY');
          } else {
            running = markFailed(running, msg);
          }
          await this.ctx.saveTaskInstance(running);
        }
      }
    }
  }

  // ─── Phase 4: Heartbeat ───

  private async heartbeat(): Promise<void> {
    const dagRuns = await this.ctx.getActiveDagRuns();
    if (dagRuns.length === 0) return;

    for (const run of dagRuns) {
      if (run.status !== 'RUNNING') continue;

      const tis = await this.ctx.getTaskInstances(run.id);
      const running = tis.filter(ti => ti.state === 'RUNNING');
      if (running.length === 0) continue;

      const dagDefEntry = await this.ctx.getDagDef(run.dagId);
      if (!dagDefEntry) continue;

      const taskMap = new Map(dagDefEntry.value.tasks.map(t => [t.id, t]));

      for (const ti of running) {
        const task = taskMap.get(ti.taskId);
        if (!task?.timeoutMs) continue;

        const elapsed = ti.startedAt ? Date.now() - ti.startedAt : 0;
        if (elapsed > task.timeoutMs) {
          const msg = `Task timed out after ${task.timeoutMs}ms`;

          if (shouldRetry(ti, task.retries)) {
            const retried = transitionState(ti, 'UP_FOR_RETRY');
            await this.ctx.saveTaskInstance({ ...retried, error: msg });
          } else {
            const failed = markFailed(ti, msg);
            await this.ctx.saveTaskInstance(failed);
          }

          // Release pool slot
          const poolName = task.pool ?? DEFAULT_POOL_NAME;
          const pool = await this.ctx.getPool(poolName);
          if (pool) {
            await this.ctx.updatePool({
              ...pool,
              occupiedSlots: Math.max(0, pool.occupiedSlots - 1),
            });
          }
        }
      }
    }
  }

  // ─── Executor cache ───

  private async getExecutor(key: string): Promise<ITaskExecutor | null> {
    const cached = this.executorCache.get(key);
    if (cached) return cached;

    const executor = await this.ctx.getExecutor(key);
    if (executor) this.executorCache.set(key, executor);
    return executor;
  }
}
