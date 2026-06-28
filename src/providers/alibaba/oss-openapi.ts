/**
 * Alibaba Cloud OSS (Object Storage Service) OpenAPI client.
 *
 * API version: 2018-12-01
 * Reference: https://api.aliyun.com/meta/v1/products/Oss/versions/2018-12-01/api-docs.json
 *
 * This is the *management-plane* RPC-style API for OSS (bucket CRUD, policy, ACL,
 * lifecycle, etc.). The data-plane operations (PutObject, GetObject, DeleteObject)
 * use the S3-compatible REST API and are handled separately in oss.ts.
 */

import { rpcCall } from './rpc.ts';
import { z } from 'zod';
import { decStr, decStrOpt } from './eci-codec.ts';

// ─── OSS management API version ───

const API_VERSION = '2018-12-01';

// ─── Type stubs (to be completed from api-docs.json) ───

export interface OssBucket {
  readonly name: string;
  readonly region: string;
  readonly creationDate: string;
  readonly storageClass: string;
  readonly extranetEndpoint: string;
  readonly intranetEndpoint: string;
  readonly acl: string;
}

export interface OssBucketInfo {
  readonly name: string;
  readonly region: string;
  readonly creationDate: string;
  readonly extranetEndpoint: string;
  readonly intranetEndpoint: string;
  readonly owner: { id: string; displayName: string };
  readonly acl: string;
  readonly storageClass: string;
  readonly redundancyType: string;
  readonly versioning?: string;
}

export interface CreateBucketRequest {
  readonly Bucket: string;
  readonly Acl?: string;
  readonly StorageClass?: string;
  readonly DataRedundancyType?: string;
}

export interface ListBucketsResult {
  readonly buckets: readonly OssBucket[];
  readonly isTruncated: boolean;
  readonly marker?: string;
  readonly maxKeys: number;
}

export interface BucketPolicy {
  readonly statements: readonly {
    readonly effect: 'Allow' | 'Deny';
    readonly action: readonly string[];
    readonly resource: readonly string[];
    readonly principal: readonly string[];
    readonly condition?: Record<string, unknown> | undefined;
  }[];
}

// ═══════════════════════════════════════════════════════════════
// Response helpers — Zod fail-fast, no silent defaults
// ═══════════════════════════════════════════════════════════════

const respObjSchema = z.record(z.string(), z.unknown());
const respArrSchema = z.array(z.record(z.string(), z.unknown()));

function respObj(v: unknown): Record<string, unknown> {
  return respObjSchema.parse(v);
}

function respArr(v: unknown): Record<string, unknown>[] {
  return respArrSchema.parse(v);
}

const bucketPolicySchema = z.object({
  statements: z.array(z.object({
    effect: z.enum(['Allow', 'Deny']),
    action: z.array(z.string()),
    resource: z.array(z.string()),
    principal: z.array(z.string()),
    condition: z.record(z.string(), z.unknown()).optional(),
  })),
});

// ═══════════════════════════════════════════════════════════════
// OSS OpenAPI client
// ═══════════════════════════════════════════════════════════════

export class AlibabaOssOpenApiClient {
  public constructor(
    private readonly accessKeyId: string,
    private readonly accessKeySecret: string,
    private readonly endpoint = 'oss.cn-hangzhou.aliyuncs.com',
  ) {}

