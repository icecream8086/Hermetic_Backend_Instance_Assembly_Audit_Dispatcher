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
import type { S3AccessTokenClaims } from '../../core/security/types.ts';
import { verifyToken, base64urlDecode } from '../../core/security/jwt.ts';
import type { IAtomicStore } from '../../core/store/interfaces.ts';
import { CreateSecurityResourceSchema, PresignQuerySchema, BatchPresignSchema, ListQuerySchema } from './schema.ts';
import { ok } from '../../core/response.ts';
import { OkResponse } from '../../core/http-docs/response-schema.ts';
import {
  SecurityResourceSchema, SecurityResourceListResponseSchema,
} from './response-schema.ts';

const ADMIN_ROLES = new Set(['root', 'Operator', 'wheel']);

function isRoot<E extends { Variables: { currentUser?: { role?: string } } }>(c: Context<E>): void {
  const role = z.string().optional().parse(c.var.currentUser?.role);
  if (!role || !ADMIN_ROLES.has(role)) {
    throw new AppError(403, 'FORBIDDEN', 'Admin access required');
  }
}

async function verifyJwtFromHeader(c: Context<{ Variables: AppContext }>): Promise<S3AccessTokenClaims> {
  const authHeader = c.req.header('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    throw new AppError(401, 'UNAUTHORIZED', 'Missing or malformed Authorization header');
  }
  const atomic: IAtomicStore = c.var.stores.atomic;
  const secretEntry = await atomic.get<string>('_sys:jwt-secret');
  if (!secretEntry?.value) throw new AppError(500, 'INTERNAL_ERROR', 'JWT secret not configured');
  const secret = base64urlDecode(secretEntry.value);
  const result = await verifyToken(authHeader.slice(7), secret);
  if (!result.valid) throw new AppError(401, 'UNAUTHORIZED', result.reason);
  return result.claims;
}

export interface SecurityRouterDeps {
  securityService: SecurityResourceService;
  s3ProviderResolver: (bucketId: string) => Promise<{ provider: IS3Provider; bucket: { name: string; endpoint: string; region: string } }>;
}

