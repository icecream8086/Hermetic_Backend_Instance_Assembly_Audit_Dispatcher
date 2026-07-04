export type ContainerSecretType = 'inline' | 'upload' | 'platformRef';
/** Secret visibility scope — GitHub Secret model. */
export type SecretVisibility = 'all' | 'private' | 'selected';
/** Encryption key type used. */
export type SecretKeyType = 'aes-gcm' | 'sealed-box';

/** 当 type='platformRef' 时，各平台的原生 secret 名称映射。Provisioner 写入，Codec 只读。 */
export interface PlatformSecretRefs {
  /** ECI K8s Secret 名。ECI 独立用户始终 undefined（不支持引用）。 */
  readonly eci?: string | undefined;
  /** K8s Secret name。 */
  readonly k8s?: string | undefined;
  /** Podman secret name。 */
  readonly podman?: string | undefined;
  /** AWS Secrets Manager ARN。 */
  readonly aws?: string | undefined;
}

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
  /** 当 type='platformRef': 各平台的原生 secret 名称。Provisioner 写入，Codec 只读。 */
  readonly platformRefs?: PlatformSecretRefs | undefined;
  // ── GitHub Secret model ──
  /** Visibility scope. */
  readonly visibility: SecretVisibility;
  /** When visibility='selected', the list of scope IDs that can access. */
  readonly selectedScopeIds: string[];
  /** Encryption key type used for this secret's value. */
  readonly keyType: SecretKeyType;
  /** When keyType='sealed-box', the userId whose public key was used to seal. */
  readonly sealedForUserId?: string | undefined;
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
  readonly platformRefs?: PlatformSecretRefs | undefined;
  readonly visibility?: SecretVisibility | undefined;
  readonly selectedScopeIds?: string[] | undefined;
  readonly keyType?: SecretKeyType | undefined;
  /** When keyType='sealed-box', seal for this userId's public key. */
  readonly sealForUserId?: string | undefined;
}

export interface UpdateContainerSecretInput {
  readonly name?: string | undefined;
  readonly description?: string | null | undefined;
  readonly value?: string | null | undefined;
  readonly status?: 'active' | 'inactive' | undefined;
  readonly visibility?: SecretVisibility | undefined;
  readonly selectedScopeIds?: string[] | null | undefined;
  readonly platformRefs?: PlatformSecretRefs | undefined;
}
