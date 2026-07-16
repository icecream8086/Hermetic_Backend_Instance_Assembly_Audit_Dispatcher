import type { SchedulerContext, DagDef, DagRun, TaskInstance, Pool, ContainerGroup, ITaskExecutor, DagRunId, DagId } from '../../core/dag/types.ts';
import type { IAtomicStore } from '../../core/store/interfaces.ts';
import type { VersionId } from '../../core/brand.ts';

/**
 * AtomicStore-backed implementation of SchedulerContext.
 *
 * Uses the existing IAtomicStore (KV/file) to persist DAG definitions,
 * DagRuns, TaskInstances, and Pools. This adapts the new scheduler to
 * the existing storage infrastructure.
 */

const PFX_DAG_DEF = 'dag-def:';
const PFX_DAG_RUN = 'dag-run:';
const PFX_TASK_INST = 'task-inst:';
const PFX_POOL = 'pool:';
const PFX_CG = 'cg:';
const IDX_DAG_DEFS = 'idx:dag-defs';
const IDX_POOLS = 'idx:pools';
const IDX_CGS = 'idx:cgs';

export class StoreSchedulerContext implements SchedulerContext {
  private readonly executorRegistry = new Map<string, ITaskExecutor>();

  public constructor(
    private readonly atomic: IAtomicStore,
  ) {}

  /** Register an executor so the scheduler can resolve it by key. */
  public registerExecutor(executor: ITaskExecutor): void {
    this.executorRegistry.set(executor.key, executor);
  }

  // ─── DagDef ───

  public async getDagDef(dagId: DagId): Promise<{ value: DagDef; version: VersionId } | null> {
    const entry = await this.atomic.get<DagDef>(PFX_DAG_DEF + dagId);
    return entry ?? null;
  }

  public async saveDagDef(dag: DagDef): Promise<boolean> {
    const existing = await this.atomic.get<DagDef>(PFX_DAG_DEF + dag.id);
    const ok = await this.atomic.set(PFX_DAG_DEF + dag.id, dag, existing?.version ?? null);
    if (ok && !existing) {
      for (let attempt = 0; attempt < 3; attempt++) {
        const idx = await this.atomic.get<string[]>(IDX_DAG_DEFS);
        const list = [...(idx?.value ?? []), dag.id];
        const ok2 = await this.atomic.set(IDX_DAG_DEFS, list, idx?.version ?? null);
        if (ok2) break;
      }
    }
    return ok !== null;
  }

  // ─── DagRun ───

  public async getActiveDagRuns(): Promise<DagRun[]> {
    // Scan for active runs (QUEUED or RUNNING). In production, use an index.
    // For now, we use a simple prefix scan via the known keys pattern.
    // Since IAtomicStore doesn't support scan, we rely on an index key.
    const idx = await this.atomic.get<string[]>(PFX_DAG_RUN + 'idx');
    if (!idx) return [];

    const runs: DagRun[] = [];
    for (const id of idx.value) {
      const entry = await this.atomic.get<DagRun>(PFX_DAG_RUN + id);
      if (entry && (entry.value.status === 'QUEUED' || entry.value.status === 'RUNNING')) {
        runs.push(entry.value);
      }
    }
    return runs;
  }

  public async getDagRun(dagRunId: DagRunId): Promise<{ value: DagRun; version: VersionId } | null> {
    const entry = await this.atomic.get<DagRun>(PFX_DAG_RUN + dagRunId);
    return entry ?? null;
  }

  public async updateDagRun(dagRun: DagRun, version: VersionId): Promise<boolean> {
    const ok = await this.atomic.set(PFX_DAG_RUN + dagRun.id, dagRun, version);
    return ok !== null;
  }

  public async saveNewDagRun(dagRun: DagRun): Promise<boolean> {
    const ok = await this.atomic.set(PFX_DAG_RUN + dagRun.id, dagRun, null);
    if (ok) {
      for (let attempt = 0; attempt < 3; attempt++) {
        const idx = await this.atomic.get<string[]>(PFX_DAG_RUN + 'idx');
        const list = [...(idx?.value ?? []), dagRun.id];
        const ok2 = await this.atomic.set(PFX_DAG_RUN + 'idx', list, idx?.version ?? null);
        if (ok2) break;
      }
    }
    return ok !== null;
  }

  // ─── TaskInstance ───

  public async getTaskInstances(dagRunId: DagRunId): Promise<TaskInstance[]> {
    const idx = await this.atomic.get<string[]>(PFX_TASK_INST + dagRunId);
    if (!idx) return [];

    const tis: TaskInstance[] = [];
    for (const id of idx.value) {
      const entry = await this.atomic.get<TaskInstance>(PFX_TASK_INST + id);
      if (entry) tis.push(entry.value);
    }
    return tis;
  }

  public async saveTaskInstance(ti: TaskInstance, version?: VersionId | null): Promise<boolean> {
    const key = PFX_TASK_INST + ti.id;
    const ok = await this.atomic.set(key, ti, version ?? null);

    // Maintain per-dagRun index
    const idxKey = PFX_TASK_INST + ti.dagRunId;
    for (let attempt = 0; attempt < 3; attempt++) {
      const idx = await this.atomic.get<string[]>(idxKey);
      const list = idx?.value ?? [];
      if (list.includes(ti.id)) break;
      const ok2 = await this.atomic.set(idxKey, [...list, ti.id], idx?.version ?? null);
      if (ok2) break;
    }
    return ok !== null;
  }