export function createSecurityRouter(deps: SecurityRouterDeps): OpenAPIHono<{ Variables: AppContext }> {
  const { securityService, s3ProviderResolver } = deps;
  const app = new OpenAPIHono<{ Variables: AppContext }>();

  // ══════════════════════════════════════════════════
  // Admin CRUD endpoints
  // ══════════════════════════════════════════════════

  // ── POST /api/security ──
  app.openapi(
    createRoute({
      method: 'post',
      path: '/',
      tags: ['security'],
      summary: 'Create SecurityResource (storage access policy)',
      request: { body: { content: { 'application/json': { schema: CreateSecurityResourceSchema } } } },
      responses: { 201: { description: 'Created', content: { 'application/json': { schema: OkResponse(SecurityResourceSchema) } } } },
    }),
    async (c) => {
      isRoot(c);
      // eslint-disable-next-line local-rules/enforce-decode-layer -- .parse(AwaitExpr) — rule only checks immediate parent, not grandparent
      const body = CreateSecurityResourceSchema.parse(await c.req.json());
      const resource = SecurityResourceSchema.parse(await securityService.provision({
        name: body.name,
        bucketId: body.bucketId,
        instanceId: createInstanceId(body.instanceId),
        tokenTtl: body.tokenTtl,
        presignedUrlTtl: body.presignedUrlTtl,
        accessPolicy: body.accessPolicy,
      }));
      return c.json(ok(resource), 201);
    },
  );

  // ── GET /api/security ──
  app.openapi(
    createRoute({
      method: 'get',
      path: '/',
      tags: ['security'],
      summary: 'List all SecurityResources',
      responses: { 200: { description: 'List', content: { 'application/json': { schema: OkResponse(SecurityResourceListResponseSchema) } } } },
    }),
    async (c) => {
      const statusRaw = c.req.query('status');
      const status = statusRaw ? z.enum(['Active', 'Expired', 'Revoked']).parse(statusRaw) : undefined;
      const resources = await securityService.list(
        status === 'Active' ? SecurityResourceStatus.Active
          : status === 'Expired' ? SecurityResourceStatus.Expired
          : status === 'Revoked' ? SecurityResourceStatus.Revoked
          : undefined,
      );
      return c.json(ok({ items: resources.map(r => SecurityResourceSchema.parse(r)) }));
    },
  );

  // ── GET /api/security/{id} ──
  app.openapi(
    createRoute({
      method: 'get',
      path: '/{id}',
      tags: ['security'],
      summary: 'Get SecurityResource by ID',
      request: { params: z.object({ id: z.string() }) },
      responses: { 200: { description: 'Resource', content: { 'application/json': { schema: OkResponse(SecurityResourceSchema) } } } },
    }),
    async (c) => {
      const id = createSecurityResourceId(c.req.param('id'));
      const resource = await securityService.getById(id);
      if (!resource) throw new AppError(404, 'NOT_FOUND', 'SecurityResource not found');
      return c.json(ok(SecurityResourceSchema.parse(resource)));
    },
  );

  // ── POST /api/security/{id}/revoke ──
  app.openapi(
    createRoute({
      method: 'post',
      path: '/{id}/revoke',
      tags: ['security'],
      summary: 'Revoke SecurityResource',
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
      summary: 'Delete SecurityResource',
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

  // ══════════════════════════════════════════════════
  // Container-facing endpoints (JWT auth)
  // ══════════════════════════════════════════════════

  // ── GET /api/security/presign ──
  app.get('/presign', async (c) => {
    const claims = await verifyJwtFromHeader(c);
    const query = PresignQuerySchema.parse({
      bucket: c.req.query('bucket'),
      key: c.req.query('key'),
      method: c.req.query('method'),
    });

    // Authorize: check grant covers (bucket, key, method)
    const grant = claims.grants.find(g => g.bucket === query.bucket);
    if (!grant) throw new AppError(403, 'FORBIDDEN', `No access to bucket "${query.bucket}"`);
    if (!query.key.startsWith(grant.prefix)) {
      throw new AppError(403, 'FORBIDDEN', `Key "${query.key}" not under allowed prefix "${grant.prefix}"`);
    }
    const requiredPerm = query.method === 'GET' ? 'read' : 'write';
    if (!grant.permissions.includes(requiredPerm)) {
      throw new AppError(403, 'FORBIDDEN', `No "${requiredPerm}" permission on "${query.bucket}"`);
    }

    const resource = await securityService.getByBucketId(query.bucket);
    const urlTtl = resource?.presignedUrlTtl ?? 300;

    const { provider } = await s3ProviderResolver(query.bucket);
    const url = query.method === 'GET'
      ? await provider.getPresignedUrl(query.bucket, query.key, urlTtl)
      : await provider.putPresignedUrl(query.bucket, query.key, urlTtl);

    const expiresAt = new Date(Date.now() + urlTtl * 1000).toISOString();
    return c.json(ok({ url, bucket: query.bucket, key: query.key, expiresAt }));
  });

  // ── POST /api/security/batch-presign ──
  app.post('/batch-presign', async (c) => {
    const claims = await verifyJwtFromHeader(c);
    // eslint-disable-next-line local-rules/enforce-decode-layer
    const body = BatchPresignSchema.parse(await c.req.json());

    // Authorize each file
    for (const f of body.files) {
      const grant = claims.grants.find(g => g.bucket === f.bucket);
      if (!grant) throw new AppError(403, 'FORBIDDEN', `No access to bucket "${f.bucket}"`);
      if (!f.key.startsWith(grant.prefix)) {
        throw new AppError(403, 'FORBIDDEN', `Key "${f.key}" not under allowed prefix "${grant.prefix}"`);
      }
      const requiredPerm = f.method === 'GET' ? 'read' : 'write';
      if (!grant.permissions.includes(requiredPerm)) {
        throw new AppError(403, 'FORBIDDEN', `No "${requiredPerm}" permission`);
      }
    }

    const resource = await securityService.getByBucketId(body.files[0]!.bucket);
    const urlTtl = resource?.presignedUrlTtl ?? 300;

    const urls = await Promise.all(
      body.files.map(async f => {
        const { provider } = await s3ProviderResolver(f.bucket);
        const url = f.method === 'GET'
          ? await provider.getPresignedUrl(f.bucket, f.key, urlTtl)
          : await provider.putPresignedUrl(f.bucket, f.key, urlTtl);
        return {
          bucket: f.bucket,
          key: f.key,
          url,
          expiresAt: new Date(Date.now() + urlTtl * 1000).toISOString(),
        };
      }),
    );

    return c.json(ok({ urls }));
  });

  // ── GET /api/security/list ──
  app.get('/list', async (c) => {
    const claims = await verifyJwtFromHeader(c);
    const query = ListQuerySchema.parse({
      bucket: c.req.query('bucket'),
      prefix: c.req.query('prefix'),
      limit: c.req.query('limit'),
      continuationToken: c.req.query('continuationToken'),
    });

    const grant = claims.grants.find(g => g.bucket === query.bucket);
    if (!grant) throw new AppError(403, 'FORBIDDEN', `No access to bucket "${query.bucket}"`);
    if (!grant.permissions.includes('list')) {
      throw new AppError(403, 'FORBIDDEN', `No "list" permission on "${query.bucket}"`);
    }

    const { provider } = await s3ProviderResolver(query.bucket);
    const s3Result = await provider.listObjects(query.bucket, {
      ...(query.prefix !== undefined ? { prefix: query.prefix } : {}),
      maxKeys: query.limit ?? 1000,
      ...(query.continuationToken !== undefined ? { continuationToken: query.continuationToken } : {}),
    });

    return c.json(ok({
      files: (s3Result.objects ?? []).map(obj => ({
        key: obj.key,
        size: obj.size,
        lastModified: obj.lastModified,
      })),
      nextContinuationToken: s3Result.nextContinuationToken,
      isTruncated: s3Result.isTruncated ?? false,
    }));
  });

  return app;
}
