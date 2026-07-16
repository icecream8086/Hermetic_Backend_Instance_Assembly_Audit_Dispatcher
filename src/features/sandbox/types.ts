import type { PodSpec } from '../../core/pod/types.ts';

export interface SandboxStorageAccess {
  readonly token: string;
  readonly expiresAt: string;   // ISO 8601
}

export interface CreateSandboxInput {
  readonly podId: string;
  readonly securityResourceNames: readonly string[];
  readonly spec: PodSpec;
}

export interface Sandbox {
  readonly podId: string;
  readonly storageAccess: SandboxStorageAccess;
  readonly createdAt: string;
}
