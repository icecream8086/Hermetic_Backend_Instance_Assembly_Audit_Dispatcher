import type { IAtomicStore, IBlobStore } from '../../core/store/interfaces.ts';
import { AppError } from '../../core/types.ts';
import type { SecretEncryption } from '../../core/auth/secret-encryption.ts';
import type { UserKeyring } from '../../core/auth/keyring.ts';
import { SealedBox } from '../../core/auth/sealed-box.ts';
import type { ContainerSecret, CreateContainerSecretInput, UpdateContainerSecretInput } from './types.ts';
import { z } from 'zod';

const PREFIX = 'ctsecret:';
const INDEX_KEY = 'ctsecret:ids';

export interface IContainerSecretService {
  create(input: CreateContainerSecretInput): Promise<ContainerSecret>;
  get(id: string): Promise<ContainerSecret | null>;
  list(scopeId?: string): Promise<ContainerSecret[]>;
  update(id: string, input: UpdateContainerSecretInput): Promise<ContainerSecret>;
  delete(id: string): Promise<void>;
  uploadBlob(id: string, filename: string, body: ReadableStream | ArrayBuffer, mimeType?: string): Promise<ContainerSecret>;
  resolveData(id: string): Promise<string>;
  canAccess(id: string, scopeId: string): Promise<boolean>;
  getPublicKey(userId: string): Promise<string | null>;
}

export class ContainerSecretService implements IContainerSecretService {
  public constructor(
    private readonly atomic: IAtomicStore,
    private readonly blob?: IBlobStore,
    private readonly encryption?: SecretEncryption,
    private readonly keyring?: UserKeyring,
  ) {}

  #encId(id: string): string { return PREFIX + id; }

