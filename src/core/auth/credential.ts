import type { IAtomicStore } from '../store/interfaces.ts';
import type { Platform } from '../region/types.ts';
import { AppError } from '../types.ts';
import { SecretEncryption } from './secret-encryption.ts';

// ─── Credential type ───

export type CredentialType = 'aksk' | 'token' | 'password';

// ─── Brand type ───

declare const CREDENTIAL_ID_BRAND: unique symbol;
export type CredentialId = string & { readonly [CREDENTIAL_ID_BRAND]: true };

export function generateCredentialId(): CredentialId {
  return `cred_${crypto.randomUUID()}` as CredentialId;
}

// ─── Entity ───

export interface RegistryCredential {
  readonly server: string;
  readonly userName: string;
  readonly password: string;
}

export interface ManagedCredential {
  readonly id: CredentialId;
  readonly name: string;
  readonly type: CredentialType;
  readonly platform: Platform;
  /** aksk: access key */
  readonly accessKeyId?: string | undefined;
  /** aksk: access secret */
  readonly accessKeySecret?: string | undefined;
  /** token: single bearer/API token */
  readonly token?: string | undefined;
  /** password: login username */
  readonly username?: string | undefined;
  /** password: login password */
  readonly password?: string | undefined;
  /** registry mirror credentials */
  readonly registryCredentials?: readonly RegistryCredential[] | undefined;
  readonly instanceId?: string | undefined;
  readonly status: 'active' | 'inactive';
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** 对外展示的凭证（secret masked）。读接口统一用此类型。 */
export interface MaskedCredential {
  readonly id: CredentialId;
  readonly name: string;
  readonly type: CredentialType;
  readonly platform: Platform;
  readonly accessKeyId?: string | undefined;
  readonly accessKeySecret?: string | undefined; // masked
  readonly token?: string | undefined;           // masked
  readonly username?: string | undefined;
  readonly password?: string | undefined;         // masked
  readonly registryCredentials?: readonly RegistryCredential[] | undefined;
  readonly instanceId?: string | undefined;
  readonly status: 'active' | 'inactive';
  readonly createdAt: number;
  readonly updatedAt: number;
}

export function maskSecret(secret: string): string {
  return secret.slice(0, 6) + '***';
}

export function toMasked(cred: ManagedCredential): MaskedCredential {
  const masked: MaskedCredential = {
    id: cred.id,
    name: cred.name,
    type: cred.type,
    platform: cred.platform,
    ...(cred.accessKeyId ? { accessKeyId: cred.accessKeyId } : {}),
    ...(cred.accessKeySecret ? { accessKeySecret: maskSecret(cred.accessKeySecret) } : {}),
    ...(cred.token ? { token: maskSecret(cred.token) } : {}),
    ...(cred.username ? { username: cred.username } : {}),
    ...(cred.password ? { password: maskSecret(cred.password) } : {}),
    ...(cred.registryCredentials?.length ? { registryCredentials: cred.registryCredentials.map(rc => ({ ...rc, password: maskSecret(rc.password) })) } : {}),
    ...(cred.instanceId ? { instanceId: cred.instanceId } : {}),
    status: cred.status,
    createdAt: cred.createdAt,
    updatedAt: cred.updatedAt,
  };
  return masked;
}

export interface CreateCredentialInput {
  name: string;
  type: CredentialType;
  platform: Platform;
  accessKeyId?: string | undefined;
  accessKeySecret?: string | undefined;
  token?: string | undefined;
  username?: string | undefined;
  password?: string | undefined;
  registryCredentials?: RegistryCredential[] | undefined;
  instanceId?: string | undefined;
}

export interface UpdateCredentialInput {
  name?: string | undefined;
  type?: CredentialType | undefined;
  accessKeyId?: string | undefined;
  accessKeySecret?: string | undefined;
  token?: string | undefined;
  username?: string | undefined;
  password?: string | undefined;
  registryCredentials?: RegistryCredential[] | null | undefined;
  instanceId?: string | null | undefined;
  status?: 'active' | 'inactive' | undefined;
}

// ─── Constants ───

const PREFIX = 'cred:';
const INDEX_KEY = 'cred:ids';

// ─── Service ───

export class CredentialService {
  constructor(
    private readonly atomic: IAtomicStore,
    private readonly encryption?: SecretEncryption,
  ) {}

  /** Encrypt sensitive fields before storage. */
  async #encryptFields(cred: ManagedCredential): Promise<ManagedCredential> {
    const enc = this.encryption;
    if (!enc) return cred;
    return {
      ...cred,
      ...(cred.accessKeySecret ? { accessKeySecret: await enc.encrypt(cred.accessKeySecret) } : {}),
      ...(cred.token ? { token: await enc.encrypt(cred.token) } : {}),
      ...(cred.password ? { password: await enc.encrypt(cred.password) } : {}),
      ...(cred.registryCredentials?.length ? {
        registryCredentials: await Promise.all(cred.registryCredentials.map(async rc => ({
          ...rc,
          password: await enc.encrypt(rc.password),
        }))),
      } : {}),
    };
  }

