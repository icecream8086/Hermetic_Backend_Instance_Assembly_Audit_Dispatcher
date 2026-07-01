import { z } from 'zod';

/** ComputeInstance response schema. */
export const ComputeInstanceSchema = z.object({
  id: z.string(),
  name: z.string(),
  platform: z.string(),
  region: z.string(),
  zone: z.string(),
  endpoint: z.string(),
  credentialRef: z.string().optional(),
  capabilities: z.object({
    container: z.boolean().optional(),
    image: z.boolean().optional(),
    group: z.boolean().optional(),
    metrics: z.boolean().optional(),
    dns: z.boolean().optional(),
    network: z.boolean().optional(),
    s3: z.boolean().optional(),
  }),
  capacity: z.object({
    cpu: z.number().optional(),
    memory: z.number().optional(),
    maxPodCount: z.number().optional(),
  }).optional(),
  status: z.enum(['online', 'offline', 'error']),
  labels: z.record(z.string(), z.string()).optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

/** RegionBucket response schema. */
export const RegionBucketSchema = z.object({
  id: z.string(),
  name: z.string(),
  platform: z.string(),
  region: z.string(),
  endpoint: z.string(),
  bucketType: z.enum(['aws-s3', 'alibaba-oss', 'cloudflare-r2', 'minio']),
  credentialRef: z.string(),
  instanceId: z.string(),
  status: z.enum(['Active', 'Inactive']),
  autoGenerateKeys: z.boolean().optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

/** MaskedCredential response schema (secrets masked). */
export const MaskedCredentialSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.string(),
  platform: z.string(),
  accessKeyId: z.string().optional(),
  accessKeySecret: z.string().optional(),
  token: z.string().optional(),
  username: z.string().optional(),
  password: z.string().optional(),
  registryCredentials: z.array(z.object({
    server: z.string(),
    userName: z.string(),
    password: z.string(),
  })).readonly().optional(),
  instanceId: z.string().optional(),
  status: z.enum(['active', 'inactive']),
  createdAt: z.number(),
  updatedAt: z.number(),
});

/** ImageRepository response schema. */
export const ImageRepositorySchema = z.object({
  id: z.string(),
  name: z.string(),
  platform: z.string(),
  region: z.string(),
  endpoint: z.string(),
  instanceId: z.string(),
  image: z.string(),
  registryCredential: z.object({
    server: z.string(),
    userName: z.string(),
    password: z.string(),
  }).optional(),
  credentialRef: z.string().optional(),
  clusterId: z.string().optional(),
  status: z.enum(['active', 'inactive']),
  createdAt: z.number(),
  updatedAt: z.number(),
});

/** S3Policy response schema. */
export const S3PolicySchema = z.object({
  id: z.string(),
  bucketId: z.string(),
  name: z.string(),
  description: z.string().optional(),
  effect: z.enum(['Allow', 'Deny']),
  actions: z.array(z.string()).readonly(),
  pathPrefix: z.string(),
  applyToAutoKeys: z.boolean(),
  priority: z.number(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

/** Pull task response schema. */
export const PullTaskSchema = z.object({
  id: z.string(),
  repositoryId: z.string(),
  image: z.string(),
  status: z.string(),
  createdAt: z.number(),
});

/** S3 multipart upload session response. */
export const S3MultipartUploadSessionSchema = z.object({
  uploadId: z.string(),
  bucket: z.string(),
  key: z.string(),
  presignedUrls: z.array(z.object({
    partNumber: z.number(),
    url: z.string(),
  })).readonly(),
  partSize: z.number(),
  expiresIn: z.number(),
});

/** S3 multipart download session response. */
export const S3MultipartDownloadSessionSchema = z.object({
  bucket: z.string(),
  key: z.string(),
  size: z.number(),
  presignedUrls: z.array(z.object({
    partNumber: z.number(),
    url: z.string(),
    range: z.string().optional(),
  })).readonly(),
});

/** S3 multipart complete result. */
export const S3MultipartCompleteResultSchema = z.object({
  location: z.string().optional(),
});

/** S3 list parts result. */
export const S3ListPartsResultSchema = z.object({
  parts: z.array(z.object({
    partNumber: z.number(),
    size: z.number(),
    etag: z.string(),
  })).readonly(),
  uploadId: z.string(),
  isTruncated: z.boolean(),
  nextPartNumberMarker: z.number().optional(),
});

/** Region list response item. */
export const AlibabaRegionSchema = z.string();
export const AwsRegionSchema = z.string();
export const PodmanRegionSchema = z.string();
