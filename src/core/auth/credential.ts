import type { IAtomicStore } from '../store/interfaces.ts';
import type { Platform } from '../region/types.ts';
import { AppError } from '../types.ts';

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
  readonly platform: Platform;
  readonly accessKeyId: string;
  /** 完整 secret — 写入时传入，读取时 masked */
  readonly accessKeySecret: string;
  readonly registryCredentials?: readonly RegistryCredential[] | undefined;
  readonly instanceId?: string | undefined;
  readonly status: 'active' | 'inactive';
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** 对外展示的凭证（secret masked）。读接口统一用此类型。 */
export interface MaskedCredential extends Omit<ManagedCredential, 'accessKeySecret'> {
  readonly accessKeySecret: string; // masked: "LTAI5t***"
}

export function maskSecret(secret: string): string {
  if (secret.length <= 12) return secret.slice(0, 4) + '***';
  return secret.slice(0, 12) + '***';
}

export function toMasked(cred: ManagedCredential): MaskedCredential {
  return { ...cred, accessKeySecret: maskSecret(cred.accessKeySecret) };
}

export interface CreateCredentialInput {
  name: string;
  platform: Platform;
  accessKeyId: string;
  accessKeySecret: string;
  registryCredentials?: RegistryCredential[] | undefined;
  instanceId?: string | undefined;
}

export interface UpdateCredentialInput {
  name?: string | undefined;
  accessKeyId?: string | undefined;
  accessKeySecret?: string | undefined;
  registryCredentials?: RegistryCredential[] | null | undefined;
  instanceId?: string | null | undefined;
  status?: 'active' | 'inactive' | undefined;
}

// ─── Constants ───

const PREFIX = 'cred:';
const INDEX_KEY = 'cred:ids';

// ─── Service ───

export class CredentialService {
  constructor(private readonly atomic: IAtomicStore) {}

  async create(input: CreateCredentialInput): Promise<ManagedCredential> {
    const id = generateCredentialId();
    const now = Date.now();

    const cred: ManagedCredential = {
      id,
      name: input.name,
      platform: input.platform,
      accessKeyId: input.accessKeyId,
      accessKeySecret: input.accessKeySecret,
      ...(input.registryCredentials?.length ? { registryCredentials: [...input.registryCredentials] } : {}),
      ...(input.instanceId ? { instanceId: input.instanceId } : {}),
      status: 'active',
      createdAt: now,
      updatedAt: now,
    };

    await this.atomic.set(PREFIX + id, cred, null);
    await this.#addToIndex(id);
    return cred;
  }

  async get(id: CredentialId): Promise<ManagedCredential | null> {
    const entry = await this.atomic.get<ManagedCredential>(PREFIX + id);
    return entry?.value ?? null;
  }

  /** 按 name 查找凭证（provider resolver 用）。 */
  async findByName(name: string): Promise<ManagedCredential | null> {
    const all = await this.#listAll();
    return all.find(c => c.name === name) ?? null;
  }

  async list(filter?: { platform?: string | undefined }): Promise<ManagedCredential[]> {
    const all = await this.#listAll();
    if (!filter?.platform) return all;
    return all.filter(c => c.platform === filter.platform);
  }

  async update(id: CredentialId, input: UpdateCredentialInput): Promise<ManagedCredential> {
    const entry = await this.atomic.get<ManagedCredential>(PREFIX + id);
    if (!entry) throw new AppError(404, 'CREDENTIAL_NOT_FOUND', 'Credential not found');

    const updated: ManagedCredential = {
      ...entry.value,
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.accessKeyId !== undefined ? { accessKeyId: input.accessKeyId } : {}),
      ...(input.accessKeySecret !== undefined ? { accessKeySecret: input.accessKeySecret } : {}),
      ...(input.registryCredentials !== undefined ? { registryCredentials: input.registryCredentials ?? undefined } : {}),
      ...(input.instanceId !== undefined ? { instanceId: input.instanceId ?? undefined } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      updatedAt: Date.now(),
    };

    const newVersion = await this.atomic.set(PREFIX + id, updated, entry.version);
    if (!newVersion) throw new AppError(409, 'CONFLICT', 'Concurrent modification detected');
    return updated;
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
