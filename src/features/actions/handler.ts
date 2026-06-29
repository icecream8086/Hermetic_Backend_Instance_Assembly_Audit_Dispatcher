import { Hono } from 'hono';
import type { FeatureDeps, AppContext } from '../../core/deps.ts';
import { AppError } from '../../core/types.ts';
import { ok } from '../../core/response.ts';
import { register as registerScheduler } from '../../core/scheduler/registry.ts';

import type { RouteMeta } from '../../core/http-docs/types.ts';
import { generateVersionId } from '../../core/brand.ts';
import { CreateWorkflowSchema, UpdateWorkflowSchema, TriggerWorkflowSchema } from './schema.ts';
import { WorkflowRunner } from './runner.ts';

const { parse: parseJson } = JSON;
import { ActionRegistry, type CreateActionInput } from './registry.ts';
import type { TriggerConfig, JobDef } from './types.ts';
import { registerCronTrigger } from './triggers.ts';
import { readStepLogs } from './logs.ts';
import { WorkflowSecretService } from './secrets.ts';
import { SharedLinkService } from './shared-link.ts';
import { RunnerRegistry } from './runner-registry.ts';
import type { RunnerHeartbeatInput } from './runner-registry.ts';
import { BlobWorkspaceStore } from './workspace.ts';
import { OrgService, ProjectService, ApprovalService } from './extensions.ts';
import type { CreateOrgInput, CreateProjectInput } from './extensions.ts';
import { DashboardService } from './dashboard.ts';
import { TEMPLATES, TEMPLATE_METAS } from './templates.generated.ts';
import {
  type WorkflowDef,
  type WorkflowRun,
  type JobRun,
  IDX_WORKFLOW_IDS,
  IDX_WORKFLOW_RUN_IDS,
  PFX_WORKFLOW_DEF,
  PFX_WORKFLOW_RUN,
  PFX_JOB_RUN,
  createWorkflowDefId,
} from './types.ts';

// ─── DAG Scheduler integration ───
import { DagScheduler } from '../../core/scheduler/dag-scheduler.ts';
import { SetIntervalBackend } from '../../core/scheduler/set-interval-backend.ts';
import { StoreSchedulerContext } from './scheduler-context.ts';
import { JobOperator } from './job-operator.ts';
import { buildDagFromWorkflow, createDagRunFromTrigger } from './dag-builder.ts';
import { PodService } from '../../core/pod/service.ts';

