import type { IAtomicStore } from '../../core/store/interfaces.ts';
import type { WorkflowRun, JobRun } from './types.ts';
import { IDX_WORKFLOW_RUN_IDS, PFX_WORKFLOW_RUN } from './types.ts';

export interface DashboardMetrics {
  totalWorkflows: number;
  totalRuns: number;
  activeRuns: number;
  successRate: number;
  avgDurationMs: number;
  runnersOnline: number;
  byTrigger: Record<string, number>;
  byStatus: Record<string, number>;
  /** 个人维度的聚类数据（仅当传入 userId 时填充）. */
  myRuns?: number;
  mySuccessRate?: number;
  myRecentRuns?: { id: string; status: string; trigger: string; startedAt: number }[];
}

export interface BillingEntry {
  runId: string;
  jobRunId: string;
  projectId?: string;
  orgId?: string;
  cpuSeconds: number;
  memoryMbSeconds: number;
  durationMs: number;
  cost: number;
  billedAt: number;
}

const BILL_PFX = 'action-billing:';
const CPU_COST_PER_SEC = 0.0001;
const MEM_COST_PER_MB_SEC = 0.000001;

export class DashboardService {
  public constructor(private readonly atomic: IAtomicStore) {}

  public async getMetrics(userId?: string): Promise<DashboardMetrics> {
    const idx = await this.atomic.get<string[]>(IDX_WORKFLOW_RUN_IDS);
    const empty = { totalWorkflows: 0, totalRuns: 0, activeRuns: 0, successRate: 0, avgDurationMs: 0, runnersOnline: 0, byTrigger: {}, byStatus: {} };
    if (!idx) return empty;

    const entries = (await Promise.all(
      idx.value.slice(-500).map(i => this.atomic.get<WorkflowRun>(PFX_WORKFLOW_RUN + i)),
    )).filter(e => e).map(e => e!.value);

    const totalRuns = entries.length;
    const activeRuns = entries.filter(r => r.status === 'Pending' || r.status === 'Running').length;
    const completed = entries.filter(r => r.completedAt);
    const successCount = completed.filter(r => r.status === 'Success').length;
    const successRate = completed.length > 0 ? successCount / completed.length : 0;
    const avgDurationMs = completed.length > 0
      ? completed.reduce((s, r) => s + (r.completedAt! - r.startedAt), 0) / completed.length
      : 0;

    const byTrigger: Record<string, number> = {};
    const byStatus: Record<string, number> = {};
    for (const r of entries) {
      byTrigger[r.trigger] = (byTrigger[r.trigger] ?? 0) + 1;
      byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
    }

    const runnerIdx = await this.atomic.get<string[]>('action-runner:ids');
    let runnersOnline = 0;
    if (runnerIdx) {
      const rs = (await Promise.all(runnerIdx.value.map(i => this.atomic.get<any>('action-runner:' + i))))
        .filter(e => e?.value.status === 'online');
      runnersOnline = rs.length;
    }

    const result: DashboardMetrics = { totalWorkflows: 0, totalRuns, activeRuns, successRate, avgDurationMs, runnersOnline, byTrigger, byStatus };

    // Personal clustering
    if (userId) {
      const mine = entries.filter(r => r.ownerId === userId);
      const myCompleted = mine.filter(r => r.completedAt);
      result.myRuns = mine.length;
      result.mySuccessRate = myCompleted.length > 0
        ? myCompleted.filter(r => r.status === 'Success').length / myCompleted.length
        : 0;
      result.myRecentRuns = mine.slice(0, 10).map(r => ({
        id: r.id, status: r.status, trigger: r.trigger, startedAt: r.startedAt,
      }));
    }

    return result;
  }

  public async recordJobBilling(jobRun: JobRun, jobDef?: { cpu?: number; memory?: number }): Promise<void> {
    if (!jobRun.startedAt || !jobRun.completedAt) return;

    const durationMs = jobRun.completedAt - jobRun.startedAt;
    const cpuCores = jobDef?.cpu ?? 1;
    const memoryMb = jobDef?.memory ?? 1024;
    const cpuSec = cpuCores * durationMs / 1000;
    const memSec = memoryMb * durationMs / 1000;
    const cost = cpuSec * CPU_COST_PER_SEC + memSec * MEM_COST_PER_MB_SEC;

    const entry = await this.atomic.get<WorkflowRun>(PFX_WORKFLOW_RUN + jobRun.workflowRunId);
    const billing: BillingEntry = {
      runId: jobRun.workflowRunId,
      jobRunId: jobRun.id,
      projectId: (entry?.value as any)?.projectId,
      orgId: (entry?.value as any)?.orgId,
      cpuSeconds: cpuSec,
      memoryMbSeconds: memSec,
      durationMs,
      cost,
      billedAt: Date.now(),
    };

    await this.atomic.set(`${BILL_PFX}${jobRun.id}`, billing, null);
  }

  public async getBilling(projectId?: string, orgId?: string): Promise<BillingEntry[]> {
    const idx = await this.atomic.get<string[]>('action:job-run:ids');
    if (!idx) return [];
    const entries = (await Promise.all(
      idx.value.map(i => this.atomic.get<BillingEntry>(BILL_PFX + i)),
    )).filter(e => e).map(e => e!.value);
    if (projectId) return entries.filter(b => b.projectId === projectId);
    if (orgId) return entries.filter(b => b.orgId === orgId);
    return entries;
  }
}
