// ─── IS3Provider — S3-compatible object storage abstraction ───
//
// Each implementation handles its own:
// - Auth scheme (SigV4 for S3/R2, OSS HMAC-SHA1 for Alibaba)
// - Path convention (bucket/key vs virtual-hosted style)
// - Endpoint resolution
//
// Design invariants:
// - All inputs use logical bucket + key (provider-neutral)
// - Implementation translates internally (bucket mapping, path style, auth)
// - Provider type is opaque to callers — no branching on provider identity

import type {
  S3PutObjectInput,
  S3GetObjectResult,
  S3ObjectInfo,
  S3ListObjectsResult,
  S3ProviderType,
} from './s3-types.ts';

export type { S3PutObjectInput, S3GetObjectResult, S3ObjectInfo, S3ListObjectsResult, S3ProviderType };

export interface IS3Provider {
  /** The backend type discriminator. */
  readonly type: S3ProviderType;

  /** Write an object. Returns the ETag. */
  putObject(input: S3PutObjectInput): Promise<{ etag: string }>;

  /** Read an object. Returns null if not found. */
  getObject(bucket: string, key: string): Promise<S3GetObjectResult | null>;

  /** Delete an object. No-op if the key does not exist. */
  deleteObject(bucket: string, key: string): Promise<void>;

  /** Get object metadata without downloading the body. Returns null if not found. */
  headObject(bucket: string, key: string): Promise<S3ObjectInfo | null>;

  /** List objects with optional prefix/delimiter. */
  listObjects(
    bucket: string,
    options?: {
      readonly prefix?: string;
      readonly delimiter?: string;
      readonly maxKeys?: number;
      readonly continuationToken?: string;
    },
  ): Promise<S3ListObjectsResult>;

  /** Generate a presigned GET URL. */
  getPresignedUrl?(bucket: string, key: string, expiresInSeconds?: number): Promise<string>;

  /** Generate a presigned PUT URL. */
  putPresignedUrl?(bucket: string, key: string, expiresInSeconds?: number): Promise<string>;
}
