// ─── S3-compatible object storage types ───
// Common types shared by all S3 provider implementations.
// Path conventions: S3 and R2 use bucket/key; OSS uses bucket.object path style.
// Each implementation translates to its native format internally.

/** Discriminator for selecting the storage backend. */
export type S3ProviderType = 'aws-s3' | 'alibaba-oss' | 'cloudflare-r2';

export interface S3PutObjectInput {
  readonly bucket: string;
  readonly key: string;
  readonly body: ReadableStream | ArrayBuffer | Uint8Array;
  readonly contentType?: string;
  readonly contentLength?: number;
  readonly cacheControl?: string;
}

export interface S3GetObjectResult {
  readonly body: ReadableStream;
  readonly contentType?: string;
  readonly contentLength?: number;
  readonly etag?: string;
  readonly lastModified?: Date;
}

export interface S3ObjectInfo {
  readonly key: string;
  readonly size: number;
  readonly etag: string;
  readonly lastModified: Date;
  readonly contentType?: string;
}

export interface S3ListObjectsResult {
  readonly objects: readonly S3ObjectInfo[];
  readonly prefix?: string;
  readonly commonPrefixes?: readonly string[];
  readonly isTruncated: boolean;
  readonly nextContinuationToken?: string;
}

export interface S3ProviderConfig {
  /** Valid bucket name for this provider — used for forward/proxy mode when the request doesn't carry a bucket. */
  readonly defaultBucket?: string;
  /** Map logical bucket names to physical names on this backend. */
  readonly bucketNameMapping?: Readonly<Record<string, string>>;
}
