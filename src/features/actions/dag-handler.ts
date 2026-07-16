import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import { z } from 'zod';
import type { AppContext } from '../../core/deps.ts';
import { AppError } from '../../core/types.ts';
import { ok } from '../../core/response.ts';
import { OkResponse, validationHook } from '../../core/http-docs/response-schema.ts';
import { DeletedResponseSchema } from './response-schema.ts';
import type { StoreSchedulerContext } from './scheduler-context.ts';
import type { SchedulerStatus } from '../../core/scheduler/interfaces.ts';
import { createDagId, createDagRunId, createTaskId } from '../../core/dag/types.ts';
import { generateVersionId } from '../../core/brand.ts';

const DagDefResponseSchema = z.object({
  id: z.string(), name: z.string(), description: z.string().optional(),
  taskCount: z.number(), maxActiveTasks: z.number().optional(),
  maxActiveRuns: z.number().optional(), schedule: z.string().optional(),
  createdAt: z.number(), updatedAt: z.number(),
});

const DagRunResponseSchema = z.object({
  id: z.string(), dagId: z.string(), status: z.string(),
  executionDate: z.number(), startedAt: z.number().optional(),
  completedAt: z.number().optional(), trigger: z.string(),
  ownerId: z.string().optional(), error: z.string().optional(),
});

const TaskInstanceResponseSchema = z.object({
  id: z.string(), taskId: z.string(), dagRunId: z.string(),
  state: z.string(), tryNumber: z.number(),
  startedAt: z.number().optional(), completedAt: z.number().optional(),
  error: z.string().optional(),
});

const PoolResponseSchema = z.object({
  name: z.string(), slots: z.number(), occupiedSlots: z.number(),
});

const HealthResponseSchema = z.object({
  status: z.string(), schedulerRunning: z.boolean(), uptimeMs: z.number(),
});

