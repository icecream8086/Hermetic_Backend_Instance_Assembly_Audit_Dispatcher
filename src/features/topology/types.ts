import type { Platform } from '../../core/region/types.ts';
import type { RegionBucketType } from '../../core/region/bucket.ts';
import type { InstanceCapabilities, InstanceCapacity, InstanceStatus } from '../../core/region/instance.ts';

// ─── Bucket types ───

export interface CreateBucketBody {
  name: string;
  bucketType: RegionBucketType;
  instanceId: string;
}

export interface UpdateBucketBody {
  name?: string | undefined;
  bucketType?: RegionBucketType | undefined;
  instanceId?: string | undefined;
  status?: 'Active' | 'Inactive' | undefined;
}

// ─── Instance types ───

export interface CreateInstanceBody {
  name: string;
  platform: Platform;
  region: string;
  zone: string;
  endpoint: string;
  credentialRef?: string | undefined;
  capabilities?: InstanceCapabilities | undefined;
  capacity?: InstanceCapacity | undefined;
  labels?: Record<string, string> | undefined;
}

export interface UpdateInstanceBody {
  name?: string | undefined;
  endpoint?: string | undefined;
  credentialRef?: string | null | undefined;
  capabilities?: InstanceCapabilities | undefined;
  capacity?: InstanceCapacity | null | undefined;
  status?: InstanceStatus | undefined;
  labels?: Record<string, string> | null | undefined;
}

export interface HeartbeatBody {
  capacity: InstanceCapacity;
  status?: InstanceStatus | undefined;
}

// ─── Credential types ───

export interface CreateCredentialBody {
  name: string;
  platform: Platform;
  accessKeyId: string;
  accessKeySecret: string;
  registryCredentials?: { server: string; userName: string; password: string }[] | undefined;
  instanceId?: string | undefined;
}

export interface UpdateCredentialBody {
  name?: string | undefined;
  accessKeyId?: string | undefined;
  accessKeySecret?: string | undefined;
  registryCredentials?: { server: string; userName: string; password: string }[] | null | undefined;
  instanceId?: string | null | undefined;
  status?: 'active' | 'inactive' | undefined;
}
