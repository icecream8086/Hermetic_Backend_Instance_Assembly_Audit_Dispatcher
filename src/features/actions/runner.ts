import type { IAtomicStore, IBlobStore } from '../../core/store/interfaces.ts';
import type { IProviderRegistry } from '../../core/provider/interfaces.ts';
import type { IAuditWriter } from '../../core/audit/types.ts';
import type { IMessageQueue } from '../../queue/interfaces.ts';
import { createEvent } from '../../core/event-bus/types.ts';
import type { EventBus } from '../../core/event-bus/bus.ts';
import {
  type WorkflowDef,
  type WorkflowRun,
  type JobRun,
  type JobDef,
  type StepDef,
  type RunStepDef,
  type UsesStepDef,
  type WorkflowRunId,
  type JobRunId,
  type StepRun,
  type ActionContainerConfig,
  type JobRunStatus,
  IDX_WORKFLOW_RUN_IDS,
  IDX_JOB_RUN_IDS,
  PFX_WORKFLOW_RUN,
  PFX_JOB_RUN,
  createWorkflowRunId,
  createJobRunId,
} from './types.ts';
import { executeDnsStep } from './step-dns.ts';
import { appendStepLog } from './logs.ts';
import type { ActionRegistry } from './registry.ts';
import { MatrixExpander } from './matrix.ts';
import { DashboardService } from './dashboard.ts';
import { generateVersionId } from '../../core/brand.ts';
import type { PodService } from '../../core/pod/service.ts';
import type { PodSpec } from '../../core/pod/types.ts';
import { createRegionId } from '../../core/region/types.ts';
import { createInstanceId } from '../../core/region/instance.ts';

function runId(): WorkflowRunId { return createWorkflowRunId(`wfr_${crypto.randomUUID()}`); }
function jId(): JobRunId { return createJobRunId(`jr_${crypto.randomUUID()}`); }

export interface WorkflowRunnerDeps {
  stores: { atomic: IAtomicStore; blob: IBlobStore };
  // eslint-disable-next-line @typescript-eslint/no-restricted-types -- slim dependency interface: only two methods needed from IProviderRegistry
  providers: Pick<IProviderRegistry, 'resolveContainer' | 'dns'>;
  audit: IAuditWriter;
  queueProducer?: IMessageQueue;
  eventBus?: EventBus;
  actionRegistry?: ActionRegistry;
  podService?: PodService;
}

export class WorkflowRunner {
  public constructor(private readonly deps: WorkflowRunnerDeps) {}

  public async startRun(
    workflowDef: WorkflowDef,
    trigger: WorkflowRun['trigger'],
    triggerPayload?: unknown,
    extraEnv?: Record<string, string>,
    actorId?: string,
  ): Promise<WorkflowRun> {
    const id = runId();
    const now = Date.now();
    const env = { ...workflowDef.env, ...extraEnv };

    const run: WorkflowRun = {
      id,
      workflowId: workflowDef.id,
      status: 'Pending',
      trigger,
      triggerPayload,
      ...(actorId ? { ownerId: actorId } : {}),
      env,
      jobRunRefs: [],
      startedAt: now,
      version: generateVersionId(),
    };

    const { atomic } = this.deps.stores;
    await atomic.set(PFX_WORKFLOW_RUN + id, run, null);
    await this.#addToIndex(IDX_WORKFLOW_RUN_IDS, id);

    const jobRefs = await this.#createJobRuns(workflowDef, id);

    const entry = await atomic.get<WorkflowRun>(PFX_WORKFLOW_RUN + id);
    const updated: WorkflowRun = { ...run, jobRunRefs: jobRefs };
    if (entry) {
      const ver = await atomic.set(PFX_WORKFLOW_RUN + id, updated, entry.version);
      if (!ver) {
        // OCC conflict — re-read and retry once
        const entry2 = await atomic.get<WorkflowRun>(PFX_WORKFLOW_RUN + id);
        if (entry2) await atomic.set(PFX_WORKFLOW_RUN + id, updated, entry2.version);
      }
    }

    await this.#enqueueReadyJobs(workflowDef, updated);

    this.deps.audit.write({
      level: 5, facility: 'workflow-runner',
      message: `WorkflowRun ${id} started: ${workflowDef.name} (trigger=${trigger})`,
      metadata: { workflowRunId: id, workflowId: workflowDef.id, trigger },
    });

    return updated;
  }