  /** Decrypt sensitive fields after read.  Plaintext fields pass through. */
  async #decryptFields(cred: ManagedCredential): Promise<ManagedCredential> {
    const enc = this.encryption;
    if (!enc) return cred;
    return {
      ...cred,
      ...(cred.accessKeySecret ? { accessKeySecret: await enc.decrypt(cred.accessKeySecret) } : {}),
      ...(cred.token ? { token: await enc.decrypt(cred.token) } : {}),
      ...(cred.password ? { password: await enc.decrypt(cred.password) } : {}),
      ...(cred.registryCredentials?.length ? {
        registryCredentials: await Promise.all(cred.registryCredentials.map(async rc => ({
          ...rc,
          password: await enc.decrypt(rc.password),
        }))),
      } : {}),
    };
  }

  async create(input: CreateCredentialInput): Promise<ManagedCredential> {
    const id = generateCredentialId();
    const now = Date.now();

    const cred: ManagedCredential = {
      id,
      name: input.name,
      type: input.type,
      platform: input.platform,
      ...(input.accessKeyId ? { accessKeyId: input.accessKeyId } : {}),
      ...(input.accessKeySecret ? { accessKeySecret: input.accessKeySecret } : {}),
      ...(input.token ? { token: input.token } : {}),
      ...(input.username ? { username: input.username } : {}),
      ...(input.password ? { password: input.password } : {}),
      ...(input.registryCredentials?.length ? { registryCredentials: [...input.registryCredentials] } : {}),
      ...(input.instanceId ? { instanceId: input.instanceId } : {}),
      status: 'active',
      createdAt: now,
      updatedAt: now,
    };

    const toStore = await this.#encryptFields(cred);
    await this.atomic.set(PREFIX + id, toStore, null);
    await this.#addToIndex(id);
    return cred; // return plaintext
  }

  async get(id: CredentialId): Promise<ManagedCredential | null> {
    const entry = await this.atomic.get<ManagedCredential>(PREFIX + id);
    if (!entry) return null;
    return this.#decryptFields(entry.value);
  }

  /** 按 name 查找凭证（provider resolver 用）。可传 instanceId 精确匹配。 */
  async findByName(name: string, instanceId?: string): Promise<ManagedCredential | null> {
    const all = await this.#listAll();
    const decrypted = await Promise.all(all.map(c => this.#decryptFields(c)));
    // 先找 name + instanceId 精确匹配
    if (instanceId) {
      const matched = decrypted.find(c => c.name === name && c.instanceId === instanceId);
      if (matched) return matched;
    }
    // 回退到仅 name 匹配
    return decrypted.find(c => c.name === name) ?? null;
  }

  async list(filter?: { platform?: string | undefined }): Promise<ManagedCredential[]> {
    const all = await this.#listAll();
    const decrypted = await Promise.all(all.map(c => this.#decryptFields(c)));
    if (!filter?.platform) return decrypted;
    return decrypted.filter(c => c.platform === filter.platform);
  }

  async update(id: CredentialId, input: UpdateCredentialInput): Promise<ManagedCredential> {
    const entry = await this.atomic.get<ManagedCredential>(PREFIX + id);
    if (!entry) throw new AppError(404, 'CREDENTIAL_NOT_FOUND', 'Credential not found');

    // Decrypt existing so merge + re-encrypt stays consistent
    const existing = await this.#decryptFields(entry.value);

    const updated: ManagedCredential = {
      ...existing,
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.type !== undefined ? { type: input.type } : {}),
      ...(input.accessKeyId !== undefined ? { accessKeyId: input.accessKeyId } : {}),
      ...(input.accessKeySecret !== undefined ? { accessKeySecret: input.accessKeySecret } : {}),
      ...(input.token !== undefined ? { token: input.token } : {}),
      ...(input.username !== undefined ? { username: input.username } : {}),
      ...(input.password !== undefined ? { password: input.password } : {}),
      ...(input.registryCredentials !== undefined ? { registryCredentials: input.registryCredentials ?? undefined } : {}),
      ...(input.instanceId !== undefined ? { instanceId: input.instanceId ?? undefined } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      updatedAt: Date.now(),
    };

    const toStore = await this.#encryptFields(updated);
    const newVersion = await this.atomic.set(PREFIX + id, toStore, entry.version);
    if (!newVersion) throw new AppError(409, 'CONFLICT', 'Concurrent modification detected');
    return updated; // plaintext
  }

  async delete(id: CredentialId): Promise<void> {
    const entry = await this.atomic.get<ManagedCredential>(PREFIX + id);
    if (!entry) throw new AppError(404, 'CREDENTIAL_NOT_FOUND', 'Credential not found');
    await this.atomic.set(PREFIX + id, null, entry.version);
    await this.#removeFromIndex(id);
  }

  // ─── Internal ───

  async #listAll(): Promise<ManagedCredential[]> {
    const idx = await this.atomic.get<string[]>(INDEX_KEY);
    if (!idx) return [];
    const entries = await Promise.all(idx.value.map(id => this.atomic.get<ManagedCredential>(PREFIX + id)));
    return entries.filter(e => e).map(e => e!.value);
  }

  async #addToIndex(id: CredentialId): Promise<void> {
    const idx = await this.atomic.get<string[]>(INDEX_KEY);
    await this.atomic.set(INDEX_KEY, [...(idx?.value ?? []), id], idx?.version ?? null);
  }

  async #removeFromIndex(id: CredentialId): Promise<void> {
    const idx = await this.atomic.get<string[]>(INDEX_KEY);
    if (!idx) return;
    await this.atomic.set(INDEX_KEY, idx.value.filter((i: string) => i !== id), idx.version);
  }
}
