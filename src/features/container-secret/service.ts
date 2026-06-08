import type { IAtomicStore, IBlobStore } from '../../core/store/interfaces.ts';
import { AppError } from '../../core/types.ts';
import { SecretEncryption } from '../../core/auth/secret-encryption.ts';
import type { ContainerSecret, CreateContainerSecretInput, UpdateContainerSecretInput } from './types.ts';

const PREFIX = 'ctsecret:';
const INDEX_KEY = 'ctsecret:ids';

export interface IContainerSecretService {
  create(input: CreateContainerSecretInput): Promise<ContainerSecret>;
  get(id: string): Promise<ContainerSecret | null>;
  list(): Promise<ContainerSecret[]>;
  update(id: string, input: UpdateContainerSecretInput): Promise<ContainerSecret>;
  delete(id: string): Promise<void>;
  /** Upload a file blob for an upload-type secret. */
  uploadBlob(id: string, filename: string, body: ReadableStream | ArrayBuffer, mimeType?: string): Promise<ContainerSecret>;
  /** Read secret data (decrypted / blob content) for provider injection. */
  resolveData(id: string): Promise<string>;
}

export class ContainerSecretService implements IContainerSecretService {
  constructor(
    private readonly atomic: IAtomicStore,
    private readonly blob?: IBlobStore,
    private readonly encryption?: SecretEncryption,
  ) {}

  #encId(id: string): string { return PREFIX + id; }

  async create(input: CreateContainerSecretInput): Promise<ContainerSecret> {
    const id = `ctsec_${crypto.randomUUID()}`;
    const now = Date.now();

    let value: string | undefined;
    if (input.type === 'inline' && input.value) {
      value = this.encryption
        ? await this.encryption.encrypt(input.value)
        : input.value;
    }

    const secret: ContainerSecret = {
      id,
      name: input.name,
      type: input.type,
      description: input.description,
      value,
      status: input.status ?? 'active',
      createdAt: now,
      updatedAt: now,
    };

    const toStore = this.encryption ? await this.#encryptFields(secret) : secret;
    await this.atomic.set(this.#encId(id), toStore, null);
    await this.#addToIndex(id);
    return secret;
  }

  async get(id: string): Promise<ContainerSecret | null> {
    const entry = await this.atomic.get<ContainerSecret>(this.#encId(id));
    if (!entry) return null;
    return this.#decryptFields(entry.value);
  }

  async list(): Promise<ContainerSecret[]> {
    const idx = await this.atomic.get<string[]>(INDEX_KEY);
    if (!idx) return [];
    const entries = await Promise.all(idx.value.map(id => this.atomic.get<ContainerSecret>(this.#encId(id))));
    const secrets = entries.filter(e => e).map(e => e!.value);
    return Promise.all(secrets.map(s => this.#decryptFields(s)));
  }

  async update(id: string, input: UpdateContainerSecretInput): Promise<ContainerSecret> {
    const entry = await this.atomic.get<ContainerSecret>(this.#encId(id));
    if (!entry) throw new AppError(404, 'SECRET_NOT_FOUND', 'Container secret not found');

    const existing = this.encryption ? await this.#decryptFields(entry.value) : entry.value;

    const updated: ContainerSecret = {
      ...existing,
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.description !== undefined ? { description: input.description ?? undefined } : {}),
      ...(input.value !== undefined ? { value: input.value ?? undefined } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      updatedAt: Date.now(),
    };

    const toStore = this.encryption ? await this.#encryptFields(updated) : updated;
    const newVersion = await this.atomic.set(this.#encId(id), toStore, entry.version);
    if (!newVersion) throw new AppError(409, 'CONFLICT', 'Concurrent modification detected');
    return updated;
  }

  async delete(id: string): Promise<void> {
    const entry = await this.atomic.get<ContainerSecret>(this.#encId(id));
    if (!entry) throw new AppError(404, 'SECRET_NOT_FOUND', 'Container secret not found');

    // Remove associated blob if upload type
    if (entry.value.blobKey && this.blob) {
      await this.blob.delete(entry.value.blobKey).catch(() => {});
    }

    await this.atomic.set(this.#encId(id), null, entry.version);
    await this.#removeFromIndex(id);
  }

  async uploadBlob(id: string, filename: string, body: ReadableStream | ArrayBuffer, mimeType?: string): Promise<ContainerSecret> {
    const entry = await this.atomic.get<ContainerSecret>(this.#encId(id));
    if (!entry) throw new AppError(404, 'SECRET_NOT_FOUND', 'Container secret not found');
    if (!this.blob) throw new AppError(500, 'BLOB_STORE_UNAVAILABLE', 'Blob store not configured');

    const blobKey = `ctsecret:${id}:${filename}`;
    await this.blob.put(blobKey, body, { ...(mimeType ? { contentType: mimeType } : {}) });

    const size = body instanceof ArrayBuffer ? body.byteLength : undefined;
    const updated: ContainerSecret = {
      ...entry.value,
      blobKey,
      filename,
      mimeType,
      size,
      updatedAt: Date.now(),
    };
    const toStore = this.encryption ? await this.#encryptFields(updated) : updated;
    const newVersion = await this.atomic.set(this.#encId(id), toStore, entry.version);
    if (!newVersion) throw new AppError(409, 'CONFLICT', 'Concurrent modification detected');
    return updated;
  }

  async resolveData(id: string): Promise<string> {
    const entry = await this.atomic.get<ContainerSecret>(this.#encId(id));
    if (!entry) throw new AppError(404, 'SECRET_NOT_FOUND', 'Container secret not found');

    const secret = this.encryption ? await this.#decryptFields(entry.value) : entry.value;
    if (secret.type === 'inline') {
      if (!secret.value) throw new AppError(500, 'SECRET_EMPTY', 'Inline secret has no value');
      return secret.value;
    }
    if (secret.type === 'upload') {
      if (!this.blob || !secret.blobKey) throw new AppError(500, 'SECRET_NO_BLOB', 'Upload secret has no blob');
      const stream = await this.blob.get(secret.blobKey);
      if (!stream) throw new AppError(500, 'SECRET_BLOB_MISSING', 'Secret blob not found in store');
      const reader = stream.getReader();
      const chunks: Uint8Array[] = [];
      while (true) {
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
    }
    throw new AppError(500, 'SECRET_INVALID_TYPE', `Unknown secret type: ${secret.type}`);
  }

  // ─── Encryption helpers ───

  async #encryptFields(s: ContainerSecret): Promise<ContainerSecret> {
    const enc = this.encryption;
    if (!enc || !s.value) return s;
    return { ...s, value: await enc.encrypt(s.value) };
  }

  async #decryptFields(s: ContainerSecret): Promise<ContainerSecret> {
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