  public async create(input: CreateContainerSecretInput): Promise<ContainerSecret> {
    const id = `ctsec_${crypto.randomUUID()}`;
    const now = Date.now();

    const keyType = input.keyType ?? 'aes-gcm';
    const sealForUserId = input.sealForUserId;
    let value: string | undefined;

    if (input.type === 'inline' && input.value) {
      if (keyType === 'sealed-box' && sealForUserId && this.keyring) {
        const pk = await this.keyring.ensureSealedBox(sealForUserId);
        value = await SealedBox.seal(pk.publicKey, input.value);
      } else if (this.encryption) {
        value = await this.encryption.encrypt(input.value);
      } else {
        value = input.value;
      }
    }

    const secret: ContainerSecret = {
      id,
      name: input.name,
      type: input.type,
      description: input.description,
      value,
      status: input.status ?? 'active',
      visibility: input.visibility ?? 'all',
      selectedScopeIds: input.selectedScopeIds ?? [],
      keyType: keyType === 'sealed-box' && sealForUserId ? 'sealed-box' : 'aes-gcm',
      ...(keyType === 'sealed-box' && sealForUserId ? { sealedForUserId: sealForUserId } : {}),
      version: 1,
      createdAt: now,
      updatedAt: now,
    };

    const toStore = this.encryption ? await this.#encryptFields(secret) : secret;
    await this.atomic.set(this.#encId(id), toStore, null);
    await this.#addToIndex(id);
    return secret;
  }

  public async get(id: string): Promise<ContainerSecret | null> {
    const entry = await this.atomic.get<ContainerSecret>(this.#encId(id));
    if (!entry) return null;
    const s = await this.#decryptFields(entry.value);
    return normalizeSecret(s);
  }

  public async list(scopeId?: string): Promise<ContainerSecret[]> {
    const idx = await this.atomic.get<string[]>(INDEX_KEY);
    if (!idx) return [];
    const entries = await Promise.all(idx.value.map(id => this.atomic.get<ContainerSecret>(this.#encId(id))));
    const secrets = await Promise.all(
      entries.filter(e => e).map(e => this.#decryptFields(e!.value).then(normalizeSecret)),
    );
    if (scopeId) {
      return secrets.filter(s => visibleTo(s, scopeId));
    }
    return secrets;
  }

  public async update(id: string, input: UpdateContainerSecretInput): Promise<ContainerSecret> {
    const entry = await this.atomic.get<ContainerSecret>(this.#encId(id));
    if (!entry) throw new AppError(404, 'SECRET_NOT_FOUND', 'Container secret not found');

    const existing = normalizeSecret(
      this.encryption ? await this.#decryptFields(entry.value) : entry.value,
    );

    const updated: ContainerSecret = {
      ...existing,
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.description !== undefined ? { description: input.description ?? undefined } : {}),
      ...(input.value !== undefined ? { value: input.value ?? undefined } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.visibility !== undefined ? { visibility: input.visibility } : {}),
      ...(input.selectedScopeIds !== undefined ? { selectedScopeIds: input.selectedScopeIds ?? [] } : {}),
      version: existing.version + 1,
      updatedAt: Date.now(),
    };

    const toStore = this.encryption ? await this.#encryptFields(updated) : updated;
    const newVersion = await this.atomic.set(this.#encId(id), toStore, entry.version);
    if (!newVersion) throw new AppError(409, 'CONFLICT', 'Concurrent modification detected');
    return updated;
  }

  public async delete(id: string): Promise<void> {
    const entry = await this.atomic.get<ContainerSecret>(this.#encId(id));
    if (!entry) throw new AppError(404, 'SECRET_NOT_FOUND', 'Container secret not found');

    if (entry.value.blobKey && this.blob) {
      try { await this.blob.delete(entry.value.blobKey); } catch {
        console.debug("noop");
      }
    }

    await this.atomic.set(this.#encId(id), null, entry.version);
    await this.#removeFromIndex(id);
  }

  public async uploadBlob(id: string, filename: string, body: ReadableStream | ArrayBuffer, mimeType?: string): Promise<ContainerSecret> {
    const entry = await this.atomic.get<ContainerSecret>(this.#encId(id));
    if (!entry) throw new AppError(404, 'SECRET_NOT_FOUND', 'Container secret not found');
    if (!this.blob) throw new AppError(500, 'BLOB_STORE_UNAVAILABLE', 'Blob store not configured');

    const blobKey = `ctsecret:${id}:${filename}`;
    await this.blob.put(blobKey, body, { ...(mimeType ? { contentType: mimeType } : {}) });

    let size: number | undefined;
    try { size = z.instanceof(ArrayBuffer).parse(body).byteLength; } catch { size = undefined; }
    const existing = normalizeSecret(entry.value);
    const updated: ContainerSecret = {
      ...existing,
      blobKey,
      filename,
      mimeType,
      size,
      version: existing.version + 1,
      updatedAt: Date.now(),
    };
    const toStore = this.encryption ? await this.#encryptFields(updated) : updated;
    const newVersion = await this.atomic.set(this.#encId(id), toStore, entry.version);
    if (!newVersion) throw new AppError(409, 'CONFLICT', 'Concurrent modification detected');
    return updated;
  }

  public async resolveData(id: string): Promise<string> {
    const entry = await this.atomic.get<ContainerSecret>(this.#encId(id));
    if (!entry) throw new AppError(404, 'SECRET_NOT_FOUND', 'Container secret not found');

    const secret = this.encryption ? await this.#decryptFields(entry.value) : entry.value;
    if (secret.type === 'inline') {
      if (!secret.value) throw new AppError(500, 'SECRET_EMPTY', 'Inline secret has no value');
      return secret.value;
    }
    if (!this.blob || !secret.blobKey) throw new AppError(500, 'SECRET_NO_BLOB', 'Upload secret has no blob');
    const stream = await this.blob.get(secret.blobKey);
    if (!stream) throw new AppError(500, 'SECRET_BLOB_MISSING', 'Secret blob not found in store');
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    const total = chunks.reduce((sum, c) => sum + c.byteLength, 0);
    const buf = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      buf.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder().decode(buf);
    throw new AppError(500, 'SECRET_INVALID_TYPE', `Unknown secret type: ${String(secret.type)}`);
  }

  public async canAccess(id: string, scopeId: string): Promise<boolean> {
    const secret = await this.get(id);
    if (!secret) return false;
    return visibleTo(secret, scopeId);
  }

  public async getPublicKey(userId: string): Promise<string | null> {
    if (!this.keyring) return null;
    return this.keyring.getPublicKey(userId);
  }

  // ─── Encryption helpers ───

  async #encryptFields(s: ContainerSecret): Promise<ContainerSecret> {
    if (s.keyType === 'sealed-box') return s; // already sealed
    const enc = this.encryption;
    if (!enc || !s.value) return s;
    return { ...s, value: await enc.encrypt(s.value) };
  }

  async #decryptFields(s: ContainerSecret): Promise<ContainerSecret> {
    if (s.keyType === 'sealed-box' && s.sealedForUserId && this.keyring) {
      const kp = await this.keyring.ensureSealedBox(s.sealedForUserId);
      const opened = await SealedBox.open(kp.privateKey, s.value!);
      return { ...s, value: opened };
    }
    const enc = this.encryption;
    if (!enc || !s.value) return s;
    return { ...s, value: await enc.decrypt(s.value) };
  }

  // ─── Index helpers ───

  async #addToIndex(id: string): Promise<void> {
    const idx = await this.atomic.get<string[]>(INDEX_KEY);
    await this.atomic.set(INDEX_KEY, [...(idx?.value ?? []), id], idx?.version ?? null);
  }

  async #removeFromIndex(id: string): Promise<void> {
    const idx = await this.atomic.get<string[]>(INDEX_KEY);
    if (!idx) return;
    await this.atomic.set(INDEX_KEY, idx.value.filter((i: string) => i !== id), idx.version);
  }
}

// ─── Helpers ───

function visibleTo(s: ContainerSecret, scopeId: string): boolean {
  if (s.visibility === 'all') return true;
  if (s.visibility === 'private') return false; // only accessible by explicit scope match
  return s.selectedScopeIds.includes(scopeId);
  return false;
}

/** Normalize old stored secrets missing fields added in Phase 5.2. */
function normalizeSecret(s: ContainerSecret): ContainerSecret {
  if (!s.version) {
    z.custom<Record<string, unknown>>().parse(s).version = 1;
  }
  return s;
}