export function createDagRouter(schedulerCtx: StoreSchedulerContext, getHealth?: () => SchedulerStatus): OpenAPIHono<{ Variables: AppContext }> {
  const app = new OpenAPIHono<{ Variables: AppContext }>({ defaultHook: validationHook });

  const parseDagId = (raw: string) => createDagId(raw);
  const parseRunId = (raw: string) => createDagRunId(raw);

  // GET /dags
  app.openapi(createRoute({ method: 'get', path: '/', tags: ['dag'], responses: { 200: { description: '', content: { 'application/json': { schema: OkResponse(z.array(DagDefResponseSchema)) } } } } }), async (c) => {
    const dags = await schedulerCtx.getAllDagDefs();
    return c.json(ok(dags.map(d => ({
      id: d.id, name: d.name, description: d.description,
      taskCount: d.tasks.length, maxActiveTasks: d.maxActiveTasks,
      maxActiveRuns: d.maxActiveRuns, schedule: d.schedule,
      createdAt: d.createdAt, updatedAt: d.updatedAt,
    }))));
  });

  // GET /dags/{dagId}
  app.openapi(createRoute({ method: 'get', path: '/:dagId', tags: ['dag'], responses: { 200: { description: '', content: { 'application/json': { schema: OkResponse(DagDefResponseSchema) } } } } }), async (c) => {
    const entry = await schedulerCtx.getDagDef(parseDagId(c.req.param('dagId')));
    if (!entry) throw new AppError(404, 'NOT_FOUND', 'DAG definition not found');
    const d = entry.value;
    return c.json(ok({
      id: d.id, name: d.name, description: d.description,
      taskCount: d.tasks.length, maxActiveTasks: d.maxActiveTasks,
      maxActiveRuns: d.maxActiveRuns, schedule: d.schedule,
      createdAt: d.createdAt, updatedAt: d.updatedAt,
    }));
  });

  // DELETE /dags/{dagId}
  app.openapi(createRoute({ method: 'delete', path: '/:dagId', tags: ['dag'], responses: { 200: { description: '', content: { 'application/json': { schema: OkResponse(DeletedResponseSchema) } } } } }), async (c) => {
    const dagId = parseDagId(c.req.param('dagId'));
    const entry = await schedulerCtx.getDagDef(dagId);
    if (!entry) throw new AppError(404, 'NOT_FOUND', 'DAG definition not found');
    await schedulerCtx.deleteDagDef(dagId, entry.version);
    return c.json(ok({ deleted: true }));
  });

  // GET /dags/{dagId}/dagRuns
  app.openapi(createRoute({ method: 'get', path: '/:dagId/dagRuns', tags: ['dag'], responses: { 200: { description: '', content: { 'application/json': { schema: OkResponse(z.array(DagRunResponseSchema)) } } } } }), async (c) => {
    const runs = await schedulerCtx.getDagRunsForDag(parseDagId(c.req.param('dagId')));
    return c.json(ok(runs.map(r => ({
      id: r.id, dagId: r.dagId, status: r.status,
      executionDate: r.executionDate, startedAt: r.startedAt,
      completedAt: r.completedAt, trigger: r.trigger,
      ownerId: r.ownerId, error: r.error,
    }))));
  });

  // GET /dags/{dagId}/dagRuns/{dagRunId}
  app.openapi(createRoute({ method: 'get', path: '/:dagId/dagRuns/:dagRunId', tags: ['dag'], responses: { 200: { description: '', content: { 'application/json': { schema: OkResponse(DagRunResponseSchema) } } } } }), async (c) => {
    const entry = await schedulerCtx.getDagRun(parseRunId(c.req.param('dagRunId')));
    if (!entry) throw new AppError(404, 'NOT_FOUND', 'DagRun not found');
    const r = entry.value;
    return c.json(ok({
      id: r.id, dagId: r.dagId, status: r.status,
      executionDate: r.executionDate, startedAt: r.startedAt,
      completedAt: r.completedAt, trigger: r.trigger,
      ownerId: r.ownerId, error: r.error,
    }));
  });

  // GET /dags/{dagId}/dagRuns/{dagRunId}/taskInstances
  app.openapi(createRoute({ method: 'get', path: '/:dagId/dagRuns/:dagRunId/taskInstances', tags: ['dag'], responses: { 200: { description: '', content: { 'application/json': { schema: OkResponse(z.array(TaskInstanceResponseSchema)) } } } } }), async (c) => {
    const tis = await schedulerCtx.getTaskInstances(parseRunId(c.req.param('dagRunId')));
    return c.json(ok(tis.map(t => ({
      id: t.id, taskId: t.taskId, dagRunId: t.dagRunId,
      state: t.state, tryNumber: t.tryNumber,
      startedAt: t.startedAt, completedAt: t.completedAt, error: t.error,
    }))));
  });

  // GET /dags/{dagId}/dagRuns/{dagRunId}/taskInstances/{tiId}
  app.openapi(createRoute({ method: 'get', path: '/:dagId/dagRuns/:dagRunId/taskInstances/:tiId', tags: ['dag'], responses: { 200: { description: '', content: { 'application/json': { schema: OkResponse(TaskInstanceResponseSchema) } } } } }), async (c) => {
    const dagRunId = parseRunId(c.req.param('dagRunId'));
    const tiId = c.req.param('tiId');
    const tis = await schedulerCtx.getTaskInstances(dagRunId);
    const ti = tis.find(t => t.id === tiId);
    if (!ti) throw new AppError(404, 'NOT_FOUND', 'TaskInstance not found');
    return c.json(ok({
      id: ti.id, taskId: ti.taskId, dagRunId: ti.dagRunId,
      state: ti.state, tryNumber: ti.tryNumber,
      startedAt: ti.startedAt, completedAt: ti.completedAt, error: ti.error,
    }));
  });

  // GET /dags/{dagId}/dagRuns/{dagRunId}/taskInstances/{tiId}/logs
  app.openapi(createRoute({ method: 'get', path: '/:dagId/dagRuns/:dagRunId/taskInstances/:tiId/logs', tags: ['dag'], responses: { 200: { description: '', content: { 'application/json': { schema: OkResponse(z.object({ logs: z.string() })) } } } } }), async (c) => {
    // ponytail: logs backend TBD — return 501 until implemented
    throw new AppError(501, 'NOT_IMPLEMENTED', 'TaskInstance logs not yet available');
  });

  // POST /dags/from-yaml
  const FromYamlSchema = z.object({
    id: z.string(), name: z.string(),
    tasks: z.array(z.object({ id: z.string(), name: z.string(), operatorType: z.string(), dependsOn: z.array(z.string()).default([]) })),
    createdAt: z.number(), updatedAt: z.number(),
    description: z.string().optional(), maxActiveTasks: z.number().optional(),
    maxActiveRuns: z.number().optional(), schedule: z.string().optional(),
  });
  app.openapi(createRoute({ method: 'post', path: '/from-yaml', tags: ['dag'], responses: { 201: { description: '', content: { 'application/json': { schema: OkResponse(DagDefResponseSchema) } } } } }), async (c) => {
    const input = FromYamlSchema.parse(await c.req.json());
    const dagDef: import('../../core/dag/types.ts').DagDef = {
      id: createDagId(input.id),
      name: input.name,
      tasks: input.tasks.map(t => ({
        id: createTaskId(t.id),
        name: t.name,
        operatorType: 'noop',
        dependsOn: t.dependsOn.map(d => createTaskId(d)),
        triggerRule: 'all_success',
        retries: 0,
        retryDelayMs: 0,
        config: {},
      })),
      maxActiveTasks: input.maxActiveTasks,
      maxActiveRuns: input.maxActiveRuns,
      schedule: input.schedule,
      createdAt: input.createdAt,
      updatedAt: input.updatedAt,
      version: generateVersionId(),
    };
    await schedulerCtx.saveDagDef(dagDef);
    return c.json(ok({
      id: dagDef.id, name: dagDef.name,
      taskCount: dagDef.tasks.length,
      createdAt: dagDef.createdAt, updatedAt: dagDef.updatedAt,
    }), 201);
  });

  // GET /pools
  app.openapi(createRoute({ method: 'get', path: '/pools', tags: ['dag'], responses: { 200: { description: '', content: { 'application/json': { schema: OkResponse(z.array(PoolResponseSchema)) } } } } }), async (c) => {
    const pools = await schedulerCtx.getAllPools();
    return c.json(ok(pools.map(p => ({ name: p.name, slots: p.slots, occupiedSlots: p.occupiedSlots }))));
  });

  // GET /health
  app.openapi(createRoute({ method: 'get', path: '/health', tags: ['dag'], responses: { 200: { description: '', content: { 'application/json': { schema: OkResponse(HealthResponseSchema) } } } } }), async (c) => {
    const health = getHealth?.();
    return c.json(ok({
      status: health ? 'ok' : 'unknown',
      schedulerRunning: health?.running ?? false,
      uptimeMs: health?.uptimeMs ?? 0,
    }));
  });

  return app;
}
