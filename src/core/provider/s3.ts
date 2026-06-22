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
  S3CreateMultipartUploadInput,
  S3CreateMultipartUploadResult,
  S3UploadPartInput,
  S3UploadPartResult,
  S3CompleteMultipartUploadInput,
  S3AbortMultipartUploadInput,
  S3ListPartsResult,
} from './s3-types.ts';

export type {
  S3PutObjectInput, S3GetObjectResult, S3ObjectInfo, S3ListObjectsResult, S3ProviderType,
  S3CreateMultipartUploadInput, S3CreateMultipartUploadResult,
  S3UploadPartInput, S3UploadPartResult,
  S3CompleteMultipartUploadInput, S3AbortMultipartUploadInput, S3ListPartsResult,
};

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

  // ─── Multi-part upload (optional — providers signal support by implementing) ───

  /** Initiate a multipart upload session. Returns the uploadId. */
  createMultipartUpload?(input: S3CreateMultipartUploadInput): Promise<S3CreateMultipartUploadResult>;

  /** Upload a single part. Returns the ETag for that part. */
  uploadPart?(input: S3UploadPartInput, body: Uint8Array): Promise<S3UploadPartResult>;

  /** Complete a multipart upload by providing the ordered list of part ETags. */
  completeMultipartUpload?(input: S3CompleteMultipartUploadInput): Promise<{ location?: string }>;

  /** Abort an in-progress multipart upload. */
  abortMultipartUpload?(input: S3AbortMultipartUploadInput): Promise<void>;

  /** List uploaded parts for an in-progress upload. */
  listParts?(bucket: string, key: string, uploadId: string): Promise<S3ListPartsResult>;
}