  /**
   * List all OSS buckets in the account.
   */
  public async listBuckets(params?: { marker?: string; maxKeys?: number }): Promise<ListBucketsResult> {
    const rpcParams: Record<string, string> = {};
    if (params?.marker) rpcParams.marker = params.marker;
    if (params?.maxKeys) rpcParams['max-keys'] = String(params.maxKeys);

    const resp = await rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret, 'ListBuckets', API_VERSION, rpcParams);
    const buckets = respObj(resp.Buckets);
    const bucketArr = respArr(buckets.Bucket);
    const marker = decStrOpt(resp.Marker);
    return {
      buckets: bucketArr.map(mapBucket),
      isTruncated: (decStrOpt(resp.IsTruncated) ?? 'false') === 'true',
      ...(marker ? { marker } : {}),
      maxKeys: Number(resp.MaxKeys ?? 100),
    };
  }

  /**
   * Get detailed info about a specific bucket.
   */
  public async getBucketInfo(bucket: string): Promise<OssBucketInfo | null> {
    try {
      const resp = await rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret, 'GetBucketInfo', API_VERSION, {
        Bucket: bucket,
      });
      const info = respObj(resp.BucketInfo);
      if (Object.keys(info).length === 0) return null;
      const owner = respObj(info.Owner);
      const acl = respObj(info.AccessControlList);
      const versioning = decStrOpt(info.Versioning);
      return {
        name: decStr(info.Name),
        region: decStr(info.Location),
        creationDate: decStr(info.CreationDate),
        extranetEndpoint: decStr(info.ExtranetEndpoint),
        intranetEndpoint: decStr(info.IntranetEndpoint),
        owner: {
          id: decStr(owner.ID),
          displayName: decStr(owner.DisplayName),
        },
        acl: decStr(acl.Grant),
        storageClass: decStrOpt(info.StorageClass) ?? 'Standard',
        redundancyType: decStrOpt(info.DataRedundancyType) ?? 'LRS',
        ...(versioning ? { versioning } : {}),
      };
    } catch {
      return null;
    }
  }

  /**
   * Create a new OSS bucket.
   */
  public async createBucket(request: CreateBucketRequest): Promise<void> {
    const rpcParams: Record<string, string> = { Bucket: request.Bucket };
    if (request.Acl) rpcParams.Acl = request.Acl;
    if (request.StorageClass) rpcParams.StorageClass = request.StorageClass;
    if (request.DataRedundancyType) rpcParams.DataRedundancyType = request.DataRedundancyType;

    await rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret, 'CreateBucket', API_VERSION, rpcParams);
  }

  /**
   * Delete an OSS bucket (must be empty).
   */
  public async deleteBucket(bucket: string): Promise<void> {
    await rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret, 'DeleteBucket', API_VERSION, {
      Bucket: bucket,
    });
  }

  /**
   * Set bucket ACL (private, public-read, public-read-write).
   */
  public async putBucketAcl(bucket: string, acl: string): Promise<void> {
    await rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret, 'PutBucketAcl', API_VERSION, {
      Bucket: bucket,
      Acl: acl,
    });
  }

  /**
   * Get bucket ACL.
   */
  public async getBucketAcl(bucket: string): Promise<string | null> {
    try {
      const resp = await rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret, 'GetBucketAcl', API_VERSION, {
        Bucket: bucket,
      });
      const acl = respObj(resp.AccessControlList);
      return decStrOpt(acl.Grant) ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Set bucket policy (RAM policy JSON).
   */
  public async putBucketPolicy(bucket: string, policy: BucketPolicy): Promise<void> {
    await rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret, 'PutBucketPolicy', API_VERSION, {
      Bucket: bucket,
      Policy: JSON.stringify(policy),
    });
  }

  /**
   * Get bucket policy.
   */
  public async getBucketPolicy(bucket: string): Promise<BucketPolicy | null> {
    try {
      const resp = await rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret, 'GetBucketPolicy', API_VERSION, {
        Bucket: bucket,
      });
      const policyRaw = decStrOpt(resp.Policy);
      if (!policyRaw) return null;
      return bucketPolicySchema.parse(JSON.parse(policyRaw));
    } catch {
      return null;
    }
  }

  /**
   * Delete bucket policy.
   */
  public async deleteBucketPolicy(bucket: string): Promise<void> {
    await rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret, 'DeleteBucketPolicy', API_VERSION, {
      Bucket: bucket,
    });
  }

  /**
   * Enable/disable/suspend bucket versioning.
   */
  public async putBucketVersioning(bucket: string, status: 'Enabled' | 'Suspended'): Promise<void> {
    await rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret, 'PutBucketVersioning', API_VERSION, {
      Bucket: bucket,
      Status: status,
    });
  }

  /**
   * Get bucket versioning status.
   */
  public async getBucketVersioning(bucket: string): Promise<string | null> {
    try {
      const resp = await rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret, 'GetBucketVersioning', API_VERSION, {
        Bucket: bucket,
      });
      return decStrOpt(resp.Status) ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Set bucket lifecycle rules.
   */
  public async putBucketLifecycle(bucket: string, rules: unknown): Promise<void> {
    await rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret, 'PutBucketLifecycle', API_VERSION, {
      Bucket: bucket,
      Lifecycle: JSON.stringify(rules),
    });
  }

  /**
   * Get bucket lifecycle rules.
   */
  public async getBucketLifecycle(bucket: string): Promise<unknown> {
    try {
      const resp = await rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret, 'GetBucketLifecycle', API_VERSION, {
        Bucket: bucket,
      });
      return resp.Rules ?? null;
    } catch {
      return null;
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// Internal helpers
// ═══════════════════════════════════════════════════════════════

function mapBucket(raw: Record<string, unknown>): OssBucket {
  return {
    name: decStr(raw.Name),
    region: decStr(raw.Region),
    creationDate: decStr(raw.CreationDate),
    storageClass: decStrOpt(raw.StorageClass) ?? 'Standard',
    extranetEndpoint: decStr(raw.ExtranetEndpoint),
    intranetEndpoint: decStr(raw.IntranetEndpoint),
    acl: decStrOpt(raw.ACL) ?? 'private',
  };
}
