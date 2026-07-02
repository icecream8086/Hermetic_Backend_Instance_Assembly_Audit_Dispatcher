import { z } from 'zod';
import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { AppError } from '../../core/types.ts';
import type { AppContext } from '../../core/deps.ts';
import type { SecurityResourceService } from '../../core/security/service.ts';
import { createSecurityResourceId } from '../../core/security/types.ts';
import { SecurityResourceStatus } from '../../core/security/types.ts';
import { createInstanceId } from '../../core/region/instance.ts';
import type { IS3Provider } from '../../core/provider/s3.ts';
import { CreateSecurityResourceSchema } from './schema.ts';
import { ok } from '../../core/response.ts';
import { OkResponse } from '../../core/http-docs/response-schema.ts';
import { SecurityResourceSchema, SecurityResourceListResponseSchema } from './response-schema.ts';

const ADMIN_ROLES = new Set(['root', 'Operator', 'wheel']);

const STATUS_VALUES = z.enum(['Active', 'Expired', 'Revoked']);

function parseStatus(raw: string): SecurityResourceStatus {
  const s = STATUS_VALUES.parse(raw);
  switch (s) {
    case 'Active': return SecurityResourceStatus.Active;
    case 'Expired': return SecurityResourceStatus.Expired;
    case 'Revoked': return SecurityResourceStatus.Revoked;
  }
}

function isRoot<E extends { Variables: { currentUser?: { role?: string } } }>(c: Context<E>): void {
  const role = z.string().optional().parse(c.var.currentUser?.role);
  if (!role || !ADMIN_ROLES.has(role)) {
    throw new AppError(403, 'FORBIDDEN', 'Admin access required');
  }
}

interface SanitizedResource {
  id: string; name: string; bucketId: string; instanceId: string;
  validDuration: number; refreshThreshold: number;
  status: SecurityResourceStatus;
  value: { expiresAt: string };
  createdAt: number; updatedAt: number;
}

function sanitize(r: { id: string; name: string; bucketId: string; instanceId: string; validDuration: number; refreshThreshold: number; status: SecurityResourceStatus; value: { expiresAt: string }; createdAt: number; updatedAt: number }): SanitizedResource {
  return {
    id: r.id, name: r.name, bucketId: r.bucketId, instanceId: r.instanceId,
    validDuration: r.validDuration, refreshThreshold: r.refreshThreshold,
    status: r.status,
    value: { expiresAt: r.value.expiresAt },
    createdAt: r.createdAt, updatedAt: r.updatedAt,
  };
}

export interface SecurityRouterDeps {
  securityService: SecurityResourceService;
  s3ProviderResolver: (bucketId: string) => Promise<{ provider: IS3Provider; bucket: { name: string; endpoint: string; region: string } }>;
}

export function createSecurityRouter(deps: SecurityRouterDeps): OpenAPIHono<{ Variables: AppContext }> {
  const { securityService, s3ProviderResolver } = deps;
  const app = new OpenAPIHono<{ Variables: AppContext }>();

  // ── POST /api/security ──
  app.openapi(
    createRoute({
      method: 'post',
      path: '/',
      tags: ['security'],
      summary: '创建 SecurityResource，自动签发 presigned URL 组',
      request: { body: { content: { 'application/json': { schema: CreateSecurityResourceSchema } } } },
      responses: { 201: { description: 'SecurityResource created', content: { 'application/json': { schema: OkResponse(SecurityResourceSchema) } } } },
    }),
    async (c) => {
      isRoot(c);
      // eslint-disable-next-line local-rules/enforce-decode-layer -- .parse(AwaitExpr) — rule only checks immediate parent, not grandparent
      const body = CreateSecurityResourceSchema.parse(await c.req.json());
      const { provider, bucket } = await s3ProviderResolver(body.bucketId);
      const resource = await securityService.provision(
        {
          name: body.name,
          bucketId: body.bucketId,
          instanceId: createInstanceId(body.instanceId),
          validDuration: body.validDuration,
          refreshThreshold: body.refreshThreshold,
        },
        provider,
        bucket.name,
        bucket.endpoint,
        bucket.region,
      );
      return c.json(ok(sanitize(resource)), 201);
    },
  );

  // ── GET /api/security ──
  app.openapi(
    createRoute({
      method: 'get',
      path: '/',
      tags: ['security'],
      summary: '列出所有 SecurityResource',
      responses: { 200: { description: 'SecurityResource[]', content: { 'application/json': { schema: OkResponse(SecurityResourceListResponseSchema) } } } },
    }),
    async (c) => {
      const statusRaw = c.req.query('status');
      const status = statusRaw ? parseStatus(statusRaw) : undefined;
      const resources = await securityService.list(status);
      return c.json(ok({ items: resources.map(sanitize) }));
    },
  );

  // ── GET /api/security/{id} ──
  app.openapi(
    createRoute({
      method: 'get',
      path: '/{id}',
      tags: ['security'],
      summary: '获取单个 SecurityResource',
      request: { params: z.object({ id: z.string() }) },
      responses: { 200: { description: 'SecurityResource', content: { 'application/json': { schema: OkResponse(SecurityResourceSchema) } } } },
    }),
    async (c) => {
      const id = createSecurityResourceId(c.req.param('id'));
      const resource = await securityService.getById(id);
      if (!resource) throw new AppError(404, 'NOT_FOUND', 'SecurityResource not found');
      return c.json(ok(sanitize(resource)));
    },
  );

  // ── POST /api/security/{id}/refresh ──
  app.openapi(
    createRoute({
      method: 'post',
      path: '/{id}/refresh',
      tags: ['security'],
      summary: '手动刷新 presigned URLs',
      request: { params: z.object({ id: z.string() }) },
      responses: { 200: { description: 'Refreshed', content: { 'application/json': { schema: OkResponse(SecurityResourceSchema) } } } },
    }),
    async (c) => {
      isRoot(c);
      const id = createSecurityResourceId(c.req.param('id'));
      const resource = await securityService.getById(id);
      if (!resource) throw new AppError(404, 'NOT_FOUND', 'SecurityResource not found');
      const { provider } = await s3ProviderResolver(resource.bucketId);
      const refreshed = await securityService.refresh(id, provider);
      return c.json(ok(sanitize(refreshed)));
    },
  );

  // ── POST /api/security/{id}/revoke ──
  app.openapi(
    createRoute({
      method: 'post',
      path: '/{id}/revoke',
      tags: ['security'],
      summary: '吊销 SecurityResource',
      request: { params: z.object({ id: z.string() }) },
      responses: { 200: { description: 'Revoked', content: { 'application/json': { schema: OkResponse(z.null()) } } } },
    }),
    async (c) => {
      isRoot(c);
      const id = createSecurityResourceId(c.req.param('id'));
      await securityService.revoke(id);
      return c.json(ok(null));
    },
  );

  // ── DELETE /api/security/{id} ──
  app.openapi(
    createRoute({
      method: 'delete',
      path: '/{id}',
      tags: ['security'],
      summary: '删除 SecurityResource',
      request: { params: z.object({ id: z.string() }) },
      responses: { 200: { description: 'Deleted', content: { 'application/json': { schema: OkResponse(z.null()) } } } },
    }),
    async (c) => {
      isRoot(c);
      const id = createSecurityResourceId(c.req.param('id'));
      await securityService.delete(id);
      return c.json(ok(null));
    },
  );

  return app;
}
