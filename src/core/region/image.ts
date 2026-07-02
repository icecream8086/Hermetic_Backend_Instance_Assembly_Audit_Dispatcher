import type { IAtomicStore } from '../store/interfaces.ts';
import type { RegionId, Platform } from './types.ts';
import type { InstanceId } from './instance.ts';
import { InstanceService, createInstanceId } from './instance.ts';
import { AppError } from '../types.ts';

// ─── Entity ───

export interface RegistryCredential {
  readonly server: string;
  readonly userName: string;
  readonly password: string;
}

export interface ImageRepository {
  readonly id: string;
  readonly name: string;
  readonly platform: Platform;
  readonly region: RegionId;
  readonly endpoint: string;
  readonly instanceId: InstanceId;
  readonly image: string;
  /** 内联 registry 凭证（备用，推荐用 credentialRef 走凭证模块） */
  readonly registryCredential?: RegistryCredential | undefined;
  /** 引用 ManagedCredential.name，从中读取 registryCredentials */
  readonly credentialRef?: string | undefined;
  readonly clusterId?: string | undefined;
  readonly status: 'active' | 'inactive';
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface CreateImageInput {
  name: string;
  /** 绑定的计算实例 ID，platform/region/endpoint 从实例自动继承 */
  instanceId: string;
  image: string;
  registryCredential?: RegistryCredential | undefined;
  credentialRef?: string | undefined;
  clusterId?: string | undefined;
}

export interface UpdateImageInput {
  name?: string | undefined;
  image?: string | undefined;
  registryCredential?: RegistryCredential | null | undefined;
  credentialRef?: string | null | undefined;
  clusterId?: string | null | undefined;
  instanceId?: string | undefined;
  status?: 'active' | 'inactive' | undefined;
}

// ─── Constants ───

const IMAGE_PREFIX = 'image-repo:';
const IMAGE_INDEX_KEY = 'image-repo:ids';

function generateImageId(): string {
  return `img_${crypto.randomUUID()}`;
}

// ─── Service ───

export class ImageRepositoryService {
  public constructor(private readonly atomic: IAtomicStore) {}

  public async create(input: CreateImageInput): Promise<ImageRepository> {
    const instSvc = new InstanceService(this.atomic);
    const instanceId = createInstanceId(input.instanceId);
    const inst = await instSvc.get(instanceId);
    if (!inst) throw new AppError(400, 'INSTANCE_NOT_FOUND', `ComputeInstance ${input.instanceId} not found`);

    const id = generateImageId();
    const now = Date.now();

    const repo: ImageRepository = {
      id,
      name: input.name,
      platform: inst.platform,
      region: inst.region,
      endpoint: inst.endpoint,
      instanceId,
      image: input.image,
      ...(input.registryCredential ? { registryCredential: input.registryCredential } : {}),
      ...(input.credentialRef ? { credentialRef: input.credentialRef } : {}),
      ...(input.clusterId ? { clusterId: input.clusterId } : {}),
      status: 'active',
      createdAt: now,
      updatedAt: now,
    };

    await this.atomic.set(IMAGE_PREFIX + id, repo, null);
    await this.#addToIndex(id);
    return repo;
  }

  public async get(id: string): Promise<ImageRepository | null> {
    const entry = await this.atomic.get<ImageRepository>(IMAGE_PREFIX + id);
    return entry?.value ?? null;
  }

  public async list(filter?: { platform?: string | undefined; status?: string | undefined }): Promise<ImageRepository[]> {
    const all = await this.#listAll();
    if (!filter) return all;
    return all.filter(r => {
      if (filter.platform && r.platform !== filter.platform) return false;
      if (filter.status && r.status !== filter.status) return false;
      return true;
    });
  }

  public async update(id: string, input: UpdateImageInput): Promise<ImageRepository> {
    const entry = await this.atomic.get<ImageRepository>(IMAGE_PREFIX + id);
    if (!entry) throw new AppError(404, 'IMAGE_NOT_FOUND', 'ImageRepository not found');

    const updated: ImageRepository = {
      ...entry.value,
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.image !== undefined ? { image: input.image } : {}),
      ...(input.registryCredential !== undefined ? { registryCredential: input.registryCredential ?? undefined } : {}),
      ...(input.credentialRef !== undefined ? { credentialRef: input.credentialRef ?? undefined } : {}),
      ...(input.clusterId !== undefined ? { clusterId: input.clusterId ?? undefined } : {}),
      ...(input.instanceId !== undefined ? { instanceId: createInstanceId(input.instanceId) } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      updatedAt: Date.now(),
    };

    const newVersion = await this.atomic.set(IMAGE_PREFIX + id, updated, entry.version);
    if (!newVersion) throw new AppError(409, 'CONFLICT', 'Concurrent modification detected');
    return updated;
  }

  public async delete(id: string): Promise<void> {
    const entry = await this.atomic.get<ImageRepository>(IMAGE_PREFIX + id);
    if (!entry) throw new AppError(404, 'IMAGE_NOT_FOUND', 'ImageRepository not found');
    await this.atomic.set(IMAGE_PREFIX + id, null, entry.version);
    await this.#removeFromIndex(id);
  }

  // ─── Internal helpers ───

  async #listAll(): Promise<ImageRepository[]> {
    const idx = await this.atomic.get<string[]>(IMAGE_INDEX_KEY);
    if (!idx) return [];
    const entries = await Promise.all(idx.value.map(id => this.atomic.get<ImageRepository>(IMAGE_PREFIX + id)));
    return entries.filter(e => e).map(e => e!.value);
  }

  async #addToIndex(id: string): Promise<void> {
    const idx = await this.atomic.get<string[]>(IMAGE_INDEX_KEY);
    await this.atomic.set(IMAGE_INDEX_KEY, [...(idx?.value ?? []), id], idx?.version ?? null);
  }

  async #removeFromIndex(id: string): Promise<void> {
    const idx = await this.atomic.get<string[]>(IMAGE_INDEX_KEY);
    if (!idx) return;
    await this.atomic.set(IMAGE_INDEX_KEY, idx.value.filter((i: string) => i !== id), idx.version);
  }
}
