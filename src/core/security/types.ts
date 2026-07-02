import { z } from 'zod';
import type { InstanceId } from '../region/instance.ts';

// ─── Brand types ───

const securityResourceIdSchema = z.string().min(1).brand('SecurityResourceId');
export type SecurityResourceId = z.infer<typeof securityResourceIdSchema>;

export function createSecurityResourceId(raw: string): SecurityResourceId {
  return securityResourceIdSchema.parse(raw);
}

// ─── Presigned URL set ───

/**
 * 一组预签名 URL。由 SecurityResourceService 自动刷新。
 *
 * 多对象读取（后续）：容器用 listUrl 列举 → 调 Worker API
 *   GET /api/security/{id}/presign?key={objectKey}&method=GET
 * 按需获取单对象 presigned GET URL。
 */
export interface PresignedUrlSet {
  /** 预签名 PUT URL（写入对象）。 */
  readonly putUrl: string;
  /** 列举 bucket 内对象的 URL。bucket-level，不需要绑定具体 key。 */
  readonly listUrl: string;
  /** S3 endpoint。 */
  readonly endpoint: string;
  /** Bucket 名称。 */
  readonly bucket: string;
  /** Bucket 所在 region。 */
  readonly region: string;
  /** URL 过期时间（ISO 8601）。 */
  readonly expiresAt: string;
}

// ─── Status ───

export enum SecurityResourceStatus {
  Active = 'Active',
  Expired = 'Expired',
  Revoked = 'Revoked',
}

// ─── Entity ───

export interface SecurityResource {
  readonly id: SecurityResourceId;
  readonly name: string;
  /** 关联的 S3 存储桶 ID（RegionBucket.id）。 */
  readonly bucketId: string;
  /** 计算实例 ID，用于确定 platform + 解析 S3 provider。 */
  readonly instanceId: InstanceId;
  /** 预签名 URL 有效时长（秒）。默认 3600（1h）。 */
  readonly validDuration: number;
  /** 剩余有效期低于此阈值时触发自动刷新（秒）。默认 900（15min）。 */
  readonly refreshThreshold: number;
  /** 当前状态。 */
  readonly status: SecurityResourceStatus;
  /** 当前的预签名 URL 组。刷新时整体替换。 */
  readonly value: PresignedUrlSet;
  readonly createdAt: number;
  readonly updatedAt: number;
}

// ─── CRUD inputs ───

export interface CreateSecurityResourceInput {
  readonly name: string;
  readonly bucketId: string;
  readonly instanceId: InstanceId;
  readonly validDuration?: number | undefined;      // 默认 3600
  readonly refreshThreshold?: number | undefined;   // 默认 900
}

export interface UpdateSecurityResourceInput {
  readonly name?: string | undefined;
  readonly validDuration?: number | undefined;
  readonly refreshThreshold?: number | undefined;
  readonly status?: SecurityResourceStatus | undefined;
}
