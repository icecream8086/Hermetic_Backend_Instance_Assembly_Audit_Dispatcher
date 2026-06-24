export type ContainerSecretType = 'inline' | 'upload';
/** Secret visibility scope — GitHub Secret model. */
export type SecretVisibility = 'all' | 'private' | 'selected';
/** Encryption key type used. */
export type SecretKeyType = 'aes-gcm' | 'sealed-box';

export interface ContainerSecret {
  readonly id: string;
  readonly name: string;
  readonly type: ContainerSecretType;
  readonly description?: string | undefined;
  /** Inline: encrypted value (AES-GCM or SealedBox). Plaintext only in memory after decrypt. */
  readonly value?: string | undefined;
  /** Upload: blob key in IBlobStore. */
  readonly blobKey?: string | undefined;
  readonly filename?: string | undefined;
  readonly mimeType?: string | undefined;
  readonly size?: number | undefined;
  readonly status: 'active' | 'inactive';
  // ── GitHub Secret model ──
  /** Visibility scope. */
  readonly visibility: SecretVisibility;
  /** When visibility='selected', the list of scope IDs that can access. */
  readonly selectedScopeIds: string[];
  /** Encryption key type used for this secret's value. */
  readonly keyType: SecretKeyType;
  /** Monotonic version counter — increments on each update. */
  readonly version: number;
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
  readonly visibility?: SecretVisibility | undefined;
  readonly selectedScopeIds?: string[] | undefined;
  readonly keyType?: SecretKeyType | undefined;
}

export interface UpdateContainerSecretInput {
  readonly name?: string | undefined;
  readonly description?: string | null | undefined;
  readonly value?: string | null | undefined;
  readonly status?: 'active' | 'inactive' | undefined;
  readonly visibility?: SecretVisibility | undefined;
  readonly selectedScopeIds?: string[] | null | undefined;
}