export function createActionsRouter(deps: FeatureDeps): Hono<any> {
  const router = new Hono<{ Variables: AppContext }>();
  const atomic = deps.stores.atomic;
  const blob = deps.stores.blob;

  const actionRegistry = new ActionRegistry(atomic);

  // Shared PodService — Actions and Template use the same instance (CEA K8s executor model)
  const podService = new PodService(deps.stores.atomic, deps.providers);

  const runner = new WorkflowRunner({
    stores: { atomic: deps.stores.atomic, blob: deps.stores.blob },
    providers: {
      dns: deps.providers.dns,
      resolveContainer: deps.providers.resolveContainer?.bind(deps.providers),
    },
    audit: deps.audit,
    queueProducer: deps.queueProducer,
    eventBus: deps.eventBus,
    actionRegistry,
    podService,
  });

  // ── DAG Scheduler setup ──
  const schedulerCtx = new StoreSchedulerContext(atomic);

  const jobOperator = new JobOperator({
    stores: { blob },
    providers: {
      dns: deps.providers.dns,
      resolveContainer: deps.providers.resolveContainer?.bind(deps.providers),
    },
    audit: deps.audit,
    eventBus: deps.eventBus,
    actionRegistry,
    podService,
  });
  schedulerCtx.registerExecutor(jobOperator);

  const dagScheduler = new DagScheduler(
    schedulerCtx,
    new SetIntervalBackend(),
    { intervalMs: 5000, parallelism: 4, autoStart: true },
  );
  dagScheduler.start();
  registerScheduler('dagScheduler', dagScheduler);

  const guard = (action: string, resource: string) =>
    async (c: any, next: () => Promise<void>) => {
      if (deps.permissionChecker) {
        const r = await deps.permissionChecker.check({
          userId: c.get?.('userId') ?? 'anonymous',
          action, resource,
          ip: c.req.header?.('CF-Connecting-IP'),
        });
        if (!r.allowed) throw new AppError(403, 'FORBIDDEN', r.reason);
      }
      await next();
    };

  // ── Cron trigger registration ──

  registerCronTrigger({
    atomic,
    eventBus: deps.eventBus,
    eventLoop: deps.eventLoop,
    audit: deps.audit,
    onTrigger: async (wf, trigger, payload) => runner.startRun(wf, trigger, payload),
  });

  // ── Workflow CRUD ──

  router.post('/workflows', guard('create', 'action:workflow'), async (c) => {
    const body = await c.req.json();
    const parsed = CreateWorkflowSchema.safeParse(body);
    if (!parsed.success) throw new AppError(400, 'INVALID_WORKFLOW', parsed.error.message);

    const input = parsed.data;
    const id = createWorkflowDefId(`wf_${crypto.randomUUID()}`);
    const now = Date.now();

    const def: WorkflowDef = {
      id,
      name: input.name,
      ...(input.description ? { description: input.description } : {}),
      on: input.on as TriggerConfig,
      ...(input.env ? { env: input.env } : {}),
      jobs: input.jobs as Record<string, JobDef>,
      ...(input.orgId ? { orgId: input.orgId } : {}),
      ...(input.projectId ? { projectId: input.projectId } : {}),
      ownerId: c.var.currentUser?.id ?? 'anonymous',
      ...(input.metadata ? { metadata: input.metadata } : {}),
      ...(input.annotations ? { annotations: input.annotations } : {}),
      createdAt: now,
      updatedAt: now,
      version: generateVersionId(),
    };

    await atomic.set(PFX_WORKFLOW_DEF + id, def, null);
    const idx = await atomic.get<string[]>(IDX_WORKFLOW_IDS);
    await atomic.set(IDX_WORKFLOW_IDS, [...(idx?.value ?? []), id], idx?.version ?? null);
    return c.json(ok(def), 201);
  });

  router.get('/workflows', async (c) => {
    const idx = await atomic.get<string[]>(IDX_WORKFLOW_IDS);
    if (!idx) return c.json(ok({ items: [], total: 0, page: 1, limit: 50 }));
    const page = Math.max(1, parseInt(c.req.query('page') ?? '') || 1);
    const limit = Math.min(Math.max(1, parseInt(c.req.query('limit') ?? '') || 50), 200);
    const total = idx.value.length;
    const start = (page - 1) * limit;
    const pageIds = idx.value.slice(start, start + limit);
    const entries = await Promise.all(
      pageIds.map(i => atomic.get<WorkflowDef>(PFX_WORKFLOW_DEF + i)),
    );
    return c.json(ok({ items: entries.filter(e => e).map(e => e!.value), total, page, limit }));
  });

  router.get('/workflows/:id', async (c) => {
    const entry = await atomic.get<WorkflowDef>(PFX_WORKFLOW_DEF + c.req.param('id'));
    if (!entry) throw new AppError(404, 'WORKFLOW_NOT_FOUND', 'Workflow not found');
    return c.json(ok(entry.value));
  });

  router.patch('/workflows/:id', guard('update', 'action:workflow'), async (c) => {
    const wid = c.req.param('id');
    const entry = await atomic.get<WorkflowDef>(PFX_WORKFLOW_DEF + wid);
    if (!entry) throw new AppError(404, 'WORKFLOW_NOT_FOUND', 'Workflow not found');

    const body = await c.req.json();
    const parsed = UpdateWorkflowSchema.safeParse(body);
    if (!parsed.success) throw new AppError(400, 'INVALID_WORKFLOW', parsed.error.message);

    const input = parsed.data;
    const updated: WorkflowDef = {
      ...entry.value,
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.description != null ? { description: input.description } : {}),
      ...(input.on !== undefined ? { on: input.on as TriggerConfig } : {}),
      ...(input.env !== undefined ? { env: input.env } : {}),
      ...(input.jobs !== undefined ? { jobs: input.jobs as Record<string, JobDef> } : {}),
      updatedAt: Date.now(),
      version: generateVersionId(),
    };

    const ver = await atomic.set(PFX_WORKFLOW_DEF + wid, updated, entry.version);
    if (!ver) throw new AppError(409, 'CONFLICT', 'Concurrent modification');
    return c.json(ok(updated));
  });

  router.delete('/workflows/:id', guard('delete', 'action:workflow'), async (c) => {
    const wid = c.req.param('id');
    const entry = await atomic.get<WorkflowDef>(PFX_WORKFLOW_DEF + wid);
    if (!entry) throw new AppError(404, 'WORKFLOW_NOT_FOUND', 'Workflow not found');

    await atomic.set(PFX_WORKFLOW_DEF + wid, null, entry.version);
    const idx = await atomic.get<string[]>(IDX_WORKFLOW_IDS);
    if (idx) await atomic.set(IDX_WORKFLOW_IDS, idx.value.filter(i => i !== wid), idx.version);
    return c.json(ok({ deleted: true }));
  });

  // ── Triggers ──

  router.post('/workflows/:id/trigger', guard('execute', 'action:workflow'), async (c) => {
    const wid = c.req.param('id');
    const entry = await atomic.get<WorkflowDef>(PFX_WORKFLOW_DEF + wid);
    if (!entry) throw new AppError(404, 'WORKFLOW_NOT_FOUND', 'Workflow not found');

    const body = await c.req.json().catch(() => ({}));
    const parsed = TriggerWorkflowSchema.safeParse(body);
    const inputs = parsed.success && parsed.data.inputs ? parsed.data.inputs : {};

    const run = await runner.startRun(entry.value, 'manual', undefined, inputs,
      c.var.currentUser?.id ?? 'anonymous');
    return c.json(ok(run), 201);
  });

  /** HTTP trigger: POST /api/actions/workflows/:id/http */
  router.post('/workflows/:id/http', async (c) => {
    const wid = c.req.param('id');
    const entry = await atomic.get<WorkflowDef>(PFX_WORKFLOW_DEF + wid);
    if (!entry) throw new AppError(404, 'WORKFLOW_NOT_FOUND', 'Workflow not found');
    if (!entry.value.on.http) throw new AppError(400, 'NOT_HTTP_TRIGGER', 'Workflow does not have HTTP trigger enabled');

    // Read raw body for signature verification
    const rawBody = await c.req.text();
    const secret = entry.value.on.http.signatureSecret;
    if (secret) {
      const sig = c.req.header('X-Workflow-Signature');
      if (!sig) throw new AppError(401, 'MISSING_SIGNATURE', 'X-Workflow-Signature header required');
      const { verifyHttpSignature } = await import('./triggers.ts');
      const valid = await verifyHttpSignature(secret, rawBody, sig);
      if (!valid) throw new AppError(401, 'INVALID_SIGNATURE', 'Signature verification failed');
    }

    let payload: Record<string, unknown> = {};
    try { payload = parseJson(rawBody || '{}'); } catch { /* not JSON */ }
    const inputs = payload.inputs as Record<string, string> | undefined ?? {};

    const run = await runner.startRun(entry.value, 'http', payload, inputs,
      c.var.currentUser?.id ?? 'anonymous');
    return c.json(ok(run), 201);
  });

  /** Scheduler-based trigger: POST /api/actions/workflows/:id/schedule
   *  Converts WorkflowDef → DagDef → DagRun and submits to the Airflow-style
   *  scheduler. The scheduler handles dependency resolution, concurrency, and
   *  retries via TriggerRule + 5-step filter. */
  router.post('/workflows/:id/schedule', guard('execute', 'action:workflow'), async (c) => {
    const wid = c.req.param('id');
    const entry = await atomic.get<WorkflowDef>(PFX_WORKFLOW_DEF + wid);
    if (!entry) throw new AppError(404, 'WORKFLOW_NOT_FOUND', 'Workflow not found');

    const body = await c.req.json().catch(() => ({}));
    const parsed = TriggerWorkflowSchema.safeParse(body);
    const inputs = parsed.success && parsed.data.inputs ? parsed.data.inputs : {};

    // Build DAG and persist
    const { dag } = buildDagFromWorkflow(entry.value);
    await schedulerCtx.saveDagDef(dag);

    // Create DagRun
    const dagRun = createDagRunFromTrigger(
      dag.id, 'manual', undefined, inputs,
      c.var.currentUser?.id ?? 'anonymous',
    );
    const run: any = { ...dagRun, version: generateVersionId() };
    await schedulerCtx.saveNewDagRun(run);

    deps.audit.write({
      level: 5, facility: 'dag-scheduler',
      message: `DagRun ${run.id} created via scheduler for workflow ${entry.value.name}`,
      metadata: { dagId: dag.id, dagRunId: run.id, trigger: 'manual', taskCount: dag.tasks.length },
    });

    return c.json(ok({ dagRunId: run.id, dagId: dag.id, status: run.status, taskCount: dag.tasks.length }), 201);
  });

  /** Generic webhook endpoint: POST /api/actions/webhook
   *  Matches incoming webhook payloads against all workflows that have
   *  on.push configured.  Basic branch-name matching for now. */
  router.post('/webhook', async (c) => {
    const payload = await c.req.json().catch(() => ({}));
    const branch = (payload)?.ref?.replace('refs/heads/', '') ?? '';

    const idx = await atomic.get<string[]>(IDX_WORKFLOW_IDS);
    if (!idx) return c.json(ok({ triggered: [], count: 0 }));

    const triggered: string[] = [];
    for (const wid of idx.value) {
      const entry = await atomic.get<WorkflowDef>(PFX_WORKFLOW_DEF + wid);
      if (!entry?.value.on.push) continue;

      const branches = entry.value.on.push.branches;
      if (branches && branches.length > 0) {
        if (!branches.includes(branch) && !branches.includes('*')) continue;
      }

      const run = await runner.startRun(entry.value, 'webhook', payload, undefined,
        c.var.currentUser?.id ?? 'anonymous');
      triggered.push(run.id);
    }

    return c.json(ok({ triggered, count: triggered.length }));
  });

  // ── Run management ──

  router.get('/runs', async (c) => {
    const idx = await atomic.get<string[]>(IDX_WORKFLOW_RUN_IDS);
    if (!idx) return c.json(ok({ items: [], total: 0, page: 1, limit: 50 }));
    const page = Math.max(1, parseInt(c.req.query('page') ?? '') || 1);
    const limit = Math.min(Math.max(1, parseInt(c.req.query('limit') ?? '') || 50), 200);
    const total = idx.value.length;
    const reversed = [...idx.value].reverse();
    const start = (page - 1) * limit;
    const pageIds = reversed.slice(start, start + limit);
    const entries = await Promise.all(
      pageIds.map(i => atomic.get<WorkflowRun>(PFX_WORKFLOW_RUN + i)),
    );
    return c.json(ok({ items: entries.filter(e => e).map(e => e!.value), total, page, limit }));
  });

  router.get('/runs/:id', async (c) => {
    const entry = await atomic.get<WorkflowRun>(PFX_WORKFLOW_RUN + c.req.param('id'));
    if (!entry) throw new AppError(404, 'RUN_NOT_FOUND', 'Workflow run not found');
    return c.json(ok(entry.value));
  });

  router.get('/runs/:id/jobs', async (c) => {
    const wfEntry = await atomic.get<WorkflowRun>(PFX_WORKFLOW_RUN + c.req.param('id'));
    if (!wfEntry) throw new AppError(404, 'RUN_NOT_FOUND', 'Workflow run not found');

    const jobRuns = await Promise.all(
      wfEntry.value.jobRunRefs.map(ref => atomic.get<JobRun>(PFX_JOB_RUN + ref.jobRunId)),
    );
    return c.json(ok(jobRuns.filter(j => j).map(j => j!.value)));
  });

  /** DAG endpoint — returns nodes + edges with real-time status for dependency graph rendering. */
  router.get('/runs/:id/dag', async (c) => {
    const wfEntry = await atomic.get<WorkflowRun>(PFX_WORKFLOW_RUN + c.req.param('id'));
    if (!wfEntry) throw new AppError(404, 'RUN_NOT_FOUND', 'Workflow run not found');
    const run = wfEntry.value;

    const wfDefEntry = await atomic.get<WorkflowDef>(PFX_WORKFLOW_DEF + run.workflowId);
    if (!wfDefEntry) throw new AppError(404, 'WORKFLOW_NOT_FOUND', 'Workflow definition not found');
    const jobs = wfDefEntry.value.jobs;

    const jobRuns = await Promise.all(
      run.jobRunRefs.map(ref => atomic.get<JobRun>(PFX_JOB_RUN + ref.jobRunId)),
    );
    const statusMap = new Map(jobRuns.filter(j => j).map(j => [j!.value.jobName, j!.value]));

    const nodes = run.jobRunRefs.map(ref => ({
      id: ref.jobName,
      label: ref.jobName,
      status: statusMap.get(ref.jobName)?.status ?? 'Queued',
      startedAt: statusMap.get(ref.jobName)?.startedAt,
      completedAt: statusMap.get(ref.jobName)?.completedAt,
      stepCount: statusMap.get(ref.jobName)?.stepRuns.length ?? 0,
      completedSteps: statusMap.get(ref.jobName)?.stepRuns.filter(s => s.status === 'Success').length ?? 0,
    }));

    const edges: { from: string; to: string }[] = [];
    for (const [name, job] of Object.entries(jobs)) {
      for (const dep of job.needs ?? []) {
        edges.push({ from: dep, to: name });
      }
    }

    return c.json(ok({
      workflowName: wfDefEntry.value.name,
      status: run.status,
      trigger: run.trigger,
      startedAt: run.startedAt,
      completedAt: run.completedAt,
      nodes,
      edges,
    }));
  });

  router.get('/jobs/:id', async (c) => {
    const entry = await atomic.get<JobRun>(PFX_JOB_RUN + c.req.param('id'));
    if (!entry) throw new AppError(404, 'JOB_NOT_FOUND', 'Job run not found');
    return c.json(ok(entry.value));
  });

  // ── Step logs ──

  router.get('/jobs/:id/logs', async (c) => {
    const jobId = c.req.param('id');
    const entry = await atomic.get<JobRun>(PFX_JOB_RUN + jobId);
    if (!entry) throw new AppError(404, 'JOB_NOT_FOUND', 'Job run not found');

    const step = c.req.query('step') || 'all';
    const offset = Math.max(0, parseInt(c.req.query('offset') ?? '') || 0);
    const limit = Math.min(parseInt(c.req.query('limit') ?? '') || 500, 10000);

    const result = await readStepLogs(blob, jobId, step, offset, limit);
    return c.json(ok(result));
  });

  // ── Action registry ──

  router.post('/actions', async (c) => {
    const body = await c.req.json();
    if (!body.name || !body.version || !body.runs) {
      throw new AppError(400, 'INVALID_ACTION', 'name, version, and runs are required');
    }
    const def = await actionRegistry.register(body);
    return c.json(ok(def), 201);
  });

  router.get('/actions', async (c) => {
    const list = await actionRegistry.list();
    const page = Math.max(1, parseInt(c.req.query('page') ?? '') || 1);
    const limit = Math.min(Math.max(1, parseInt(c.req.query('limit') ?? '') || 50), 200);
    const total = list.length;
    const start = (page - 1) * limit;
    return c.json(ok({ items: list.slice(start, start + limit), total, page, limit }));
  });

  // ── Organizations & Projects ──

  const orgService = new OrgService(atomic);
  const projectService = new ProjectService(atomic, orgService);

  router.post('/orgs', async (c) => {
    const body = await c.req.json();
    const ownerId = c.var.currentUser?.id ?? 'anonymous';
    const org = await orgService.create(ownerId, body);
    return c.json(ok(org), 201);
  });

  router.get('/orgs', async (c) => {
    const memberId = c.req.query('member');
    const list = await orgService.list(memberId);
    return c.json(ok(list));
  });

  router.get('/orgs/:id', async (c) => {
    const o = await orgService.get(c.req.param('id'));
    if (!o) throw new AppError(404, 'ORG_NOT_FOUND', 'Organization not found');
    return c.json(ok(o));
  });

  router.post('/orgs/:id/members', async (c) => {
    const { userId } = await c.req.json();
    await orgService.addMember(c.req.param('id'), userId);
    return c.json(ok({ ok: true }));
  });

  router.post('/projects', async (c) => {
    const body = await c.req.json();
    const ownerId = c.var.currentUser?.id ?? 'anonymous';
    const proj = await projectService.create(ownerId, body);
    return c.json(ok(proj), 201);
  });

  router.get('/projects', async (c) => {
    const orgId = c.req.query('orgId');
    if (!orgId) throw new AppError(400, 'MISSING_ORG', 'orgId query param required');
    const list = await projectService.list(orgId);
    return c.json(ok(list));
  });

  // ── Approval ──

  const approvalService = new ApprovalService(atomic);

  router.post('/runs/:id/approvals', async (c) => {
    const { jobName, approvers } = await c.req.json();
    const node = await approvalService.request(c.req.param('id'), jobName, approvers);
    return c.json(ok(node), 201);
  });

  router.post('/approvals/:id/decide', async (c) => {
    const { approved, reason } = await c.req.json();
    const userId = c.var.currentUser?.id ?? 'anonymous';
    const node = await approvalService.decide(c.req.param('id'), userId, approved, reason);
    return c.json(ok(node));
  });

  router.get('/runs/:id/approvals', async (c) => {
    const list = await approvalService.getForRun(c.req.param('id'));
    return c.json(ok(list));
  });

  // ── Secrets ──

  const secretService = new WorkflowSecretService(atomic, deps.secretEncryption);

  router.post('/workflows/:id/secrets', async (c) => {
    const wid = c.req.param('id');
    const wfEntry = await atomic.get<WorkflowDef>(PFX_WORKFLOW_DEF + wid);
    if (!wfEntry) throw new AppError(404, 'WORKFLOW_NOT_FOUND', 'Workflow not found');

    const { key, value } = await c.req.json();
    if (!key || value === undefined) throw new AppError(400, 'INVALID_SECRET', 'key and value required');

    const secret = await secretService.set(wid, key, value);
    return c.json(ok({ id: secret.id, key: secret.key, createdAt: secret.createdAt }), 201);
  });

  router.get('/workflows/:id/secrets', async (c) => {
    const wid = c.req.param('id');
    const list = await secretService.list(wid);
    return c.json(ok(list));
  });

  router.delete('/secrets/:id', async (c) => {
    await secretService.delete(c.req.param('id'));
    return c.json(ok({ deleted: true }));
  });

  // ── Shared links ──

  const sharedLinkService = new SharedLinkService(atomic, deps.audit);

  router.post('/shared-links', async (c) => {
    const body = await c.req.json();
    // Extract owner from auth context if available
    const ownerId = c.var.currentUser?.id ?? 'anonymous';
    const link = await sharedLinkService.create(ownerId, body);
    const { passwordHash, ...safe } = link;
    return c.json(ok(safe), 201);
  });

  router.get('/shared-links', async (c) => {
    const ownerId = c.var.currentUser?.id ?? 'anonymous';
    const links = await sharedLinkService.list(ownerId);
    return c.json(ok(links.map(({ passwordHash, ...safe }) => safe)));
  });

  router.get('/shared-links/:id', async (c) => {
    const link = await sharedLinkService.get(c.req.param('id'));
    if (!link) throw new AppError(404, 'LINK_NOT_FOUND', 'Shared link not found');
    const { passwordHash, ...safe } = link;
    return c.json(ok(safe));
  });

  /** Guest access: validate and trigger. No auth required. */
  router.post('/shared-links/:id/launch', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const password = body.password as string | undefined;

    const link = await sharedLinkService.validate(c.req.param('id'), password);

    // Load the workflow and trigger it
    const wfEntry = await atomic.get<WorkflowDef>(PFX_WORKFLOW_DEF + link.workflowId);
    if (!wfEntry) throw new AppError(404, 'WORKFLOW_NOT_FOUND', 'Target workflow not found');

    await sharedLinkService.recordUse(link.id);

    const run = await runner.startRun(wfEntry.value, 'shared_link', { linkId: link.id, defaultTtl: link.defaultTtlSeconds });
    return c.json(ok({ runId: run.id, status: run.status }), 201);
  });

  router.post('/shared-links/:id/disable', async (c) => {
    const ownerId = c.var.currentUser?.id ?? 'anonymous';
    await sharedLinkService.disable(c.req.param('id'), ownerId);
    return c.json(ok({ disabled: true }));
  });

  // ── Runner registry ──

  const runnerRegistry = new RunnerRegistry(atomic, deps.audit);

  /** Runner heartbeat: POST /api/actions/runners/heartbeat */
  router.post('/runners/heartbeat', async (c) => {
    const body = await c.req.json();
    const runner = await runnerRegistry.heartbeat(body);
    return c.json(ok(runner));
  });

  router.get('/runners', async (c) => {
    const labels = c.req.query('labels') ? parseJson(c.req.query('labels')!) : undefined;
    const runners = await runnerRegistry.listOnline(labels);
    return c.json(ok(runners));
  });

  router.get('/runners/:id', async (c) => {
    const r = await runnerRegistry.get(c.req.param('id'));
    if (!r) throw new AppError(404, 'RUNNER_NOT_FOUND', 'Runner not found');
    return c.json(ok(r));
  });

  router.post('/runners/:id/drain', async (c) => {
    await runnerRegistry.drain(c.req.param('id'));
    return c.json(ok({ draining: true }));
  });

  // Register stale-runner cleanup tick
  deps.eventBus.on('runner:heartbeat:check', async () => {
    const marked = await runnerRegistry.markStale();
    if (marked > 0) {
      deps.audit.write({
        level: 4, facility: 'runner-registry',
        message: `Marked ${marked} stale runner(s) offline`,
        metadata: { count: marked },
      });
    }
  });
  deps.eventLoop.enqueuePriority({ type: 'runner:heartbeat:check', payload: {} });

  // ── Workspace ──

  const workspaceStore = new BlobWorkspaceStore(blob);

  router.get('/workspace/:workflowRunId/:jobName', async (c) => {
    const result = await workspaceStore.load(
      c.req.param('workflowRunId'),
      c.req.param('jobName'),
    );
    if (!result) throw new AppError(404, 'WORKSPACE_NOT_FOUND', 'Workspace not found');
    // Return metadata + base64 data for API consumers
    const b64 = btoa(String.fromCharCode(...result.data));
    return c.json(ok({ meta: result.meta, data: b64 }));
  });

  // ── Dashboard ──

  const dashboard = new DashboardService(atomic);

  router.get('/dashboard', async (c) => {
    const userId = c.var.currentUser?.id ?? 'anonymous';
    const metrics = await dashboard.getMetrics(userId);
    return c.json(ok(metrics));
  });

  // ── Templates ──

  router.get('/templates', async (c) => {
    const category = c.req.query('category');
    const items = category
      ? TEMPLATE_METAS.filter(t => t.category === category)
      : TEMPLATE_METAS;
    return c.json(ok({ items, total: items.length }));
  });

  router.get('/templates/:id', async (c) => {
    const t = TEMPLATES.find(tpl => tpl.id === c.req.param('id'));
    if (!t) throw new AppError(404, 'TEMPLATE_NOT_FOUND', 'Template not found');
    return c.json(ok(t));
  });

  return router;
}

