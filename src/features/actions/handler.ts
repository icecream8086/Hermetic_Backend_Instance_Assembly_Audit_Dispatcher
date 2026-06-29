import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import { z } from 'zod';
import type { FeatureDeps, AppContext } from '../../core/deps.ts';
import { AppError } from '../../core/types.ts';
import { ok } from '../../core/response.ts';
import { register as registerScheduler } from '../../core/scheduler/registry.ts';


import { generateVersionId } from '../../core/brand.ts';
import { CreateWorkflowSchema, UpdateWorkflowSchema, TriggerWorkflowSchema } from './schema.ts';
import { WorkflowRunner } from './runner.ts';

const { parse: parseJson } = JSON;
import { ActionRegistry } from './registry.ts';
import type { TriggerConfig, JobDef } from './types.ts';
import { registerCronTrigger } from './triggers.ts';
import { readStepLogs } from './logs.ts';
import { WorkflowSecretService } from './secrets.ts';
import { SharedLinkService } from './shared-link.ts';
import { RunnerRegistry } from './runner-registry.ts';
import { BlobWorkspaceStore } from './workspace.ts';
import { OrgService, ProjectService, ApprovalService } from './extensions.ts';
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

export function createActionsRouter(deps: FeatureDeps): OpenAPIHono<{ Variables: AppContext }> {
  const app = new OpenAPIHono<{ Variables: AppContext }>();
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
    async (c: any) => {
      if (!deps.permissionChecker) return;
      const r = await deps.permissionChecker.check({
        userId: c.var.currentUser?.id ?? c.get?.('userId') ?? 'anonymous',
        action, resource,
        ip: c.req.header?.('CF-Connecting-IP'),
      });
      if (!r.allowed) throw new AppError(403, 'FORBIDDEN', r.reason);
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

  app.openapi(createRoute({ method: 'post', path: '/workflows', tags: ['actions'], responses: { 201: { description: '', content: { 'application/json': { schema: z.any() } } } } }), async (c) => { await guard('create', 'action:workflow')(c);
    const body = await c.req.json();
    const parsed = CreateWorkflowSchema.parse(body);
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

  app.openapi(createRoute({ method: 'get', path: '/workflows', tags: ['actions'], responses: { 200: { description: '', content: { 'application/json': { schema: z.any() } } } } }), async (c) => {
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

  app.openapi(createRoute({ method: 'get', path: '/workflows/:id', tags: ['actions'], responses: { 200: { description: '', content: { 'application/json': { schema: z.any() } } } } }), async (c) => {
    const entry = await atomic.get<WorkflowDef>(PFX_WORKFLOW_DEF + c.req.param('id'));
    if (!entry) throw new AppError(404, 'WORKFLOW_NOT_FOUND', 'Workflow not found');
    return c.json(ok(entry.value));
  });

  app.openapi(createRoute({ method: 'patch', path: '/workflows/:id', tags: ['actions'], responses: { 200: { description: '', content: { 'application/json': { schema: z.any() } } } } }), async (c) => { await guard('update', 'action:workflow')(c);
    const wid = c.req.param('id');
    const entry = await atomic.get<WorkflowDef>(PFX_WORKFLOW_DEF + wid);
    if (!entry) throw new AppError(404, 'WORKFLOW_NOT_FOUND', 'Workflow not found');

    const body = await c.req.json();
    const parsed = UpdateWorkflowSchema.parse(body);
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

  app.openapi(createRoute({ method: 'delete', path: '/workflows/:id', tags: ['actions'], responses: { 200: { description: '', content: { 'application/json': { schema: z.any() } } } } }), async (c) => { await guard('delete', 'action:workflow')(c);
    const wid = c.req.param('id');
    const entry = await atomic.get<WorkflowDef>(PFX_WORKFLOW_DEF + wid);
    if (!entry) throw new AppError(404, 'WORKFLOW_NOT_FOUND', 'Workflow not found');

    await atomic.set(PFX_WORKFLOW_DEF + wid, null, entry.version);
    const idx = await atomic.get<string[]>(IDX_WORKFLOW_IDS);
    if (idx) await atomic.set(IDX_WORKFLOW_IDS, idx.value.filter(i => i !== wid), idx.version);
    return c.json(ok({ deleted: true }));
  });

  // ── Triggers ──

  app.openapi(createRoute({ method: 'post', path: '/workflows/:id/trigger', tags: ['actions'], responses: { 201: { description: '', content: { 'application/json': { schema: z.any() } } } } }), async (c) => { await guard('execute', 'action:workflow')(c);
    const wid = c.req.param('id');
    const entry = await atomic.get<WorkflowDef>(PFX_WORKFLOW_DEF + wid);
    if (!entry) throw new AppError(404, 'WORKFLOW_NOT_FOUND', 'Workflow not found');

    const body = await c.req.json().catch(() => ({}));
    const parsed = TriggerWorkflowSchema.parse(body);
    const inputs = parsed.success && parsed.data.inputs ? parsed.data.inputs : {};

    const run = await runner.startRun(entry.value, 'manual', undefined, inputs,
      c.var.currentUser?.id ?? 'anonymous');
    return c.json(ok(run), 201);
  });

  /** HTTP trigger: POST /api/actions/workflows/:id/http */
  app.openapi(createRoute({ method: 'post', path: '/workflows/:id/http', tags: ['actions'], responses: { 201: { description: '', content: { 'application/json': { schema: z.any() } } } } }), async (c) => {
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
  app.openapi(createRoute({ method: 'post', path: '/workflows/:id/schedule', tags: ['actions'], responses: { 201: { description: '', content: { 'application/json': { schema: z.any() } } } } }), async (c) => { await guard('execute', 'action:workflow')(c);
    const wid = c.req.param('id');
    const entry = await atomic.get<WorkflowDef>(PFX_WORKFLOW_DEF + wid);
    if (!entry) throw new AppError(404, 'WORKFLOW_NOT_FOUND', 'Workflow not found');

    const body = await c.req.json().catch(() => ({}));
    const parsed = TriggerWorkflowSchema.parse(body);
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
      message: `DagRun ${String(run.id)} created via scheduler for workflow ${entry.value.name}`,
      metadata: { dagId: dag.id, dagRunId: run.id, trigger: 'manual', taskCount: dag.tasks.length },
    });

    return c.json(ok({ dagRunId: run.id, dagId: dag.id, status: run.status, taskCount: dag.tasks.length }), 201);
  });

  /** Generic webhook endpoint: POST /api/actions/webhook
   *  Matches incoming webhook payloads against all workflows that have
   *  on.push configured.  Basic branch-name matching for now. */
  app.openapi(createRoute({ method: 'post', path: '/webhook', tags: ['actions'], responses: { 201: { description: '', content: { 'application/json': { schema: z.any() } } } } }), async (c) => {
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

  app.openapi(createRoute({ method: 'get', path: '/runs', tags: ['actions'], responses: { 200: { description: '', content: { 'application/json': { schema: z.any() } } } } }), async (c) => {
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

  app.openapi(createRoute({ method: 'get', path: '/runs/:id', tags: ['actions'], responses: { 200: { description: '', content: { 'application/json': { schema: z.any() } } } } }), async (c) => {
    const entry = await atomic.get<WorkflowRun>(PFX_WORKFLOW_RUN + c.req.param('id'));
    if (!entry) throw new AppError(404, 'RUN_NOT_FOUND', 'Workflow run not found');
    return c.json(ok(entry.value));
  });

  app.openapi(createRoute({ method: 'get', path: '/runs/:id/jobs', tags: ['actions'], responses: { 200: { description: '', content: { 'application/json': { schema: z.any() } } } } }), async (c) => {
    const wfEntry = await atomic.get<WorkflowRun>(PFX_WORKFLOW_RUN + c.req.param('id'));
    if (!wfEntry) throw new AppError(404, 'RUN_NOT_FOUND', 'Workflow run not found');

    const jobRuns = await Promise.all(
      wfEntry.value.jobRunRefs.map(ref => atomic.get<JobRun>(PFX_JOB_RUN + ref.jobRunId)),
    );
    return c.json(ok(jobRuns.filter(j => j).map(j => j!.value)));
  });

  /** DAG endpoint — returns nodes + edges with real-time status for dependency graph rendering. */
  app.openapi(createRoute({ method: 'get', path: '/runs/:id/dag', tags: ['actions'], responses: { 200: { description: '', content: { 'application/json': { schema: z.any() } } } } }), async (c) => {
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

  app.openapi(createRoute({ method: 'get', path: '/jobs/:id', tags: ['actions'], responses: { 200: { description: '', content: { 'application/json': { schema: z.any() } } } } }), async (c) => {
    const entry = await atomic.get<JobRun>(PFX_JOB_RUN + c.req.param('id'));
    if (!entry) throw new AppError(404, 'JOB_NOT_FOUND', 'Job run not found');
    return c.json(ok(entry.value));
  });

  // ── Step logs ──

  app.openapi(createRoute({ method: 'get', path: '/jobs/:id/logs', tags: ['actions'], responses: { 200: { description: '', content: { 'application/json': { schema: z.any() } } } } }), async (c) => {
    const jobId = c.req.param('id');
    const entry = await atomic.get<JobRun>(PFX_JOB_RUN + jobId);
    if (!entry) throw new AppError(404, 'JOB_NOT_FOUND', 'Job run not found');

    // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- empty query param '' should also default to 'all'
    const step = c.req.query('step') || 'all';
    const offset = Math.max(0, parseInt(c.req.query('offset') ?? '') || 0);
    const limit = Math.min(parseInt(c.req.query('limit') ?? '') || 500, 10000);

    const result = await readStepLogs(blob, jobId, step, offset, limit);
    return c.json(ok(result));
  });

  // ── Action registry ──

  app.openapi(createRoute({ method: 'post', path: '/actions', tags: ['actions'], responses: { 201: { description: '', content: { 'application/json': { schema: z.any() } } } } }), async (c) => {
    const body = await c.req.json();
    if (!body.name || !body.version || !body.runs) {
      throw new AppError(400, 'INVALID_ACTION', 'name, version, and runs are required');
    }
    const def = await actionRegistry.register(body);
    return c.json(ok(def), 201);
  });

  app.openapi(createRoute({ method: 'get', path: '/actions', tags: ['actions'], responses: { 200: { description: '', content: { 'application/json': { schema: z.any() } } } } }), async (c) => {
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

  app.openapi(createRoute({ method: 'post', path: '/orgs', tags: ['actions'], responses: { 201: { description: '', content: { 'application/json': { schema: z.any() } } } } }), async (c) => {
    const body = await c.req.json();
    const ownerId = c.var.currentUser?.id ?? 'anonymous';
    const org = await orgService.create(ownerId, body);
    return c.json(ok(org), 201);
  });

  app.openapi(createRoute({ method: 'get', path: '/orgs', tags: ['actions'], responses: { 200: { description: '', content: { 'application/json': { schema: z.any() } } } } }), async (c) => {
    const memberId = c.req.query('member');
    const list = await orgService.list(memberId);
    return c.json(ok(list));
  });

  app.openapi(createRoute({ method: 'get', path: '/orgs/:id', tags: ['actions'], responses: { 200: { description: '', content: { 'application/json': { schema: z.any() } } } } }), async (c) => {
    const o = await orgService.get(c.req.param('id'));
    if (!o) throw new AppError(404, 'ORG_NOT_FOUND', 'Organization not found');
    return c.json(ok(o));
  });

  app.openapi(createRoute({ method: 'post', path: '/orgs/:id/members', tags: ['actions'], responses: { 201: { description: '', content: { 'application/json': { schema: z.any() } } } } }), async (c) => {
    const { userId } = await c.req.json();
    await orgService.addMember(c.req.param('id'), userId);
    return c.json(ok({ ok: true }));
  });

  app.openapi(createRoute({ method: 'post', path: '/projects', tags: ['actions'], responses: { 201: { description: '', content: { 'application/json': { schema: z.any() } } } } }), async (c) => {
    const body = await c.req.json();
    const ownerId = c.var.currentUser?.id ?? 'anonymous';
    const proj = await projectService.create(ownerId, body);
    return c.json(ok(proj), 201);
  });

  app.openapi(createRoute({ method: 'get', path: '/projects', tags: ['actions'], responses: { 200: { description: '', content: { 'application/json': { schema: z.any() } } } } }), async (c) => {
    const orgId = c.req.query('orgId');
    if (!orgId) throw new AppError(400, 'MISSING_ORG', 'orgId query param required');
    const list = await projectService.list(orgId);
    return c.json(ok(list));
  });

  // ── Approval ──

  const approvalService = new ApprovalService(atomic);

  app.openapi(createRoute({ method: 'post', path: '/runs/:id/approvals', tags: ['actions'], responses: { 201: { description: '', content: { 'application/json': { schema: z.any() } } } } }), async (c) => {
    const { jobName, approvers } = await c.req.json();
    const node = await approvalService.request(c.req.param('id'), jobName, approvers);
    return c.json(ok(node), 201);
  });

  app.openapi(createRoute({ method: 'post', path: '/approvals/:id/decide', tags: ['actions'], responses: { 201: { description: '', content: { 'application/json': { schema: z.any() } } } } }), async (c) => {
    const { approved, reason } = await c.req.json();
    const userId = c.var.currentUser?.id ?? 'anonymous';
    const node = await approvalService.decide(c.req.param('id'), userId, approved, reason);
    return c.json(ok(node));
  });

  app.openapi(createRoute({ method: 'get', path: '/runs/:id/approvals', tags: ['actions'], responses: { 200: { description: '', content: { 'application/json': { schema: z.any() } } } } }), async (c) => {
    const list = await approvalService.getForRun(c.req.param('id'));
    return c.json(ok(list));
  });

  // ── Secrets ──

  const secretService = new WorkflowSecretService(atomic, deps.secretEncryption);

  app.openapi(createRoute({ method: 'post', path: '/workflows/:id/secrets', tags: ['actions'], responses: { 201: { description: '', content: { 'application/json': { schema: z.any() } } } } }), async (c) => {
    const wid = c.req.param('id');
    const wfEntry = await atomic.get<WorkflowDef>(PFX_WORKFLOW_DEF + wid);
    if (!wfEntry) throw new AppError(404, 'WORKFLOW_NOT_FOUND', 'Workflow not found');

    const { key, value } = await c.req.json();
    if (!key || value === undefined) throw new AppError(400, 'INVALID_SECRET', 'key and value required');

    const secret = await secretService.set(wid, key, value);
    return c.json(ok({ id: secret.id, key: secret.key, createdAt: secret.createdAt }), 201);
  });

  app.openapi(createRoute({ method: 'get', path: '/workflows/:id/secrets', tags: ['actions'], responses: { 200: { description: '', content: { 'application/json': { schema: z.any() } } } } }), async (c) => {
    const wid = c.req.param('id');
    const list = await secretService.list(wid);
    return c.json(ok(list));
  });

  app.openapi(createRoute({ method: 'delete', path: '/secrets/:id', tags: ['actions'], responses: { 200: { description: '', content: { 'application/json': { schema: z.any() } } } } }), async (c) => {
    await secretService.delete(c.req.param('id'));
    return c.json(ok({ deleted: true }));
  });

  // ── Shared links ──

  const sharedLinkService = new SharedLinkService(atomic, deps.audit);

  app.openapi(createRoute({ method: 'post', path: '/shared-links', tags: ['actions'], responses: { 201: { description: '', content: { 'application/json': { schema: z.any() } } } } }), async (c) => {
    const body = await c.req.json();
    // Extract owner from auth context if available
    const ownerId = c.var.currentUser?.id ?? 'anonymous';
    const link = await sharedLinkService.create(ownerId, body);
    const { passwordHash: _passwordHash, ...safe } = link;
    return c.json(ok(safe), 201);
  });

  app.openapi(createRoute({ method: 'get', path: '/shared-links', tags: ['actions'], responses: { 200: { description: '', content: { 'application/json': { schema: z.any() } } } } }), async (c) => {
    const ownerId = c.var.currentUser?.id ?? 'anonymous';
    const links = await sharedLinkService.list(ownerId);
    return c.json(ok(links.map(({ passwordHash: _passwordHash, ...safe }) => safe)));
  });

  app.openapi(createRoute({ method: 'get', path: '/shared-links/:id', tags: ['actions'], responses: { 200: { description: '', content: { 'application/json': { schema: z.any() } } } } }), async (c) => {
    const link = await sharedLinkService.get(c.req.param('id'));
    if (!link) throw new AppError(404, 'LINK_NOT_FOUND', 'Shared link not found');
    const { passwordHash: _passwordHash, ...safe } = link;
    return c.json(ok(safe));
  });

  /** Guest access: validate and trigger. No auth required. */
  app.openapi(createRoute({ method: 'post', path: '/shared-links/:id/launch', tags: ['actions'], responses: { 201: { description: '', content: { 'application/json': { schema: z.any() } } } } }), async (c) => {
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

  app.openapi(createRoute({ method: 'post', path: '/shared-links/:id/disable', tags: ['actions'], responses: { 201: { description: '', content: { 'application/json': { schema: z.any() } } } } }), async (c) => {
    const ownerId = c.var.currentUser?.id ?? 'anonymous';
    await sharedLinkService.disable(c.req.param('id'), ownerId);
    return c.json(ok({ disabled: true }));
  });

  // ── Runner registry ──

  const runnerRegistry = new RunnerRegistry(atomic, deps.audit);

  /** Runner heartbeat: POST /api/actions/runners/heartbeat */
  app.openapi(createRoute({ method: 'post', path: '/runners/heartbeat', tags: ['actions'], responses: { 201: { description: '', content: { 'application/json': { schema: z.any() } } } } }), async (c) => {
    const body = await c.req.json();
    const runner = await runnerRegistry.heartbeat(body);
    return c.json(ok(runner));
  });

  app.openapi(createRoute({ method: 'get', path: '/runners', tags: ['actions'], responses: { 200: { description: '', content: { 'application/json': { schema: z.any() } } } } }), async (c) => {
    const labels = c.req.query('labels') ? parseJson(c.req.query('labels')!) : undefined;
    const runners = await runnerRegistry.listOnline(labels);
    return c.json(ok(runners));
  });

  app.openapi(createRoute({ method: 'get', path: '/runners/:id', tags: ['actions'], responses: { 200: { description: '', content: { 'application/json': { schema: z.any() } } } } }), async (c) => {
    const r = await runnerRegistry.get(c.req.param('id'));
    if (!r) throw new AppError(404, 'RUNNER_NOT_FOUND', 'Runner not found');
    return c.json(ok(r));
  });

  app.openapi(createRoute({ method: 'post', path: '/runners/:id/drain', tags: ['actions'], responses: { 201: { description: '', content: { 'application/json': { schema: z.any() } } } } }), async (c) => {
    await runnerRegistry.drain(c.req.param('id'));
    return c.json(ok({ draining: true }));
  });

  // Register stale-runner cleanup tick
  deps.eventBus.on('runner:heartbeat:check', async () => {
    const marked = await runnerRegistry.markStale();
    if (marked > 0) {
      deps.audit.write({
        level: 4, facility: 'runner-registry',
        message: `Marked ${String(marked)} stale runner(s) offline`,
        metadata: { count: marked },
      });
    }
  });
  deps.eventLoop.enqueuePriority({ type: 'runner:heartbeat:check', payload: {} });

  // ── Workspace ──

  const workspaceStore = new BlobWorkspaceStore(blob);

  app.openapi(createRoute({ method: 'get', path: '/workspace/:workflowRunId/:jobName', tags: ['actions'], responses: { 200: { description: '', content: { 'application/json': { schema: z.any() } } } } }), async (c) => {
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

  app.openapi(createRoute({ method: 'get', path: '/dashboard', tags: ['actions'], responses: { 200: { description: '', content: { 'application/json': { schema: z.any() } } } } }), async (c) => {
    const userId = c.var.currentUser?.id ?? 'anonymous';
    const metrics = await dashboard.getMetrics(userId);
    return c.json(ok(metrics));
  });

  // ── Templates ──

  // eslint-disable-next-line @typescript-eslint/require-await -- interface contract requires Promise<T>
  app.openapi(createRoute({ method: 'get', path: '/templates', tags: ['actions'], responses: { 200: { description: '', content: { 'application/json': { schema: z.any() } } } } }), async (c) => {
    const category = c.req.query('category');
    const items = category
      ? TEMPLATE_METAS.filter(t => t.category === category)
      : TEMPLATE_METAS;
    return c.json(ok({ items, total: items.length }));
  });

  // eslint-disable-next-line @typescript-eslint/require-await -- interface contract requires Promise<T>
  app.openapi(createRoute({ method: 'get', path: '/templates/:id', tags: ['actions'], responses: { 200: { description: '', content: { 'application/json': { schema: z.any() } } } } }), async (c) => {
    const t = TEMPLATES.find(tpl => tpl.id === c.req.param('id'));
    if (!t) throw new AppError(404, 'TEMPLATE_NOT_FOUND', 'Template not found');
    return c.json(ok(t));
  });

  return app;
}