  // ─── Pool ───

  public async getPool(name: string): Promise<Pool | null> {
    const entry = await this.atomic.get<Pool>(PFX_POOL + name);
    return entry?.value ?? null;
  }

  public async updatePool(pool: Pool): Promise<boolean> {
    const ok = await this.atomic.set(PFX_POOL + pool.name, pool, null);
    if (ok) {
      for (let attempt = 0; attempt < 3; attempt++) {
        const idx = await this.atomic.get<string[]>(IDX_POOLS);
        const list = idx?.value ?? [];
        if (list.includes(pool.name)) break;
        const ok2 = await this.atomic.set(IDX_POOLS, [...list, pool.name], idx?.version ?? null);
        if (ok2) break;
      }
    }
    return ok !== null;
  }

  // ─── DAG API helpers ───

  public async getAllDagDefs(): Promise<DagDef[]> {
    const idx = await this.atomic.get<string[]>(IDX_DAG_DEFS);
    if (!idx) return [];
    const entries = await Promise.all(idx.value.map(id => this.atomic.get<DagDef>(PFX_DAG_DEF + id)));
    const result: DagDef[] = [];
    for (const e of entries) { if (e) result.push(e.value); }
    return result;
  }

  public async deleteDagDef(dagId: DagId, version: VersionId): Promise<boolean> {
    const ok = await this.atomic.set(PFX_DAG_DEF + dagId, null, version);
    if (ok) {
      for (let attempt = 0; attempt < 3; attempt++) {
        const idx = await this.atomic.get<string[]>(IDX_DAG_DEFS);
        if (!idx) break;
        const list = idx.value.filter(id => id !== dagId);
        const ok2 = await this.atomic.set(IDX_DAG_DEFS, list, idx.version);
        if (ok2) break;
      }
    }
    return ok !== null;
  }

  public async getDagRunsForDag(dagId: DagId): Promise<DagRun[]> {
    const idx = await this.atomic.get<string[]>(PFX_DAG_RUN + 'idx');
    if (!idx) return [];
    const entries = await Promise.all(idx.value.map(id => this.atomic.get<DagRun>(PFX_DAG_RUN + id)));
    const dagRuns: DagRun[] = [];
    for (const e of entries) { if (e) dagRuns.push(e.value); }
    return dagRuns.filter(r => r.dagId === dagId);
  }

  public async getApprovalStatus(_dagRunId: DagRunId, taskName: string): Promise<'pending' | 'approved' | 'rejected' | null> {
    const idx = await this.atomic.get<string[]>('action-approval:ids');
    if (!idx) return null;
    const entries = await Promise.all(idx.value.map(k => this.atomic.get<{ status: string; jobName: string; requestedAt: number }>('action-approval:' + k)));
    let latest: { status: string; requestedAt: number } | null = null;
    for (const e of entries) {
      if (e && e.value.jobName === taskName && (!latest || e.value.requestedAt > latest.requestedAt)) {
        latest = e.value;
      }
    }
    if (!latest) return null;
    const s = latest.status;
    if (s === 'approved' || s === 'rejected' || s === 'pending') return s;
    return null;
  }

  public async getAllPools(): Promise<Pool[]> {
    const idx = await this.atomic.get<string[]>(IDX_POOLS);
    if (!idx) return [];
    const entries = await Promise.all(idx.value.map(name => this.atomic.get<Pool>(PFX_POOL + name)));
    const pools: Pool[] = [];
    for (const e of entries) { if (e) pools.push(e.value); }
    return pools;
  }

  // ─── ContainerGroup ───

  public async saveCG(cg: ContainerGroup, version?: VersionId | null): Promise<boolean> {
    const ok = await this.atomic.set(PFX_CG + cg.id, cg, version ?? null);
    if (ok) {
      for (let attempt = 0; attempt < 3; attempt++) {
        const idx = await this.atomic.get<string[]>(IDX_CGS);
        const list = idx?.value ?? [];
        if (list.includes(cg.id)) break;
        const ok2 = await this.atomic.set(IDX_CGS, [...list, cg.id], idx?.version ?? null);
        if (ok2) break;
      }
    }
    return ok !== null;
  }

  public async getCG(id: string): Promise<{ value: ContainerGroup; version: VersionId } | null> {
    return this.atomic.get<ContainerGroup>(PFX_CG + id);
  }

  public async updateCG(cg: ContainerGroup, version: VersionId): Promise<boolean> {
    const ok = await this.atomic.set(PFX_CG + cg.id, cg, version);
    return ok !== null;
  }

  public async getAllCGs(): Promise<ContainerGroup[]> {
    const idx = await this.atomic.get<string[]>(IDX_CGS);
    if (!idx) return [];
    const entries = await Promise.all(idx.value.map(id => this.atomic.get<ContainerGroup>(PFX_CG + id)));
    const result: ContainerGroup[] = [];
    for (const e of entries) { if (e) result.push(e.value); }
    return result;
  }

  // ─── Executor ───

  // eslint-disable-next-line @typescript-eslint/require-await -- interface contract requires Promise<T>
  public async getExecutor(key: string): Promise<ITaskExecutor | null> {
    return this.executorRegistry.get(key) ?? null;
  }
}
