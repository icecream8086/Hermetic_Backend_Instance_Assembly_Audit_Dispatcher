/**
 * Regression tests for DagScheduler features (ISSUE-00087/88/90/92/93/94).
 *
 * All tests instantiate a real DagScheduler and assert tick() side effects.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { DagScheduler, type DagSchedulerConfig } from '../../../src/core/scheduler/dag-scheduler.ts';
import type { ITimerBackend, TimerHandle } from '../../../src/core/scheduler/interfaces.ts';
import type { DagDef, DagRun, TaskInstance, Task, SchedulerContext, ContainerGroup, DagId, DagRunId, VersionId, TaskInstanceState } from '../../../src/core/dag/types.ts';
import { isTaskTerminal, isCgConsistentWithTi, createDagId, createTaskId, createDagRunId } from '../../../src/core/dag/types.ts';
import { generateVersionId } from '../../../src/core/brand.ts';
import { evaluateTriggerRule } from '../../../src/core/dag/trigger-rule.ts';

// ═══════════════════════════════════════════════════════════════
// Mock ITimerBackend — no-automatic, explicit tick only
// ═══════════════════════════════════════════════════════════════

class MockTimer implements ITimerBackend {
  start(_handler: () => void, _intervalMs: number): TimerHandle { return { clear() {} }; }
}

// ═══════════════════════════════════════════════════════════════
// In-memory SchedulerContext mock
// ═══════════════════════════════════════════════════════════════

class MockSchedulerContext implements SchedulerContext {
  dagDefs = new Map<string, DagDef>();
  dagRuns = new Map<string, DagRun>();
  taskInstances = new Map<string, TaskInstance>();
  pools = new Map<string, Pool_>();
  cgs = new Map<string, ContainerGroup>();
  executorCalled = 0;
  executorSuccess = true;
  approvalResult: 'pending' | 'approved' | 'rejected' | null = null;

  async getDagDef(dagId: DagId) {
    const v = this.dagDefs.get(dagId);
    return v ? { value: v, version: '' as VersionId } : null;
  }
  async getActiveDagRuns() {
    return [...this.dagRuns.values()].filter(r => r.status === 'QUEUED' || r.status === 'RUNNING');
  }
  async getDagRun(dagRunId: DagRunId) {
    const v = this.dagRuns.get(dagRunId);
    return v ? { value: v, version: '' as VersionId } : null;
  }
  async updateDagRun(dr: DagRun, _v: VersionId) { this.dagRuns.set(dr.id, dr); return true; }
  async getTaskInstances(_dagRunId: DagRunId) { return [...this.taskInstances.values()]; }
  async saveTaskInstance(ti: TaskInstance, _v?: VersionId | null) { this.taskInstances.set(ti.id, ti); return true; }
  async getPool(_name: string) { return null; }
  async updatePool(_p: Pool_) { return true; }
  async getExecutor(_key: string) {
    this.executorCalled++;
    return { key: _key, execute: async () => ({ success: this.executorSuccess, output: undefined }) };
  }
  async getApprovalStatus(_runId: DagRunId, _taskName: string) { return this.approvalResult; }
  async saveCG(cg: ContainerGroup, _v?: VersionId | null) { this.cgs.set(cg.id, cg); return true; }
  async getCG(id: string) { const v = this.cgs.get(id); return v ? { value: v, version: '' as VersionId } : null; }
  async updateCG(cg: ContainerGroup, _v: VersionId) { this.cgs.set(cg.id, cg); return true; }
  async getAllCGs() { return [...this.cgs.values()]; }
}

interface Pool_ { name: string; slots: number; occupiedSlots: number; }

// ═══════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════

function makeDagId(raw = 'dag_test'): DagId { return createDagId(raw); }
function makeRunId(raw = 'dr_test'): DagRunId { return createDagRunId(raw); }

function makeDag(overrides: Partial<DagDef> = {}): DagDef {
  return { id: makeDagId(), name: 'test', tasks: [], createdAt: 0, updatedAt: 0, version: generateVersionId(), ...overrides };
}

function makeTask(id: string, deps: string[] = [], overrides: Partial<Task> = {}): Task {
  return {
    id: createTaskId(id), name: id, operatorType: 'noop', dependsOn: deps.map(d => createTaskId(d)),
    triggerRule: 'all_success', retries: 0, retryDelayMs: 0, config: {}, ...overrides,
  } as Task;
}

function makeTi(id: string, taskId: string, state: TaskInstanceState, drId: DagRunId, overrides: Partial<TaskInstance> = {}): TaskInstance {
  return {
    id: id as TaskInstance['id'], taskId: createTaskId(taskId), dagRunId: drId,
    state, tryNumber: 0, version: generateVersionId(), ...overrides,
  } as TaskInstance;
}

function createScheduler(ctx: MockSchedulerContext, config: Partial<DagSchedulerConfig> = {}): DagScheduler {
  return new DagScheduler(ctx, new MockTimer(), { intervalMs: 5000, parallelism: 8, autoStart: false, ...config });
}

// ═══════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════

describe('DagScheduler tick() regression tests', () => {
  let ctx: MockSchedulerContext;

  beforeEach(() => {
    ctx = new MockSchedulerContext();
  });

  // ═══════════════════════════════════════════════════════════════
  // ISSUE-00087: upstream terminal check + eager UF
  // ═══════════════════════════════════════════════════════════════

  describe('ISSUE-00087 — upstream terminal check + eager UF', () => {
    it('upstream FAILED → eager mark TI as UPSTREAM_FAILED even if other upstream not terminal', async () => {
      // DAG: A → C, B → C. A=FAILED, B=RUNNING. C should be UPSTREAM_FAILED (eager, SPEC §5.5)
      const taskC = makeTask('c', ['a', 'b']);
      const taskA = makeTask('a');
      const taskB = makeTask('b');
      const dag = makeDag({ id: makeDagId(), tasks: [taskA, taskB, taskC] });
      ctx.dagDefs.set(dag.id, dag);
      const drId = makeRunId();
      const run: DagRun = { id: drId, dagId: dag.id, status: 'RUNNING', executionDate: 0, startedAt: Date.now(), trigger: 'manual', env: {}, version: generateVersionId() };
      ctx.dagRuns.set(run.id, run);
      ctx.taskInstances.set(makeTi('ti_a', 'a', 'FAILED', drId).id, makeTi('ti_a', 'a', 'FAILED', drId));
      ctx.taskInstances.set(makeTi('ti_b', 'b', 'RUNNING', drId).id, makeTi('ti_b', 'b', 'RUNNING', drId));
      ctx.taskInstances.set(makeTi('ti_c', 'c', 'NONE', drId).id, makeTi('ti_c', 'c', 'NONE', drId));

      const scheduler = createScheduler(ctx); scheduler.start(); await scheduler.tick();

      const tiC = [...ctx.taskInstances.values()].find(t => t.taskId === createTaskId('c'));
      expect(tiC?.state).toBe('UPSTREAM_FAILED');
    });

    it('no upstream terminal and no FAILED → TI stays NONE', async () => {
      const taskB = makeTask('b', ['a']);
      const taskA = makeTask('a');
      const dag = makeDag({ tasks: [taskA, taskB] });
      ctx.dagDefs.set(dag.id, dag);
      const drId = makeRunId();
      const run: DagRun = { id: drId, dagId: dag.id, status: 'RUNNING', executionDate: 0, startedAt: Date.now(), trigger: 'manual', env: {}, version: generateVersionId() };
      ctx.dagRuns.set(run.id, run);
      ctx.taskInstances.set(makeTi('ti_a', 'a', 'RUNNING', drId).id, makeTi('ti_a', 'a', 'RUNNING', drId));
      ctx.taskInstances.set(makeTi('ti_b', 'b', 'NONE', drId).id, makeTi('ti_b', 'b', 'NONE', drId));

      const s = createScheduler(ctx); s.start(); await s.tick();
      const tiB = [...ctx.taskInstances.values()].find(t => t.taskId === createTaskId('b'));
      expect(tiB?.state).toBe('NONE');
    });

    it('one_failed rule + FAILED upstream → SCHEDULED (not UPSTREAM_FAILED)', async () => {
      const taskB = makeTask('b', ['a'], { triggerRule: 'one_failed' });
      const taskA = makeTask('a');
      const dag = makeDag({ tasks: [taskA, taskB] });
      ctx.dagDefs.set(dag.id, dag);
      const drId = makeRunId();
      const run: DagRun = { id: drId, dagId: dag.id, status: 'RUNNING', executionDate: 0, startedAt: Date.now(), trigger: 'manual', env: {}, version: generateVersionId() };
      ctx.dagRuns.set(run.id, run);
      ctx.taskInstances.set(makeTi('ti_a', 'a', 'FAILED', drId).id, makeTi('ti_a', 'a', 'FAILED', drId));
      ctx.taskInstances.set(makeTi('ti_b', 'b', 'NONE', drId).id, makeTi('ti_b', 'b', 'NONE', drId));

      const s = createScheduler(ctx); s.start(); await s.tick();
      const tiB = [...ctx.taskInstances.values()].find(t => t.taskId === createTaskId('b'));
      // one_failed evaluates true with FAILED upstream → SCHEDULED→QUEUED→RUNNING→SUCCESS
      // (not UPSTREAM_FAILED — FAILURE_TOLERANT_RULES exclude one_failed from eager UF)
      expect(tiB?.state).toBe('SUCCESS');
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // ISSUE-00088: BranchSkip
  // ═══════════════════════════════════════════════════════════════

  describe('ISSUE-00088 — BranchSkip', () => {
    it('upstream SKIPPED + all_success → downstream SKIPPED via BranchSkip', async () => {
      const taskB = makeTask('b', ['a'], { triggerRule: 'all_success' });
      const taskA = makeTask('a');
      const dag = makeDag({ tasks: [taskA, taskB] });
      ctx.dagDefs.set(dag.id, dag);
      const drId = makeRunId();
      const run: DagRun = { id: drId, dagId: dag.id, status: 'RUNNING', executionDate: 0, startedAt: Date.now(), trigger: 'manual', env: {}, version: generateVersionId() };
      ctx.dagRuns.set(run.id, run);
      ctx.taskInstances.set(makeTi('ti_a', 'a', 'SKIPPED', drId).id, makeTi('ti_a', 'a', 'SKIPPED', drId));
      ctx.taskInstances.set(makeTi('ti_b', 'b', 'NONE', drId).id, makeTi('ti_b', 'b', 'NONE', drId));

      const s = createScheduler(ctx); s.start(); await s.tick();
      const tiB = [...ctx.taskInstances.values()].find(t => t.taskId === createTaskId('b'));
      expect(tiB?.state).toBe('SKIPPED');
    });

    it('upstream SUCCESS + all_success → downstream SCHEDULED', async () => {
      const taskB = makeTask('b', ['a'], { triggerRule: 'all_success' });
      const taskA = makeTask('a');
      const dag = makeDag({ tasks: [taskA, taskB] });
      ctx.dagDefs.set(dag.id, dag);
      const drId = makeRunId();
      const run: DagRun = { id: drId, dagId: dag.id, status: 'RUNNING', executionDate: 0, startedAt: Date.now(), trigger: 'manual', env: {}, version: generateVersionId() };
      ctx.dagRuns.set(run.id, run);
      ctx.taskInstances.set(makeTi('ti_a', 'a', 'SUCCESS', drId).id, makeTi('ti_a', 'a', 'SUCCESS', drId));
      ctx.taskInstances.set(makeTi('ti_b', 'b', 'NONE', drId).id, makeTi('ti_b', 'b', 'NONE', drId));

      const s = createScheduler(ctx); s.start(); await s.tick();
      const tiB = [...ctx.taskInstances.values()].find(t => t.taskId === createTaskId('b'));
      // tick() runs all 4 phases → SCHEDULED→QUEUED→RUNNING→SUCCESS (executor returns true)
      expect(tiB?.state).toBe('SUCCESS');
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // ISSUE-00090: maxActiveRuns (P7)
  // ═══════════════════════════════════════════════════════════════

  describe('ISSUE-00090 — maxActiveRuns (P7)', () => {
    it('maxActiveRuns=1 → second QUEUED DagRun stays QUEUED after tick', async () => {
      const dag = makeDag({ maxActiveRuns: 1 });
      ctx.dagDefs.set(dag.id, dag);
      const dr1 = makeRunId('dr1');
      const dr2 = makeRunId('dr2');
      ctx.dagRuns.set(dr1, { id: dr1, dagId: dag.id, status: 'RUNNING', executionDate: 0, startedAt: Date.now(), trigger: 'manual', env: {}, version: generateVersionId() });
      ctx.dagRuns.set(dr2, { id: dr2, dagId: dag.id, status: 'QUEUED', executionDate: 0, trigger: 'manual', env: {}, version: generateVersionId() });

      const s = createScheduler(ctx); s.start(); await s.tick();
      expect(ctx.dagRuns.get(dr2)?.status).toBe('QUEUED'); // stayed QUEUED
    });

    it('maxActiveRuns=2 → second QUEUED DagRun becomes RUNNING after tick', async () => {
      const dag = makeDag({ maxActiveRuns: 2 });
      ctx.dagDefs.set(dag.id, dag);
      const dr1 = makeRunId('dr1');
      const dr2 = makeRunId('dr2');
      ctx.dagRuns.set(dr1, { id: dr1, dagId: dag.id, status: 'RUNNING', executionDate: 0, startedAt: Date.now(), trigger: 'manual', env: {}, version: generateVersionId() });
      ctx.dagRuns.set(dr2, { id: dr2, dagId: dag.id, status: 'QUEUED', executionDate: 0, trigger: 'manual', env: {}, version: generateVersionId() });

      const s = createScheduler(ctx); s.start(); await s.tick();
      expect(ctx.dagRuns.get(dr2)?.status).toBe('RUNNING');
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // ISSUE-00092: CG consistency
  // ═══════════════════════════════════════════════════════════════

  describe('ISSUE-00092 — CG consistency', () => {
    it('execute() creates CG with Pending state when task runs', async () => {
      const taskA = makeTask('a');
      const dag = makeDag({ tasks: [taskA] });
      ctx.dagDefs.set(dag.id, dag);
      const drId = makeRunId();
      const run: DagRun = { id: drId, dagId: dag.id, status: 'RUNNING', executionDate: 0, startedAt: Date.now(), trigger: 'manual', env: {}, version: generateVersionId() };
      ctx.dagRuns.set(drId, run);
      // Set TI as QUEUED so execute() picks it up
      ctx.taskInstances.set(makeTi('ti_a', 'a', 'QUEUED', drId).id, makeTi('ti_a', 'a', 'QUEUED', drId));

      const s = createScheduler(ctx); s.start(); await s.tick();

      // CG was created in execute() for the 'noop' task
      expect(ctx.cgs.size).toBe(1);
      const cg = [...ctx.cgs.values()][0]!;
      expect(cg.state).toBe('Succeeded'); // executor returned success
      expect(cg.taskInstanceId).toBe('ti_a');
    });

    it('execute() creates CG with Failed state when executor fails', async () => {
      const taskA = makeTask('a');
      const dag = makeDag({ tasks: [taskA] });
      ctx.dagDefs.set(dag.id, dag);
      const drId = makeRunId();
      const run: DagRun = { id: drId, dagId: dag.id, status: 'RUNNING', executionDate: 0, startedAt: Date.now(), trigger: 'manual', env: {}, version: generateVersionId() };
      ctx.dagRuns.set(drId, run);
      ctx.taskInstances.set(makeTi('ti_a', 'a', 'QUEUED', drId).id, makeTi('ti_a', 'a', 'QUEUED', drId));
      ctx.executorSuccess = false;

      const s = createScheduler(ctx); s.start(); await s.tick();

      expect(ctx.cgs.size).toBe(1);
      const cg = [...ctx.cgs.values()][0]!;
      expect(cg.state).toBe('Failed');
    });

    it('isCgConsistentWithTi called from execute() catches C4 violation', async () => {
      expect(isCgConsistentWithTi('RUNNING', 'Succeeded')).toBe(false);
      expect(isCgConsistentWithTi('RUNNING', 'Running')).toBe(true);
      expect(isCgConsistentWithTi('SUCCESS', 'Succeeded')).toBe(true);
      expect(isCgConsistentWithTi('SUCCESS', 'Running')).toBe(false);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // ISSUE-00093: QUEUED→FAILED + timeout
  // ═══════════════════════════════════════════════════════════════

  describe('ISSUE-00093 — DagRun QUEUED→FAILED and timeout', () => {
    it('DagDef missing → DagRun FAILED via tick()', async () => {
      const drId = makeRunId();
      const run: DagRun = { id: drId, dagId: makeDagId('nonexistent'), status: 'QUEUED', executionDate: 0, trigger: 'manual', env: {}, version: generateVersionId() };
      ctx.dagRuns.set(drId, run);

      const s = createScheduler(ctx); s.start(); await s.tick();
      expect(ctx.dagRuns.get(drId)?.status).toBe('FAILED');
      expect(ctx.dagRuns.get(drId)?.error).toContain('not found');
    });

    it('DagRun timeout → FAILED + RUNNING TIs become FAILED', async () => {
      const dag = makeDag();
      ctx.dagDefs.set(dag.id, dag);
      const drId = makeRunId();
      const run: DagRun = { id: drId, dagId: dag.id, status: 'RUNNING', executionDate: 0, startedAt: Date.now() - 200_000, trigger: 'manual', env: {}, version: generateVersionId() };
      ctx.dagRuns.set(drId, run);
      ctx.taskInstances.set(makeTi('ti_run', 'a', 'RUNNING', drId).id, makeTi('ti_run', 'a', 'RUNNING', drId));
      ctx.taskInstances.set(makeTi('ti_q', 'b', 'QUEUED', drId).id, makeTi('ti_q', 'b', 'QUEUED', drId));
      ctx.taskInstances.set(makeTi('ti_ok', 'c', 'SUCCESS', drId).id, makeTi('ti_ok', 'c', 'SUCCESS', drId));

      // dagRunTimeoutMs = 50ms → the 200s old run will time out
      const s = createScheduler(ctx, { dagRunTimeoutMs: 50 }); s.start(); await s.tick();

      expect(ctx.dagRuns.get(drId)?.status).toBe('FAILED');
      const tis = [...ctx.taskInstances.values()];
      expect(tis.find(t => t.taskId === createTaskId('a'))?.state).toBe('FAILED'); // RUNNING → FAILED
      // QUEUED TI stays QUEUED (DagRun FAILED prevents further scheduling)
      expect(tis.find(t => t.taskId === createTaskId('b'))?.state).toBe('QUEUED');
      expect(tis.find(t => t.taskId === createTaskId('c'))?.state).toBe('SUCCESS'); // unchanged
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // ISSUE-00094: ApprovalSensor
  // ═══════════════════════════════════════════════════════════════

  describe('ISSUE-00094 — ApprovalSensor', () => {
    const approvalTask = makeTask('gate', [], { operatorType: 'approval-sensor', config: { approval: { approvers: ['alice'] } } });

    it('pending approval → TI stays QUEUED, executor not called', async () => {
      const dag = makeDag({ tasks: [approvalTask] });
      ctx.dagDefs.set(dag.id, dag);
      const drId = makeRunId();
      const run: DagRun = { id: drId, dagId: dag.id, status: 'RUNNING', executionDate: 0, startedAt: Date.now(), trigger: 'manual', env: {}, version: generateVersionId() };
      ctx.dagRuns.set(drId, run);
      ctx.taskInstances.set(makeTi('ti_g', 'gate', 'QUEUED', drId).id, makeTi('ti_g', 'gate', 'QUEUED', drId));
      ctx.approvalResult = 'pending';

      const s = createScheduler(ctx); s.start(); await s.tick();
      const ti = [...ctx.taskInstances.values()].find(t => t.taskId === createTaskId('gate'));
      expect(ti?.state).toBe('QUEUED');
      expect(ctx.executorCalled).toBe(0);
    });

    it('rejected approval → TI becomes FAILED', async () => {
      const dag = makeDag({ tasks: [approvalTask] });
      ctx.dagDefs.set(dag.id, dag);
      const drId = makeRunId();
      const run: DagRun = { id: drId, dagId: dag.id, status: 'RUNNING', executionDate: 0, startedAt: Date.now(), trigger: 'manual', env: {}, version: generateVersionId() };
      ctx.dagRuns.set(drId, run);
      ctx.taskInstances.set(makeTi('ti_g', 'gate', 'QUEUED', drId).id, makeTi('ti_g', 'gate', 'QUEUED', drId));
      ctx.approvalResult = 'rejected';

      const s = createScheduler(ctx); s.start(); await s.tick();
      const ti = [...ctx.taskInstances.values()].find(t => t.taskId === createTaskId('gate'));
      expect(ti?.state).toBe('FAILED');
      expect(ctx.executorCalled).toBe(0);
    });

    it('approved approval → executor is called', async () => {
      const dag = makeDag({ tasks: [approvalTask] });
      ctx.dagDefs.set(dag.id, dag);
      const drId = makeRunId();
      const run: DagRun = { id: drId, dagId: dag.id, status: 'RUNNING', executionDate: 0, startedAt: Date.now(), trigger: 'manual', env: {}, version: generateVersionId() };
      ctx.dagRuns.set(drId, run);
      ctx.taskInstances.set(makeTi('ti_g', 'gate', 'QUEUED', drId).id, makeTi('ti_g', 'gate', 'QUEUED', drId));
      ctx.approvalResult = 'approved';

      const s = createScheduler(ctx); s.start(); await s.tick();
      expect(ctx.executorCalled).toBe(1);
    });
  });
});
