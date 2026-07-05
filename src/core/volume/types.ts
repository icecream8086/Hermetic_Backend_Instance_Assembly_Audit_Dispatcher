import { z } from 'zod';

// ─── Brand types (CEA: Zod .brand(), no `as` assertions) ───

const volumeIdSchema = z.string().min(1).brand('VolumeId');

export type VolumeId = z.infer<typeof volumeIdSchema>;

export function createVolumeId(raw: string): VolumeId { return volumeIdSchema.parse(raw); }

// ─── Volume state machine ───

export enum VolumeStatus {
  Detached = 'Detached',
  Attached = 'Attached',
  Orphaned = 'Orphaned',
}

// ─── EmptyDir ───

/** EmptyDir storage medium type. Includes only K8s standard values. Platform-specific values (e.g. ECI LocalRaid0) go through providerOverrides. */
export enum EmptyDirMedium {
  /** Default — uses instance system disk. */
  Default = '',
  /** Memory disk — tmpfs, high performance, volatile. */
  Memory = 'Memory',
}

export interface EmptyDirVolumeConfig {
  /** Capacity limit, required. K8s standard field, supports Ki/Mi/Gi suffix. e.g. "512Mi", "1Gi". */
  readonly sizeLimit: string;
  /** Storage medium type. Default is Default (system disk). */
  readonly medium?: EmptyDirMedium | undefined;
}

// ─── Volume ───

export enum VolumeType {
  NFS = 'NFSVolume',
  EmptyDir = 'EmptyDirVolume',
  /** Cloud disk (Alibaba Cloud Disk / EBS) — persistent block storage, single-instance attach. Independent from EmptyDir. */
  Disk = 'DiskVolume',
  /** Secret — inject sensitive data (e.g. passwords, tokens) as in-memory files via provider (podman secret / KMS). */
  Secret = 'SecretVolume',
  /** ConfigMap — inject non-sensitive configuration data as files. */
  ConfigMap = 'ConfigMapVolume',
  /** OSS (Object Storage Service) — mount cloud object storage as a filesystem. */
  OSS = 'OSSVolume',
}

export interface NFSVolumeConfig {
  readonly server: string;
  readonly path: string;
  readonly readOnly: boolean;
}

export interface DiskVolumeConfig {
  /** Cloud disk ID (e.g. Alibaba Cloud disk ID: d-xxxxxxxx). */
  readonly diskId: string;
  /** Filesystem type: 'ext4' | 'xfs'. */
  readonly fsType: string;
  /** Disk size in GiB (for auto-provision). */
  readonly sizeGiB?: number;
  /** Cloud disk category: cloud_efficiency | cloud_ssd | cloud_essd. */
  readonly diskCategory?: string | undefined;
  /** Whether the disk is read-only. */
  readonly readOnly: boolean;
  /** Whether to delete the disk when the instance is released. */
  readonly deleteWithInstance?: boolean;
}

export interface SecretVolumeConfig {
  /** Secret name (provider-resolved). */
  readonly name: string;
  /** Specific items to project as files. Omit to project all keys. */
  readonly items?: readonly { readonly key: string; readonly path: string; readonly mode?: number }[];
}

export interface ConfigMapVolumeConfig {
  /** ConfigMap name (provider-resolved). */
  readonly name: string;
  /** Specific items to project as files. Omit to project all keys. */
  readonly items?: readonly { readonly key: string; readonly path: string; readonly mode?: number }[];
}

export interface OSSVolumeConfig {
  /** OSS bucket name. */
  readonly bucket: string;
  /** Path within the bucket (prefix). */
  readonly path?: string | undefined;
  /** Whether the mount is read-only. */
  readonly readOnly?: boolean | undefined;
  /** Custom OSS endpoint for VPC access. */
  readonly endpoint?: string | undefined;
}

interface Tag {
  readonly key: string;
  readonly value: string;
}

/** Volume entity — bound to a ComputeInstance (spatial locality). */
export interface Volume {
  readonly id: VolumeId;
  readonly name: string;
  readonly description?: string | undefined;
  readonly tags: readonly Tag[];
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly status: VolumeStatus;
  readonly type: VolumeType;
  /** The compute instance this volume is bound to. Required — volumes do not exist outside an instance. */
  readonly instanceId: string;
  /** Reference a named Credential (from CredentialService) for external auth — NFS Kerberos, OSS AK/SK, etc. */
  readonly credentialRef?: string;
  readonly nfs?: NFSVolumeConfig;
  readonly disk?: DiskVolumeConfig;
  readonly emptyDir?: EmptyDirVolumeConfig;
  readonly secret?: SecretVolumeConfig;
  readonly configMap?: ConfigMapVolumeConfig;
  readonly oss?: OSSVolumeConfig;
}

// ─── VolumeMount ───

export interface VolumeMount {
  readonly volumeId: VolumeId;
  readonly mountPath: string;
  readonly readOnly: boolean;
  readonly mountPropagation?: string;
  /** Named credential reference for external auth (e.g. NFS Kerberos, OSS AK/SK). */
  readonly credentialRef?: string | undefined;
}
