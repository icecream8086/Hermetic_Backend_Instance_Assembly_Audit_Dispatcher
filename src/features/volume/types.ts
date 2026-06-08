import type { VolumeType, NFSVolumeConfig, DiskVolumeConfig, SecretVolumeConfig } from '../sandbox/types.ts';

export type { Volume, VolumeMount, VolumeId } from '../sandbox/types.ts';
export { VolumeType, VolumeStatus, createVolumeId } from '../sandbox/types.ts';

export interface CreateVolumeInput {
  readonly name: string;
  readonly description?: string | undefined;
  readonly type: VolumeType;
  readonly instanceId: string;
  readonly credentialRef?: string | undefined;
  readonly nfs?: NFSVolumeConfig | undefined;
  readonly disk?: DiskVolumeConfig | undefined;
  readonly secret?: SecretVolumeConfig | undefined;
}

export interface UpdateVolumeInput {
  readonly name?: string | undefined;
  readonly description?: string | null | undefined;
  readonly instanceId?: string | null | undefined;
  readonly credentialRef?: string | null | undefined;
  readonly nfs?: NFSVolumeConfig | null | undefined;
  readonly disk?: DiskVolumeConfig | null | undefined;
  readonly secret?: SecretVolumeConfig | null | undefined;
}
