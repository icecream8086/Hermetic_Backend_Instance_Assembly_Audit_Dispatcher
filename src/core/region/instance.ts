import type { IAtomicStore } from '../store/interfaces.ts';
import type { RegionId, ZoneId, Platform } from './types.ts';
import { createZoneId } from './types.ts';
import { AppError } from '../types.ts';

// ─── Brand type ───

declare const INSTANCE_ID_BRAND: unique symbol;
export type InstanceId = string & { readonly [INSTANCE_ID_BRAND]: true };

export function generateInstanceId(): InstanceId {
  return `inst_${crypto.randomUUID()}` as InstanceId;
}

// ─── Entity ───

export interface InstanceCapabilities {
  readonly container?: boolean | undefined;
  readonly image?: boolean | undefined;
  readonly group?: boolean | undefined;
  readonly metrics?: boolean | undefined;
  readonly dns?: boolean | undefined;
  readonly network?: boolean | undefined;
  readonly s3?: boolean | undefined;
}

export interface InstanceCapacity {
  readonly cpu?: number | undefined;
  readonly memory?: number | undefined;
  readonly maxPodCount?: number | undefined;
}

export type InstanceStatus = 'online' | 'offline' | 'error';

export interface ComputeInstance {
  readonly id: InstanceId;
  readonly name: string;
  readonly platform: Platform;
  readonly region: RegionId;
  readonly zone: ZoneId;
  readonly endpoint: string;
  readonly credentialRef?: string | undefined;
  readonly capabilities: InstanceCapabilities;
  readonly capacity?: InstanceCapacity | undefined;
  readonly status: InstanceStatus;
  readonly labels?: Record<string, string> | undefined;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface CreateInstanceInput {
  name: string;
  platform: Platform;
  region: string;
  zone: string;
  endpoint: string;
  credentialRef?: string | undefined;
  capabilities?: InstanceCapabilities | undefined;
  capacity?: InstanceCapacity | undefined;
  labels?: Record<string, string> | undefined;
}

export interface UpdateInstanceInput {
  name?: string | undefined;
  endpoint?: string | undefined;
  credentialRef?: string | null | undefined;
  capabilities?: InstanceCapabilities | undefined;
  capacity?: InstanceCapacity | null | undefined;
  status?: InstanceStatus | undefined;
  labels?: Record<string, string> | null | undefined;
}

// ─── Constants ───

const PREFIX = 'instance:';
const INDEX_KEY = 'instance:ids';

// ─── Service ───

export class InstanceService {
  constructor(private readonly atomic: IAtomicStore) {}

  async create(input: CreateInstanceInput): Promise<ComputeInstance> {
    const id = generateInstanceId();
    const zone = createZoneId(input.zone, input.platform);
    const now = Date.now();

    const instance: ComputeInstance = {
      id,
      name: input.name,
      platform: input.platform,
      region: input.region as RegionId,
      zone,
      endpoint: input.endpoint,
      ...(input.credentialRef ? { credentialRef: input.credentialRef } : {}),
      capabilities: input.capabilities ?? { container: true, image: true },
      ...(input.capacity ? { capacity: input.capacity } : {}),
      status: 'online',
      ...(input.labels ? { labels: { ...input.labels } } : {}),
      createdAt: now,
      updatedAt: now,
    };

    await this.atomic.set(PREFIX + id, instance, null);
    await this.#addToIndex(id);
    return instance;
  }

  async get(id: InstanceId): Promise<ComputeInstance | null> {
    const entry = await this.atomic.get<ComputeInstance>(PREFIX + id);
    return entry?.value ?? null;
  }

  async list(filter?: { region?: string | undefined; platform?: string | undefined; status?: string | undefined; zone?: string | undefined }): Promise<ComputeInstance[]> {
    const all = await this.#listAll();
    if (!filter) return all;
    return all.filter(inst => {
      if (filter.region && inst.region !== filter.region) return false;
      if (filter.platform && inst.platform !== filter.platform) return false;
      if (filter.status && inst.status !== filter.status) return false;
      if (filter.zone && inst.zone !== filter.zone) return false;
      return true;
    });
  }

  async update(id: InstanceId, input: UpdateInstanceInput): Promise<ComputeInstance> {
    const entry = await this.atomic.get<ComputeInstance>(PREFIX + id);
    if (!entry) throw new AppError(404, 'INSTANCE_NOT_FOUND', 'Compute instance not found');

    const updated: ComputeInstance = {
      ...entry.value,
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.endpoint !== undefined ? { endpoint: input.endpoint } : {}),
      ...(input.credentialRef !== undefined ? { credentialRef: input.credentialRef ?? undefined } : {}),
      ...(input.capabilities ? { capabilities: { ...entry.value.capabilities, ...input.capabilities } } : {}),
      ...(input.capacity !== undefined ? { capacity: input.capacity ?? undefined } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.labels !== undefined ? { labels: input.labels ?? undefined } : {}),
      updatedAt: Date.now(),
    };

    const newVersion = await this.atomic.set(PREFIX + id, updated, entry.version);
    if (!newVersion) throw new AppError(409, 'CONFLICT', 'Concurrent modification detected');
    return updated;
  }

  /** Update instance capacity + status (heartbeat). No OCC check — last-writer-wins. */
  async heartbeat(id: InstanceId, capacity: InstanceCapacity, status: InstanceStatus = 'online'): Promise<void> {
    const entry = await this.atomic.get<ComputeInstance>(PREFIX + id);
    if (!entry) return;
    await this.atomic.set(PREFIX + id, {
      ...entry.value,
      capacity,
      status,
      updatedAt: Date.now(),
    }, entry.version);
  }

  async delete(id: InstanceId): Promise<void> {
    const entry = await this.atomic.get<ComputeInstance>(PREFIX + id);
    if (!entry) throw new AppError(404, 'INSTANCE_NOT_FOUND', 'Compute instance not found');
    await this.atomic.set(PREFIX + id, null, entry.version);
    await this.#removeFromIndex(id);
  }

  /** Find online instances with a specific capability. */
  async resolveByCapability(capability: keyof InstanceCapabilities): Promise<ComputeInstance[]> {
    const all = await this.#listAll();
    return all.filter(inst => inst.capabilities[capability] && inst.status === 'online');
  }

  // ─── Internal helpers ───

  async #listAll(): Promise<ComputeInstance[]> {
    const idx = await this.atomic.get<string[]>(INDEX_KEY);
    if (!idx) return [];
    const entries = await Promise.all(idx.value.map(id => this.atomic.get<ComputeInstance>(PREFIX + id)));
    return entries.filter(e => e).map(e => e!.value);
  }

  async #addToIndex(id: InstanceId): Promise<void> {
    const idx = await this.atomic.get<string[]>(INDEX_KEY);
    await this.atomic.set(INDEX_KEY, [...(idx?.value ?? []), id], idx?.version ?? null);
  }

  async #removeFromIndex(id: InstanceId): Promise<void> {
    const idx = await this.atomic.get<string[]>(INDEX_KEY);
    if (!idx) return;
    await this.atomic.set(INDEX_KEY, idx.value.filter((i: string) => i !== id), idx.version);
  }
}
