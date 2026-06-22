/**
 * Alibaba Cloud OSS (Object Storage Service) OpenAPI client.
 *
 * API version: 2018-12-01
 * Reference: https://api.aliyun.com/meta/v1/products/Oss/versions/2018-12-01/api-docs.json
 *
 * This is the *management-plane* RPC-style API for OSS (bucket CRUD, policy, ACL,
 * lifecycle, etc.). The data-plane operations (PutObject, GetObject, DeleteObject)
 * use the S3-compatible REST API and are handled separately in oss.ts.
 *
 * TODO: Full API spec requires Alibaba Cloud account to fetch from the meta endpoint.
 *       Fill in parameter/response types once api-docs.json is available.
 */

import { rpcCall } from './rpc.ts';

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
    readonly condition?: Record<string, unknown>;
  }[];
}

// ─── OSS OpenAPI client ───

export class AlibabaOssOpenApiClient {
  constructor(
    private readonly accessKeyId: string,
    private readonly accessKeySecret: string,
    private readonly endpoint = 'oss.cn-hangzhou.aliyuncs.com',
  ) {}

  /**
   * List all OSS buckets in the account.
   * TODO: fill in pagination params (marker, max-keys) from api-docs.json
   */
  async listBuckets(params?: { marker?: string; maxKeys?: number }): Promise<ListBucketsResult> {
    const rpcParams: Record<string, string> = {};
    if (params?.marker) rpcParams['marker'] = params.marker;
    if (params?.maxKeys) rpcParams['max-keys'] = String(params.maxKeys);

    const resp = await rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret, 'ListBuckets', API_VERSION, rpcParams);
    return {
      buckets: (resp.Buckets?.Bucket ?? []).map(mapBucket),
      isTruncated: resp.IsTruncated === 'true',
      marker: resp.Marker,
      maxKeys: Number(resp.MaxKeys ?? 100),
    };
  }

  /**
   * Get detailed info about a specific bucket.
   */
  async getBucketInfo(bucket: string): Promise<OssBucketInfo | null> {
    try {
      const resp = await rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret, 'GetBucketInfo', API_VERSION, {
        Bucket: bucket,
      });
      const info = resp.BucketInfo;
      if (!info) return null;
      return {
        name: info.Name ?? '',
        region: info.Location ?? '',
        creationDate: info.CreationDate ?? '',
        extranetEndpoint: info.ExtranetEndpoint ?? '',
        intranetEndpoint: info.IntranetEndpoint ?? '',
        owner: {
          id: info.Owner?.ID ?? '',
          displayName: info.Owner?.DisplayName ?? '',
        },
        acl: info.AccessControlList?.Grant ?? 'private',
        storageClass: info.StorageClass ?? 'Standard',
        redundancyType: info.DataRedundancyType ?? 'LRS',
        versioning: info.Versioning,
      };
    } catch {
      return null;
    }
  }

  /**
   * Create a new OSS bucket.
   */
  async createBucket(request: CreateBucketRequest): Promise<void> {
    const rpcParams: Record<string, string> = { Bucket: request.Bucket };
    if (request.Acl) rpcParams['Acl'] = request.Acl;
    if (request.StorageClass) rpcParams['StorageClass'] = request.StorageClass;
    if (request.DataRedundancyType) rpcParams['DataRedundancyType'] = request.DataRedundancyType;

    await rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret, 'CreateBucket', API_VERSION, rpcParams);
  }

  /**
   * Delete an OSS bucket (must be empty).
   */
  async deleteBucket(bucket: string): Promise<void> {
    await rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret, 'DeleteBucket', API_VERSION, {
      Bucket: bucket,
    });
  }

  /**
   * Set bucket ACL (private, public-read, public-read-write).
   */
  async putBucketAcl(bucket: string, acl: string): Promise<void> {
    await rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret, 'PutBucketAcl', API_VERSION, {
      Bucket: bucket,
      Acl: acl,
    });
  }

  /**
   * Get bucket ACL.
   */
  async getBucketAcl(bucket: string): Promise<string | null> {
    try {
      const resp = await rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret, 'GetBucketAcl', API_VERSION, {
        Bucket: bucket,
      });
      return resp.AccessControlList?.Grant ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Set bucket policy (RAM policy JSON).
   */
  async putBucketPolicy(bucket: string, policy: BucketPolicy): Promise<void> {
    await rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret, 'PutBucketPolicy', API_VERSION, {
      Bucket: bucket,
      Policy: JSON.stringify(policy),
    });
  }

  /**
   * Get bucket policy.
   */
  async getBucketPolicy(bucket: string): Promise<BucketPolicy | null> {
    try {
      const resp = await rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret, 'GetBucketPolicy', API_VERSION, {
        Bucket: bucket,
      });
      return resp.Policy ? JSON.parse(resp.Policy) : null;
    } catch {
      return null;
    }
  }

  /**
   * Delete bucket policy.
   */
  async deleteBucketPolicy(bucket: string): Promise<void> {
    await rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret, 'DeleteBucketPolicy', API_VERSION, {
      Bucket: bucket,
    });
  }

  /**
   * Enable/disable/suspend bucket versioning.
   */
  async putBucketVersioning(bucket: string, status: 'Enabled' | 'Suspended'): Promise<void> {
    await rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret, 'PutBucketVersioning', API_VERSION, {
      Bucket: bucket,
      Status: status,
    });
  }

  /**
   * Get bucket versioning status.
   */
  async getBucketVersioning(bucket: string): Promise<string | null> {
    try {
      const resp = await rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret, 'GetBucketVersioning', API_VERSION, {
        Bucket: bucket,
      });
      return resp.Status ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Set bucket lifecycle rules.
   */
  async putBucketLifecycle(bucket: string, rules: unknown): Promise<void> {
    await rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret, 'PutBucketLifecycle', API_VERSION, {
      Bucket: bucket,
      Lifecycle: JSON.stringify(rules),
    });
  }

  /**
   * Get bucket lifecycle rules.
   */
  async getBucketLifecycle(bucket: string): Promise<unknown | null> {
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

// ─── Internal helpers ───

function mapBucket(raw: any): OssBucket {
  return {
    name: raw.Name ?? '',
    region: raw.Region ?? '',
    creationDate: raw.CreationDate ?? '',
    storageClass: raw.StorageClass ?? 'Standard',
    extranetEndpoint: raw.ExtranetEndpoint ?? '',
    intranetEndpoint: raw.IntranetEndpoint ?? '',
    acl: raw.ACL ?? 'private',
  };
}