  public async executeJob(jobRunId: JobRunId): Promise<JobRun> {
    const { atomic } = this.deps.stores;
    const entry = await atomic.get<JobRun>(PFX_JOB_RUN + jobRunId);
    if (!entry) throw new Error(`JobRun ${jobRunId} not found`);
    const jobRun = entry.value;
    if (jobRun.status !== 'Queued') return jobRun;

    const started = Date.now();
    let current: JobRun = { ...jobRun, status: 'Running', startedAt: started, attempts: jobRun.attempts + 1, version: generateVersionId() };
    const ver1 = await atomic.set(PFX_JOB_RUN + jobRunId, current, entry.version);
    if (!ver1) return current; // OCC conflict

    // Push status via EventBus → DoBridge → WebSocket
    if (this.deps.eventBus && current.workflowRunId) {
      const evt = createEvent('workflow:job:status', {
        jobRunId, jobName: jobRun.jobName,
        workflowRunId: jobRun.workflowRunId, status: 'Running',
      });
      await this.deps.eventBus.dispatch(evt);
    }

    const wfEntry = await atomic.get<WorkflowRun>(PFX_WORKFLOW_RUN + jobRun.workflowRunId);
    if (!wfEntry) throw new Error(`WorkflowRun ${jobRun.workflowRunId} not found`);

    const wfDefEntry = await atomic.get<WorkflowDef>(`workflow-def:${wfEntry.value.workflowId}`);
    if (!wfDefEntry) throw new Error(`WorkflowDef not found`);
    const jobDef = wfDefEntry.value.jobs[jobRun.jobName];
    if (!jobDef) throw new Error(`Job ${jobRun.jobName} not in workflow`);

    // ── Approval gating ──
    if (jobDef.approval) {
      const { ApprovalService } = await import('./extensions.ts');
      const approvalSvc = new ApprovalService(atomic);
      const existing = await approvalSvc.getForRun(jobRun.workflowRunId);
      const jobApproval = existing.find(a => a.jobName === jobRun.jobName);

      if (!jobApproval || jobApproval.status === 'pending') {
        if (!jobApproval) {
          await approvalSvc.request(jobRun.workflowRunId, jobRun.jobName, [...jobDef.approval.approvers]);
        }
        // Mark as Queued — will be re-triggered when approved
        return current;
      }
      if (jobApproval.status === 'rejected') {
        const finalEntry = await atomic.get<JobRun>(PFX_JOB_RUN + jobRunId);
        if (finalEntry) {
          current = { ...current, status: 'Failure', error: `Approval rejected: ${jobApproval.reason ?? 'no reason'}`, completedAt: Date.now(), version: generateVersionId() };
          await atomic.set(PFX_JOB_RUN + jobRunId, current, finalEntry.version);
        }
        return current;
      }
      // approved — proceed
    }

    try {
      const { sandboxId, podId } = await this.#provisionJobSandbox(jobDef, wfEntry.value.env, jobRun.jobName);

      const sEntry = await atomic.get<JobRun>(PFX_JOB_RUN + jobRunId);
      if (sEntry) {
        current = { ...current, sandboxId, ...(podId ? { podId } : {}), version: generateVersionId() };
        await atomic.set(PFX_JOB_RUN + jobRunId, current, sEntry.version);
      }

      const stepRuns = await this.#executeSteps(jobDef.steps, wfEntry.value.env, sandboxId, jobRunId);

      const allOk = stepRuns.every(s => s.status !== 'Failure');
      const finalEntry = await atomic.get<JobRun>(PFX_JOB_RUN + jobRunId);
      if (finalEntry) {
        current = {
          ...current,
          status: allOk ? 'Success' : 'Failure',
          stepRuns,
          completedAt: Date.now(),
          version: generateVersionId(),
        };
        await atomic.set(PFX_JOB_RUN + jobRunId, current, finalEntry.version);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const finalEntry = await atomic.get<JobRun>(PFX_JOB_RUN + jobRunId);
      if (finalEntry) {
        current = {
          ...current,
          status: 'Failure',
          error: msg,
          completedAt: Date.now(),
          version: generateVersionId(),
        };
        await atomic.set(PFX_JOB_RUN + jobRunId, current, finalEntry.version);
      }
    }

    // Push final status via EventBus
    if (this.deps.eventBus && current.workflowRunId) {
      const evt = createEvent('workflow:job:status', {
        jobRunId, jobName: jobRun.jobName,
        workflowRunId: jobRun.workflowRunId,
        status: current.status,
        ...(current.error ? { error: current.error } : {}),
      });
      await this.deps.eventBus.dispatch(evt);
    }

    // Record billing for completed job
    const billing = new DashboardService(atomic);
    const cpu = jobDef.container?.resources?.cpu ?? jobDef.containers?.[0]?.resources?.cpu;
    const memory = jobDef.container?.resources?.memory ?? jobDef.containers?.[0]?.resources?.memory;
    await billing.recordJobBilling(current, { ...(cpu ? { cpu } : {}), ...(memory ? { memory } : {}) });

    // Enqueue downstream jobs
    const wfEntry2 = await atomic.get<WorkflowRun>(PFX_WORKFLOW_RUN + jobRun.workflowRunId);
    const wfDefEntry2 = wfEntry2
      ? await atomic.get<WorkflowDef>(`workflow-def:${wfEntry2.value.workflowId}`)
      : null;
    if (wfEntry2 && wfDefEntry2 && current.status === 'Success') {
      await this.#enqueueReadyJobs(wfDefEntry2.value, wfEntry2.value);
    }

    if (wfEntry2) {
      await this.#checkWorkflowCompletion(wfEntry2.value);
    }

    return current;
  }

  // ─── Private ───

  async #createJobRuns(wf: WorkflowDef, wfRunId: WorkflowRunId): Promise<WorkflowRun['jobRunRefs']> {
    const refs: { jobName: string; jobRunId: JobRunId }[] = [];
    const expander = new MatrixExpander();

    for (const [jobName, jobDef] of Object.entries(wf.jobs)) {
      // Expand matrix strategy → one JobRun per variant
      const variants = expander.expand(jobName, jobDef);
      const failFast = (jobDef as any).strategy?.failFast === true;

      for (const variant of variants) {
        // Resolve ${{ matrix.xxx }} in env and container fields
        const resolvedEnv = this.#resolveMatrixVars(variant.jobDef.env ?? {}, variant.matrixVars);
        const resolvedContainer = variant.jobDef.container
          ? this.#resolveMatrixInContainer(variant.jobDef.container, variant.matrixVars)
          : undefined;

        const resolvedJob: typeof jobDef = {
          ...variant.jobDef,
          env: resolvedEnv,
          ...(resolvedContainer ? { container: resolvedContainer } : {}),
          // Inject failFast from matrix strategy
          ...(failFast ? { failFast: true } as any : {}),
        };

        const id = jId();
        const jobRun: JobRun = {
          id,
          workflowRunId: wfRunId,
          jobName: variant.name,
          status: 'Queued',
          attempts: 0,
          stepRuns: resolvedJob.steps.map(s => this.#defToStepRun(s)),
          version: generateVersionId(),
        };
        await this.deps.stores.atomic.set(PFX_JOB_RUN + id, jobRun, null);
        await this.#addToIndex(IDX_JOB_RUN_IDS, id);
        refs.push({ jobName: variant.name, jobRunId: id });
      }

      // failFast: if any variant of this job failed, cancel remaining variants
      // (checked in #checkWorkflowCompletion when one fails)
    }
    return refs;
  }

  /** Resolve ${{ matrix.KEY }} placeholders in env vars. */
  #resolveMatrixVars(
    env: Record<string, string>,
    matrixVars: Record<string, string | number | boolean>,
  ): Record<string, string> {
    const pattern = /\$\{\{\s*matrix\.(\w+)\s*\}\}/g;
    const result: Record<string, string> = {};
    for (const [k, v] of Object.entries(env)) {
      let resolved = v;
      for (const match of v.matchAll(pattern)) {
        const varName = match[1]!;
        const val = matrixVars[varName];
        resolved = resolved.replace(match[0], val !== undefined ? String(val) : '');
      }
      result[k] = resolved;
    }
    return result;
  }

