import type { IAtomicStore } from '../store/interfaces.ts';
import type { RegionId, Platform } from './types.ts';
import type { InstanceId } from './instance.ts';
import { InstanceService } from './instance.ts';
import { AppError } from '../types.ts';

// ─── Entity ───

export type RegionBucketType = 'aws-s3' | 'alibaba-oss' | 'cloudflare-r2' | 'minio';

export interface RegionBucket {
  readonly id: string;
  readonly name: string;
  readonly platform: Platform;
  readonly region: RegionId;
  readonly endpoint: string;
  readonly bucketType: RegionBucketType;
  readonly credentialRef: string;
  readonly instanceId: InstanceId;
  readonly status: 'Active' | 'Inactive';
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface CreateBucketInput {
  name: string;
  bucketType: RegionBucketType;
  /** 绑定的计算实例 ID，platform/region/endpoint/credentialRef 从实例自动继承 */
  instanceId: string;
}

export interface UpdateBucketInput {
  name?: string | undefined;
  bucketType?: RegionBucketType | undefined;
  instanceId?: string | undefined;
  status?: 'Active' | 'Inactive' | undefined;
}

// ─── Constants ───

const BUCKET_PREFIX = 'region-bucket:';
const BUCKET_INDEX_KEY = 'region-bucket:ids';
let _bucketCounter = 0;

function generateBucketId(): string {
  return `bkt_${++_bucketCounter}_${Date.now().toString(36)}`;
}

// ─── Service ───

export class BucketService {
  constructor(private readonly atomic: IAtomicStore) {}

  async create(input: CreateBucketInput): Promise<RegionBucket> {
    // Resolve platform/region/endpoint/credentialRef from bound ComputeInstance
    const instSvc = new InstanceService(this.atomic);
    const inst = await instSvc.get(input.instanceId as InstanceId);
    if (!inst) throw new AppError(400, 'INSTANCE_NOT_FOUND', `ComputeInstance ${input.instanceId} not found`);

    const id = generateBucketId();
    const now = Date.now();

    const bucket: RegionBucket = {
      id,
      name: input.name,
      platform: inst.platform,
      region: inst.region,
      endpoint: inst.endpoint,
      bucketType: input.bucketType,
      credentialRef: inst.credentialRef ?? '',
      instanceId: input.instanceId as InstanceId,
      status: 'Active',
      createdAt: now,
      updatedAt: now,
    };

    await this.atomic.set(BUCKET_PREFIX + id, bucket, null);
    await this.#addToIndex(id);
    return bucket;
  }

  async get(id: string): Promise<RegionBucket | null> {
    const entry = await this.atomic.get<RegionBucket>(BUCKET_PREFIX + id);
    return entry?.value ?? null;
  }

  async list(filter?: { platform?: string | undefined; region?: string | undefined }): Promise<RegionBucket[]> {
    const all = await this.#listAll();
    if (!filter) return all;
    return all.filter(b => {
      if (filter.platform && b.platform !== filter.platform) return false;
      if (filter.region && b.region !== filter.region) return false;
      return true;
    });
  }

  async update(id: string, input: UpdateBucketInput): Promise<RegionBucket> {
    const entry = await this.atomic.get<RegionBucket>(BUCKET_PREFIX + id);
    if (!entry) throw new AppError(404, 'BUCKET_NOT_FOUND', 'Bucket not found');

    const updated: RegionBucket = {
      ...entry.value,
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.bucketType !== undefined ? { bucketType: input.bucketType } : {}),
      ...(input.instanceId !== undefined ? { instanceId: input.instanceId as InstanceId } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      updatedAt: Date.now(),
    };

    const newVersion = await this.atomic.set(BUCKET_PREFIX + id, updated, entry.version);
    if (!newVersion) throw new AppError(409, 'CONFLICT', 'Concurrent modification detected');
    return updated;
  }

  async delete(id: string): Promise<void> {
    const entry = await this.atomic.get<RegionBucket>(BUCKET_PREFIX + id);
    if (!entry) throw new AppError(404, 'BUCKET_NOT_FOUND', 'Bucket not found');
    await this.atomic.set(BUCKET_PREFIX + id, null, entry.version);
    await this.#removeFromIndex(id);
  }

  // ─── Internal helpers ───

  async #listAll(): Promise<RegionBucket[]> {
    const idx = await this.atomic.get<string[]>(BUCKET_INDEX_KEY);
    if (!idx) return [];
    const entries = await Promise.all(idx.value.map(id => this.atomic.get<RegionBucket>(BUCKET_PREFIX + id)));
    return entries.filter(e => e).map(e => e!.value);
  }

  async #addToIndex(id: string): Promise<void> {
    const idx = await this.atomic.get<string[]>(BUCKET_INDEX_KEY);
    await this.atomic.set(BUCKET_INDEX_KEY, [...(idx?.value ?? []), id], idx?.version ?? null);
  }

  async #removeFromIndex(id: string): Promise<void> {
    const idx = await this.atomic.get<string[]>(BUCKET_INDEX_KEY);
    if (!idx) return;
    await this.atomic.set(BUCKET_INDEX_KEY, idx.value.filter((i: string) => i !== id), idx.version);
  }
}
