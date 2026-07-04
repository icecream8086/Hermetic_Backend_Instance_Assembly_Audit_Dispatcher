import { z } from 'zod';
import type { InstanceId } from '../region/instance.ts';

// ─── Brand types ───

const securityResourceIdSchema = z.string().min(1).brand('SecurityResourceId');
export type SecurityResourceId = z.infer<typeof securityResourceIdSchema>;

export function createSecurityResourceId(raw: string): SecurityResourceId {
  return securityResourceIdSchema.parse(raw);
}

// ─── Status ───

export enum SecurityResourceStatus {
  Active = 'Active',
  Expired = 'Expired',
  Revoked = 'Revoked',
}

// ─── Storage access policy ───

export interface StorageAccessEntry {
  /** Allowed key prefix. Empty string = full bucket. */
  readonly prefix: string;
  /** Allowed operations on this prefix. */
  readonly permissions: readonly ('read' | 'write' | 'list')[];
}

// ─── Entity ───

export interface SecurityResource {
  readonly id: SecurityResourceId;
  readonly name: string;
  /** Associated S3 bucket ID (RegionBucket.id). */
  readonly bucketId: string;
  /** Compute instance ID for provider resolution. */
  readonly instanceId: InstanceId;
  /** JWT token lifetime in seconds. Default 3600 (1h). */
  readonly tokenTtl: number;
  /** On-demand presigned URL lifetime in seconds. Default 300 (5min). */
  readonly presignedUrlTtl: number;
  /** Bucket + key prefix whitelist. */
  readonly accessPolicy: readonly StorageAccessEntry[];
  readonly status: SecurityResourceStatus;
  readonly createdAt: number;
  readonly updatedAt: number;
}

// ─── CRUD inputs ───

export interface CreateSecurityResourceInput {
  readonly name: string;
  readonly bucketId: string;
  readonly instanceId: InstanceId;
  readonly tokenTtl?: number | undefined;
  readonly presignedUrlTtl?: number | undefined;
  readonly accessPolicy?: readonly StorageAccessEntry[] | undefined;
}

export interface UpdateSecurityResourceInput {
  readonly name?: string | undefined;
  readonly tokenTtl?: number | undefined;
  readonly presignedUrlTtl?: number | undefined;
  readonly accessPolicy?: readonly StorageAccessEntry[] | undefined;
  readonly status?: SecurityResourceStatus | undefined;
}

// ─── JWT Claims（签发时使用，不持久化） ───

export interface S3AccessTokenClaims {
  readonly jti: string;
  readonly iss: string;
  readonly sub: string;
  readonly iat: number;
  readonly exp: number;
  readonly grants: readonly {
    readonly bucket: string;
    readonly prefix: string;
    readonly permissions: readonly ('read' | 'write' | 'list')[];
  }[];
}