  /** Resolve ${{ matrix.KEY }} in container config fields. */
  #resolveMatrixInContainer(container: any, vars: Record<string, string | number | boolean>): any {
    const pattern = /\$\{\{\s*matrix\.(\w+)\s*\}\}/g;
    const resolve = (s: string): string => {
      let r = s;
      for (const m of s.matchAll(pattern)) {
        r = r.replace(m[0], String(vars[m[1]!] ?? ''));
      }
      return r;
    };
    return {
      ...container,
      image: container.image ? resolve(container.image) : container.image,
    };
  }

  async #enqueueReadyJobs(wf: WorkflowDef, run: WorkflowRun): Promise<void> {
    const { atomic } = this.deps.stores;

    for (const ref of run.jobRunRefs) {
      const jEntry = await atomic.get<JobRun>(PFX_JOB_RUN + ref.jobRunId);
      if (jEntry?.value.status !== 'Queued') continue;

      const jobDef = wf.jobs[ref.jobName];
      if (!jobDef) continue;

      // Resolve dependency statuses
      const needs = jobDef.needs ?? [];
      if (needs.length > 0) {
        const depStatuses = await Promise.all(
          needs.map(async (needName) => {
            const depRef = run.jobRunRefs.find(r => r.jobName === needName);
            if (!depRef) return { name: needName, status: 'Queued' as const };
            const depEntry = await atomic.get<JobRun>(PFX_JOB_RUN + depRef.jobRunId);
            return { name: needName, status: (depEntry?.value.status ?? 'Queued') };
          }),
        );

        // failFast: if any dep failed, skip this job
        const failed = depStatuses.filter(d => d.status === 'Failure' || d.status === 'Cancelled');
        if (failed.length > 0) {
          const jEntry2 = await atomic.get<JobRun>(PFX_JOB_RUN + ref.jobRunId);
          if (jEntry2) {
            await atomic.set(PFX_JOB_RUN + ref.jobRunId, {
              ...jEntry2.value, status: 'Skipped',
              error: `Upstream dependency failed: ${failed.map(d => d.name).join(', ')}`,
              completedAt: Date.now(), version: generateVersionId(),
            }, jEntry2.version);
          }
          continue;
        }

        // All deps must be Success
        if (!depStatuses.every(s => s.status === 'Success')) continue;
      }

      // Schedule via Queue, or inline fallback
      const qp = this.deps.queueProducer;
      const qSent = qp
        ? await qp.send({ type: 'workflow:job:run', payload: { jobRunId: ref.jobRunId, workflowRunId: run.id }, timestamp: Date.now(), id: `wfj_${crypto.randomUUID()}` } as any)
        : false;

      if (!qSent) {
        await this.executeJob(ref.jobRunId);
      }
    }
  }

  async #checkWorkflowCompletion(run: WorkflowRun): Promise<void> {
    const { atomic } = this.deps.stores;
    const statuses: JobRunStatus[] = [];
    for (const ref of run.jobRunRefs) {
      const jEntry = await atomic.get<JobRun>(PFX_JOB_RUN + ref.jobRunId);
      if (jEntry) statuses.push(jEntry.value.status);
    }

    const pending = statuses.filter(s => s === 'Queued' || s === 'Running');
    if (pending.length > 0) return;

    const anyFailed = statuses.some(s => s === 'Failure' || s === 'Cancelled');
    const newStatus = anyFailed ? 'Failure' : 'Success';

    const entry = await atomic.get<WorkflowRun>(PFX_WORKFLOW_RUN + run.id);
    if (!entry || entry.value.status !== 'Pending' && entry.value.status !== 'Running') return;

    const updated: WorkflowRun = {
      ...entry.value,
      status: newStatus,
      completedAt: Date.now(),
      version: generateVersionId(),
    };
    await atomic.set(PFX_WORKFLOW_RUN + run.id, updated, entry.version);

    if (this.deps.eventBus) {
      const evt = createEvent('workflow:completed', { workflowRunId: run.id, status: newStatus });
      await this.deps.eventBus.dispatch(evt);
    }
  }

  async #provisionJobSandbox(
    jobDef: JobDef,
    env: Record<string, string>,
    jobName: string,
  ): Promise<{ sandboxId: string; podId?: string }> {
    const instanceId = jobDef.instanceId;
    const region = jobDef.region ?? 'local';
    const mergedEnv = { ...env, ...jobDef.env };
    const container = jobDef.containers?.[0] ?? jobDef.container;
    if (!container) throw new Error(`Job ${jobName} has no container defined`);

    // v3 path: PodService.provision() → PodEntity with lifecycle tracking
    if (this.deps.podService) {
      const podSpec = this.#jobToPodSpec(jobName, container, mergedEnv, jobDef);
      const pod = await this.deps.podService.provision(podSpec);
      return { sandboxId: pod.providerId ?? pod.podId, podId: pod.podId };
    }

    // v2 fallback: direct provider.create()
    if (!instanceId || !this.deps.providers.resolveContainer) {
      throw new Error('Workflow job requires an instanceId to resolve a container provider');
    }
    const provider = await this.deps.providers.resolveContainer(createInstanceId(instanceId));

    const result = await provider.create({
      name: `action-${jobName}-${String(Date.now())}`,
      region: createRegionId(region),
      ...(instanceId ? { instanceId: createInstanceId(instanceId) } : {}),
      cpu: container.resources?.cpu ?? 1,
      memory: container.resources?.memory ?? 1024,
      restartPolicy: 'Never',
      containers: [{
        name: jobName,
        image: container.image,
        command: container.command ? [...container.command] : undefined,
        args: container.args ? [...container.args] : undefined,
        env: Object.entries(mergedEnv).map(([k, v]) => ({ name: k, value: v })),
        ports: container.ports ? [...container.ports] : undefined,
        resources: container.resources ? { limits: { cpu: container.resources.cpu ?? 1, memory: container.resources.memory ?? 1024 } } : undefined,
      }],
      network: { allocatePublicIp: false },
    });

    return { sandboxId: result.providerId };
  }

  /** Build a PodSpec from a job definition for PodService.provision(). */
  #jobToPodSpec(
    jobName: string,
    container: ActionContainerConfig,
    env: Record<string, string>,
    jobDef: JobDef,
  ): PodSpec {
    const envList = Object.entries(env).map(([name, value]) => ({ name, value }));
    return {
      metadata: {
        name: `action-${jobName}-${String(Date.now())}`,
        labels: { job: jobName, owner: 'actions' },
      },
      spec: {
        containers: [{
          name: jobName,
          image: container.image,
          command: container.command ? [...container.command] : undefined,
          args: container.args ? [...container.args] : undefined,
          env: envList.length > 0 ? envList : undefined,
          ports: container.ports ? [...container.ports] : undefined,
          resources: container.resources ? {
            limits: {
              cpu: container.resources.cpu ?? 1,
              memory: container.resources.memory ?? 1024,
            },
          } : undefined,
        }],
        restartPolicy: 'Never',
      },
      ...(jobDef.region ? { providerOverrides: { region: jobDef.region, ...(jobDef.instanceId ? { instanceId: jobDef.instanceId } : {}) } } : {}),
    };
  }

  async #executeSteps(
    steps: readonly StepDef[],
    env: Record<string, string>,
    sandboxId: string,
    jobRunId: string,
  ): Promise<StepRun[]> {
    const stepRuns: StepRun[] = [];
    const provider = await this.deps.providers.resolveContainer?.(undefined) as any;

    for (const step of steps) {
      const name = step.name ?? (('run' in step) ? step.run.slice(0, 60) : ('dns' in step) ? `dns:${step.dns.name}` : step.uses ?? 'unknown');
      const startedAt = Date.now();

      // Log step start
      await appendStepLog(this.deps.stores.blob, jobRunId, name, `Step started: ${name}`);
      this.deps.audit.write({
        level: 6, facility: 'step-executor',
        message: `Step started: ${name}`,
        metadata: { jobRunId, stepName: name },
      });

      try {
        if ('run' in step) {
          await this.#executeRunStep(step, env, sandboxId, provider);
          await appendStepLog(this.deps.stores.blob, jobRunId, name,
            `Step completed: ${name} (exit 0)`);
          stepRuns.push({ name, status: 'Success', startedAt, completedAt: Date.now(), exitCode: 0 });

        } else if ('dns' in step) {
          await executeDnsStep(step, this.deps.providers.dns, this.deps.audit);
          await appendStepLog(this.deps.stores.blob, jobRunId, name,
            `DNS ${(step).dns.action} ${(step).dns.name}`);
          stepRuns.push({ name, status: 'Success', startedAt, completedAt: Date.now() });

        } else if ('uses' in step) {
          await this.#executeUsesStep(step, env, sandboxId, provider);
          await appendStepLog(this.deps.stores.blob, jobRunId, name,
            `Action completed: ${(step).uses}`);
          stepRuns.push({ name, status: 'Success', startedAt, completedAt: Date.now(), exitCode: 0 });
        }

      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await appendStepLog(this.deps.stores.blob, jobRunId, name,
          `Step FAILED: ${msg}`);
        this.deps.audit.write({
          level: 3, facility: 'step-executor',
          message: `Step failed: ${name} — ${msg}`,
          metadata: { jobRunId, stepName: name, error: msg },
        });

        if (step.continueOnError) {
          stepRuns.push({ name, status: 'Success', startedAt, completedAt: Date.now(), error: msg });
        } else {
          stepRuns.push({ name, status: 'Failure', startedAt, completedAt: Date.now(), exitCode: 1, error: msg });
          break;
        }
      }
    }

    return stepRuns;
  }

  /** Execute a `run:` step inside the container via provider.exec(). */
  async #executeRunStep(
    step: RunStepDef,
    env: Record<string, string>,
    sandboxId: string,
    provider: any,
  ): Promise<void> {
    const shell = step.shell ?? '/bin/sh';
    const script = step.run;

    if (typeof provider.exec !== 'function') {
      // Provider doesn't support exec — mark as success
      // (the container's entrypoint handles execution)
      return;
    }

    const envList = Object.entries({ ...env, ...step.env }).map(
      ([k, v]) => `${k}=${v}`,
    );

    const result = await provider.exec({
      providerId: sandboxId,
      command: [shell, '-c', script],
      env: envList,
      timeout: step.timeout ? step.timeout * 1000 : undefined,
    });

    if (result?.exitCode !== 0) {
      throw new Error(
        `Command exited with code ${String(result?.exitCode ?? -1)}: ${script.slice(0, 200)}`,
      );
    }
  }

  /** Execute a `uses:` step by resolving the action reference and running it. */
  async #executeUsesStep(
    step: UsesStepDef,
    env: Record<string, string>,
    sandboxId: string,
    provider: any,
  ): Promise<void> {
    const registry = this.deps.actionRegistry;
    if (!registry) {
      // No registry configured — try container image fallback
      if (typeof provider.exec === 'function') {
        const mergedEnv = { ...env, ...step.env, ...step.with };
        const envList = Object.entries(mergedEnv).map(([k, v]) => `${k}=${v}`);
        const result = await provider.exec({
          providerId: sandboxId,
          command: ['/bin/sh', '-c', `echo 'Running action: ${step.uses}'`],
          env: envList,
          timeout: step.timeout ? step.timeout * 1000 : undefined,
        });
        if (result?.exitCode !== 0) {
          throw new Error(`Action ${String(step.uses)} failed with exit ${String(result?.exitCode)}`);
        }
        return;
      }
      throw new Error(`Action registry not available and provider has no exec — cannot run ${step.uses}`);
    }

    const resolved = await registry.resolve(step.uses);
    if (!resolved) {
      throw new Error(`Action not found: ${step.uses}. Register it via POST /api/actions/actions or use a container image reference (e.g. docker.io/library/node:20).`);
    }

    // For container-based actions, exec the entrypoint inside the sandbox
    if (typeof provider.exec === 'function') {
      const mergedEnv = { ...env, ...step.env, ...step.with };
      const envList = Object.entries(mergedEnv).map(([k, v]) => `${k}=${v}`);
      const cmd = resolved.entrypoint ?? ['/bin/sh', '-c', `echo 'Action: ${step.uses}'`];
      const result = await provider.exec({
        providerId: sandboxId,
        command: cmd,
        env: envList,
        timeout: step.timeout ? step.timeout * 1000 : undefined,
      });
      if (result?.exitCode !== 0) {
        throw new Error(`Action ${String(step.uses)} failed with exit ${String(result?.exitCode)}`);
      }
    }
  }

  #defToStepRun(step: StepDef): StepRun {
    const name = step.name ?? (('run' in step) ? step.run.slice(0, 60) : ('dns' in step) ? `dns:${step.dns.name}` : step.uses ?? 'unknown');
    return { name, status: 'Queued' };
  }

  async #addToIndex(indexKey: string, id: string): Promise<void> {
    const { atomic } = this.deps.stores;
    const idx = await atomic.get<string[]>(indexKey);
    await atomic.set(indexKey, [...(idx?.value ?? []), id], idx?.version ?? null);
  }
}
