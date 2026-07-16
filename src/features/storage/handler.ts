import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { z } from 'zod';
import { AppError } from '../../core/types.ts';
import type { AppContext } from '../../core/deps.ts';
import type { IS3Provider } from '../../core/provider/s3.ts';
import { ListFilesQuerySchema, DiffRequestSchema, PresignForSyncRequestSchema } from './schema.ts';
import { ListFilesResponseSchema, DiffResponseSchema, PresignForSyncResponseSchema } from './response.ts';
import { ok } from '../../core/response.ts';
import { OkResponse } from '../../core/http-docs/response-schema.ts';

type PermChecker = NonNullable<AppContext['permissionChecker']>;

async function requireStoragePerm(
  c: Context<{ Variables: AppContext }>,
  checker: PermChecker | undefined,
  action: string,
  resource: string,
): Promise<void> {
  if (!checker) return;
  const user = c.var.currentUser;
  if (!user) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required');
  const result = await checker.check({ userId: user.id, action, resource });
  if (!result.allowed) throw new AppError(403, 'FORBIDDEN', result.reason);
}

export interface StorageRouterDeps {
  s3ProviderResolver: (bucketId: string) => Promise<{ provider: IS3Provider; bucket: { name: string; endpoint: string; region: string } }>;
  permissionChecker?: PermChecker;
}

export function createStorageRouter(deps: StorageRouterDeps): OpenAPIHono<{ Variables: AppContext }> {
  const { s3ProviderResolver, permissionChecker } = deps;
  const app = new OpenAPIHono<{ Variables: AppContext }>();

  // ── GET /{bucket}/files ──
  app.openapi(createRoute({
    method: 'get',
    path: '/:bucket/files',
    tags: ['storage'],
    request: {
      params: z.object({ bucket: z.string() }),
      query: ListFilesQuerySchema,
    },
    responses: {
      200: { description: 'List files', content: { 'application/json': { schema: OkResponse(ListFilesResponseSchema) } } },
    },
  }), async (c) => {
    const bucket = c.req.param('bucket');
    await requireStoragePerm(c, permissionChecker, 'read', `storage:${bucket}`);

    const query = ListFilesQuerySchema.parse({
      prefix: c.req.query('prefix'),
      limit: c.req.query('limit'),
      continuationToken: c.req.query('continuationToken'),
    });

    const { provider } = await s3ProviderResolver(bucket);
    const result = await provider.listObjects(bucket, {
      ...(query.prefix !== undefined ? { prefix: query.prefix } : {}),
      maxKeys: query.limit ?? 1000,
      ...(query.continuationToken !== undefined ? { continuationToken: query.continuationToken } : {}),
    });

    return c.json(ok({
      files: result.objects.map(obj => ({
        key: obj.key,
        size: obj.size,
        sha256: null,
        lastModified: obj.lastModified,
      })),
      nextContinuationToken: result.nextContinuationToken,
      isTruncated: result.isTruncated ?? false,
    }));
  });

  // ── POST /{bucket}/diff ──
  app.openapi(createRoute({
    method: 'post',
    path: '/:bucket/diff',
    tags: ['storage'],
    request: {
      params: z.object({ bucket: z.string() }),
      body: { content: { 'application/json': { schema: DiffRequestSchema } } },
    },
    responses: {
      200: { description: 'Diff result', content: { 'application/json': { schema: OkResponse(DiffResponseSchema) } } },
    },
  }), async (c) => {
    const bucket = c.req.param('bucket');
    await requireStoragePerm(c, permissionChecker, 'read', `storage:${bucket}`);

    const body = DiffRequestSchema.parse(await c.req.json());

    const { provider } = await s3ProviderResolver(bucket);
    const s3Result = await provider.listObjects(bucket, { maxKeys: 10000 });

    const s3Map = new Map(s3Result.objects.map(obj => [obj.key, { sha256: null as string | null, size: obj.size }]));

    const toUpload: { key: string; sha256: string; size: number }[] = [];
    const unchanged: { key: string }[] = [];
    const orphaned: { key: string }[] = [];

    for (const f of body.files) {
      const remote = s3Map.get(f.key);
      if (!remote || remote.size !== f.size) {
        toUpload.push(f);
      } else {
        unchanged.push({ key: f.key });
      }
      s3Map.delete(f.key);
    }

    for (const [key] of s3Map) {
      orphaned.push({ key });
    }

    return c.json(ok({ toUpload, unchanged, orphaned }));
  });

  // ── POST /{bucket}/presign ──
  app.openapi(createRoute({
    method: 'post',
    path: '/:bucket/presign',
    tags: ['storage'],
    request: {
      params: z.object({ bucket: z.string() }),
      body: { content: { 'application/json': { schema: PresignForSyncRequestSchema } } },
    },
    responses: {
      200: { description: 'Presigned URL', content: { 'application/json': { schema: OkResponse(PresignForSyncResponseSchema) } } },
    },
  }), async (c) => {
    const bucket = c.req.param('bucket');
    const body = PresignForSyncRequestSchema.parse(await c.req.json());

    await requireStoragePerm(c, permissionChecker, 'write', `storage:${bucket}/${body.file.key}`);

    const { provider } = await s3ProviderResolver(bucket);
    const urlTtl = body.ttl ?? 300;
    const url = await provider.putPresignedUrl(bucket, body.file.key, urlTtl);

    const expiresAt = new Date(Date.now() + urlTtl * 1000).toISOString();
    return c.json(ok({
      url,
      bucket,
      key: body.file.key,
      expiresAt,
      headers: {
        'x-amz-meta-sha256': body.file.sha256,
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(body.file.size),
      },
    }));
  });

  // ── DELETE /{bucket}/files/{key} ──
  app.openapi(createRoute({
    method: 'delete',
    path: '/:bucket/files/:key',
    tags: ['storage'],
    request: {
      params: z.object({ bucket: z.string(), key: z.string() }),
    },
    responses: {
      200: { description: 'Deleted', content: { 'application/json': { schema: OkResponse(z.null()) } } },
    },
  }), async (c) => {
    const bucket = c.req.param('bucket');
    const key = c.req.param('key');
    await requireStoragePerm(c, permissionChecker, 'delete', `storage:${bucket}/${key}`);

    const { provider } = await s3ProviderResolver(bucket);
    await provider.deleteObject(bucket, key);

    return c.json(ok(null));
  });

  return app;
}
