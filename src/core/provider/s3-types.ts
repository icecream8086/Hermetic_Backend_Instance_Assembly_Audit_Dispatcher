// ─── S3-compatible object storage types ───
// Common types shared by all S3 provider implementations.
// Path conventions: S3 and R2 use bucket/key; OSS uses bucket.object path style.
// Each implementation translates to its native format internally.

/** Discriminator for selecting the storage backend. */
export type S3ProviderType = 'aws-s3' | 'alibaba-oss' | 'cloudflare-r2' | 'minio';

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

// ─── Multi-part upload types ───

export interface S3CreateMultipartUploadInput {
  readonly bucket: string;
  readonly key: string;
  readonly contentType?: string;
}

export interface S3CreateMultipartUploadResult {
  readonly uploadId: string;
  readonly key: string;
  readonly bucket: string;
}

export interface S3UploadPartInput {
  readonly bucket: string;
  readonly key: string;
  readonly uploadId: string;
  readonly partNumber: number;
}

export interface S3UploadPartResult {
  readonly etag: string;
  readonly partNumber: number;
}

export interface S3CompleteMultipartUploadInput {
  readonly bucket: string;
  readonly key: string;
  readonly uploadId: string;
  readonly parts: ReadonlyArray<{ readonly partNumber: number; readonly etag: string }>;
}

export interface S3AbortMultipartUploadInput {
  readonly bucket: string;
  readonly key: string;
  readonly uploadId: string;
}

export interface S3ListPartsResult {
  readonly parts: ReadonlyArray<{ readonly partNumber: number; readonly size: number; readonly etag: string }>;
  readonly uploadId: string;
  readonly isTruncated: boolean;
  readonly nextPartNumberMarker?: number;
}

// ─── Client-facing multipart orchestration types ───

export interface S3PresignedPartUrl {
  readonly partNumber: number;
  readonly url: string;
  readonly range?: string;
}

export interface S3MultipartUploadSession {
  readonly uploadId: string;
  readonly bucket: string;
  readonly key: string;
  readonly presignedUrls: ReadonlyArray<S3PresignedPartUrl>;
  readonly partSize: number;
  readonly expiresIn: number;
}

export interface S3MultipartDownloadSession {
  readonly bucket: string;
  readonly key: string;
  readonly size: number;
  readonly presignedUrls: ReadonlyArray<S3PresignedPartUrl>;
}