export const actionRouteMeta: RouteMeta[] = [
  // Workflow CRUD
  { method: 'POST', path: '/workflows', description: '创建工作流', requestBody: { name: 'my-workflow', on: { manual: true }, jobs: { build: { container: { image: 'node:20' }, steps: [{ run: 'echo hi' }] } } }, responseDescription: 'WorkflowDef' },
  { method: 'GET', path: '/workflows', description: '列出工作流（分页）', queryExamples: [{ page: '1', limit: '50' }], responseDescription: '{ items: WorkflowDef[], total, page, limit }' },
  { method: 'GET', path: '/workflows/:id', description: '获取工作流详情', responseDescription: 'WorkflowDef' },
  { method: 'PATCH', path: '/workflows/:id', description: '更新工作流', requestBody: { name: 'updated-name' }, responseDescription: 'WorkflowDef' },
  { method: 'DELETE', path: '/workflows/:id', description: '删除工作流', responseDescription: '{ deleted: true }' },
  // Triggers
  { method: 'POST', path: '/workflows/:id/trigger', description: '手动触发工作流', requestBody: { inputs: { key: 'value' } }, responseDescription: 'WorkflowRun' },
  { method: 'POST', path: '/workflows/:id/http', description: 'HTTP 触发器（支持 HMAC 签名）', requestBody: { inputs: {} }, responseDescription: 'WorkflowRun' },
  { method: 'POST', path: '/webhook', description: 'Webhook 端点（git push 事件）', requestBody: { ref: 'refs/heads/main' }, responseDescription: '{ triggered: string[], count }' },
  // Runs & Jobs
  { method: 'GET', path: '/runs', description: '列出工作流运行记录（分页，最新在前）', queryExamples: [{ page: '1', limit: '50' }], responseDescription: '{ items: WorkflowRun[], total, page, limit }' },
  { method: 'GET', path: '/runs/:id', description: '获取运行详情', responseDescription: 'WorkflowRun' },
  { method: 'GET', path: '/runs/:id/jobs', description: '获取运行中所有 Job', responseDescription: 'JobRun[]' },
  { method: 'GET', path: '/runs/:id/dag', description: '获取 DAG 可视化数据 — 返回 nodes (id/label/status/stepCount/completedSteps) + edges (from→to)，配合 WebSocket workflow:job:status 实时更新', responseDescription: '{ workflowName, status, trigger, nodes: [{ id, label, status, startedAt, completedAt, stepCount, completedSteps }], edges: [{ from, to }] }' },
  { method: 'GET', path: '/jobs/:id', description: '获取 Job 详情', responseDescription: 'JobRun' },
  { method: 'GET', path: '/jobs/:id/logs', description: '获取 Job 步骤日志（分页）', queryExamples: [{ step: 'build', offset: '0', limit: '500' }], responseDescription: '{ text, totalBytes, offset, limit }' },
  // Action Registry
  { method: 'POST', path: '/actions', description: '注册 Action', requestBody: { name: 'my-action', version: '1.0.0', runs: { using: 'container', image: 'node:20' } }, responseDescription: 'ActionDef' },
  { method: 'GET', path: '/actions', description: '列出已注册 Action（分页）', queryExamples: [{ page: '1', limit: '50' }], responseDescription: '{ items: ActionDef[], total, page, limit }' },
  // Secrets
  { method: 'POST', path: '/workflows/:id/secrets', description: '设置工作流密钥（AES-256-GCM 加密）', requestBody: { key: 'DOCKER_PASSWORD', value: 'my-secret' }, responseDescription: '{ id, key, createdAt }' },
  { method: 'GET', path: '/workflows/:id/secrets', description: '列出工作流密钥（不返回 value）', responseDescription: '{ key, id }[]' },
  { method: 'DELETE', path: '/secrets/:id', description: '删除密钥', responseDescription: '{ deleted: true }' },
  // Shared Links
  { method: 'POST', path: '/shared-links', description: '创建共享链接', requestBody: { workflowId: 'wf_xxx', name: 'my-game', password: 'optional', expiresAt: Date.now() + 86400000, maxUses: 10, defaultTtlSeconds: 3600 }, responseDescription: 'SharedLink (不含 passwordHash)' },
  { method: 'GET', path: '/shared-links', description: '列出我的共享链接', responseDescription: 'SharedLink[]' },
  { method: 'GET', path: '/shared-links/:id', description: '获取共享链接详情（不含 passwordHash）', responseDescription: 'SharedLink' },
  { method: 'POST', path: '/shared-links/:id/launch', description: 'Guest 匿名触发共享服务启动', requestBody: { password: 'optional' }, responseDescription: '{ runId, status }' },
  { method: 'POST', path: '/shared-links/:id/disable', description: '撤销共享链接', responseDescription: '{ disabled: true }' },
  // Runner Registry
  { method: 'POST', path: '/runners/heartbeat', description: 'Runner 注册/心跳', requestBody: { name: 'runner-01', labels: { os: 'linux' }, capacity: { cpu: 4, memory: 8192 } }, responseDescription: 'RunnerRegistration' },
  { method: 'GET', path: '/runners', description: '列出在线 Runner（支持 labels 过滤）', queryExamples: [{ labels: '{"os":"linux"}' }], responseDescription: 'RunnerRegistration[]' },
  { method: 'GET', path: '/runners/:id', description: '获取 Runner 详情', responseDescription: 'RunnerRegistration' },
  { method: 'POST', path: '/runners/:id/drain', description: 'Runner 排水（停止接新任务）', responseDescription: '{ draining: true }' },
  // Workspace
  { method: 'GET', path: '/workspace/:workflowRunId/:jobName', description: '下载工作空间快照', responseDescription: '{ meta: WorkspaceMeta, data: base64 }' },
  { method: 'GET', path: '/dashboard', description: '平台仪表盘聚合指标（含个人维度 myRuns/mySuccessRate/myRecentRuns）', responseDescription: '{ totalRuns, activeRuns, successRate, avgDurationMs, runnersOnline, byTrigger, byStatus, myRuns?, mySuccessRate?, myRecentRuns? }' },
  { method: 'GET', path: '/templates', description: '列出工作流模板（?category=ci|deploy|service|maintenance|test）', queryExamples: [{ category: 'ci' }], responseDescription: '{ items: TemplateMeta[], total }' },
  { method: 'GET', path: '/templates/:id', description: '获取模板详情（元数据）', responseDescription: 'TemplateMeta' },
];
