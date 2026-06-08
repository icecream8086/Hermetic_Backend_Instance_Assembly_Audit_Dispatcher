export type ContainerSecretType = 'inline' | 'upload';

export interface ContainerSecret {
  readonly id: string;
  readonly name: string;
  readonly type: ContainerSecretType;
  readonly description?: string | undefined;
  /** Inline: encrypted value (AES-GCM). Plaintext only in memory after decrypt. */
  readonly value?: string | undefined;
  /** Upload: blob key in IBlobStore. */
  readonly blobKey?: string | undefined;
  readonly filename?: string | undefined;
  readonly mimeType?: string | undefined;
  readonly size?: number | undefined;
  readonly status: 'active' | 'inactive';
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface CreateContainerSecretInput {
  readonly name: string;
  readonly description?: string | undefined;
  readonly type: ContainerSecretType;
  /** Required for inline type. */
  readonly value?: string | undefined;
  readonly status?: 'active' | 'inactive' | undefined;
}

export interface UpdateContainerSecretInput {
  readonly name?: string | undefined;
  readonly description?: string | null | undefined;
  readonly value?: string | null | undefined;
  readonly status?: 'active' | 'inactive' | undefined;
}
