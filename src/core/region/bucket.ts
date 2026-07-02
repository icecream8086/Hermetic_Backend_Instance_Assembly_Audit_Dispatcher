import type { IAtomicStore } from '../store/interfaces.ts';
import type { RegionId, Platform } from './types.ts';
import type { InstanceId } from './instance.ts';
import { InstanceService, createInstanceId } from './instance.ts';
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
  /** 绑定的计算实例 ID，platform/region/endpoint 从实例自动继承 */
  instanceId: string;
  /** 凭证引用，有则用此值，无则从计算实例继承 */
  credentialRef?: string | undefined;
}

export interface UpdateBucketInput {
  name?: string | undefined;
  bucketType?: RegionBucketType | undefined;
  instanceId?: string | undefined;
  credentialRef?: string | null | undefined;
  status?: 'Active' | 'Inactive' | undefined;
}

// ─── Constants ───

const BUCKET_PREFIX = 'region-bucket:';
const BUCKET_INDEX_KEY = 'region-bucket:ids';
function generateBucketId(): string {
  return `bkt_${crypto.randomUUID()}`;
}

// ─── Service ───

export class BucketService {
  public constructor(private readonly atomic: IAtomicStore) {}

  public async create(input: CreateBucketInput): Promise<RegionBucket> {
    // Resolve platform/region/endpoint/credentialRef from bound ComputeInstance
    const instSvc = new InstanceService(this.atomic);
    const instanceId = createInstanceId(input.instanceId);
    const inst = await instSvc.get(instanceId);
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
      credentialRef: input.credentialRef ?? inst.credentialRef ?? '',
      instanceId,
      status: 'Active',
      createdAt: now,
      updatedAt: now,
    };

    await this.atomic.set(BUCKET_PREFIX + id, bucket, null);
    await this.#addToIndex(id);
    return bucket;
  }

  public async get(id: string): Promise<RegionBucket | null> {
    const entry = await this.atomic.get<RegionBucket>(BUCKET_PREFIX + id);
    return entry?.value ?? null;
  }

  public async list(filter?: { platform?: string | undefined; region?: string | undefined }): Promise<RegionBucket[]> {
    const all = await this.#listAll();
    if (!filter) return all;
    return all.filter(b => {
      if (filter.platform && b.platform !== filter.platform) return false;
      if (filter.region && b.region !== filter.region) return false;
      return true;
    });
  }

  public async update(id: string, input: UpdateBucketInput): Promise<RegionBucket> {
    const entry = await this.atomic.get<RegionBucket>(BUCKET_PREFIX + id);
    if (!entry) throw new AppError(404, 'BUCKET_NOT_FOUND', 'Bucket not found');

    // If instanceId changes, re-inherit platform/region/endpoint from the new instance
    // eslint-disable-next-line @typescript-eslint/no-restricted-types -- inherited fields from instance: only a subset may be populated
    let inheritedFields: Partial<RegionBucket> = {};
    if (input.instanceId !== undefined) {
      const instSvc = new InstanceService(this.atomic);
      const updateInstanceId = createInstanceId(input.instanceId);
      const inst = await instSvc.get(updateInstanceId);
      if (inst) {
        inheritedFields = { platform: inst.platform, region: inst.region, endpoint: inst.endpoint };
      }
    }

    const updated: RegionBucket = {
      ...entry.value,
      ...inheritedFields,
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.bucketType !== undefined ? { bucketType: input.bucketType } : {}),
      ...(input.instanceId !== undefined ? { instanceId: createInstanceId(input.instanceId) } : {}),
      ...(input.credentialRef !== undefined ? { credentialRef: input.credentialRef ?? '' } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      updatedAt: Date.now(),
    };

    const newVersion = await this.atomic.set(BUCKET_PREFIX + id, updated, entry.version);
    if (!newVersion) throw new AppError(409, 'CONFLICT', 'Concurrent modification detected');
    return updated;
  }

  public async delete(id: string): Promise<void> {
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
