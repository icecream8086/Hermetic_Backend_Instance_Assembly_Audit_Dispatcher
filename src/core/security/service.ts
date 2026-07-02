import type { IAtomicStore } from '../store/interfaces.ts';
import type { IAuditWriter } from '../audit/types.ts';
import type {
  SecurityResource, SecurityResourceId, CreateSecurityResourceInput,
  PresignedUrlSet,
} from './types.ts';
import { SecurityResourceStatus } from './types.ts';
import type { IS3Provider } from '../provider/s3.ts';
import { createSecurityResourceId } from './types.ts';

const PREFIX = 'security:';
const INDEX_KEY = 'security:ids';

export class SecurityResourceService {
  public constructor(
    private readonly atomic: IAtomicStore,
    _audit: IAuditWriter,
  ) {}

  // ── Provision ──

  /**
   * 创建 SecurityResource，首次签发 presigned URL 组。
   * @param s3Provider — 已用 admin 凭证初始化的 IS3Provider 实例
   */
  public async provision(
    input: CreateSecurityResourceInput,
    s3Provider: IS3Provider,
    bucketName: string,
    endpoint: string,
    region: string,
  ): Promise<SecurityResource> {
    const now = Date.now();
    const expiresIn = input.validDuration ?? 3600;

    // 签发 presigned URLs
    // putUrl: 为前缀 + 占位 key 签发 PUT
    const [putUrl, listUrl] = await Promise.all([
      s3Provider.putPresignedUrl(bucketName, '_placeholder_', expiresIn),
      s3Provider.getPresignedUrl(bucketName, '', expiresIn),
    ]);

    const value: PresignedUrlSet = {
      putUrl,
      listUrl,
      endpoint,
      bucket: bucketName,
      region,
      expiresAt: new Date(now + expiresIn * 1000).toISOString(),
    };

    const id = createSecurityResourceId(crypto.randomUUID());
    const resource: SecurityResource = {
      id, name: input.name,
      bucketId: input.bucketId,
      instanceId: input.instanceId,
      validDuration: input.validDuration ?? 3600,
      refreshThreshold: input.refreshThreshold ?? 900,
      status: SecurityResourceStatus.Active,
      value, createdAt: now, updatedAt: now,
    };

    await this.atomic.set(`${PREFIX}${id}`, resource, null);
    const idx = await this.atomic.get<string[]>(INDEX_KEY);
    await this.atomic.set(INDEX_KEY, [...(idx?.value ?? []), id], idx?.version ?? null);
    return resource;
  }

  // ── Read ──

  public async getById(id: SecurityResourceId): Promise<SecurityResource | null> {
    const entry = await this.atomic.get<SecurityResource>(`${PREFIX}${id}`);
    return entry?.value ?? null;
  }

  public async getByName(name: string): Promise<SecurityResource | null> {
    const all = await this.list();
    return all.find(r => r.name === name) ?? null;
  }

  public async list(status?: SecurityResourceStatus): Promise<SecurityResource[]> {
    const idx = await this.atomic.get<string[]>(INDEX_KEY);
    if (!idx?.value.length) return [];
    const entries = await Promise.all(
      idx.value.map(id => this.atomic.get<SecurityResource>(`${PREFIX}${id}`)),
    );
    const resources: SecurityResource[] = [];
    for (const e of entries) {
      if (e !== null) resources.push(e.value);
    }
    return status ? resources.filter(r => r.status === status) : resources;
  }

  // ── Refresh — 重新签发 presigned URL ──

  public async refresh(id: SecurityResourceId, s3Provider: IS3Provider): Promise<SecurityResource> {
    const entry = await this.atomic.get<SecurityResource>(`${PREFIX}${id}`);
    if (!entry?.value) throw new Error(`SecurityResource ${id} not found`);
    const resource = entry.value;
    if (resource.status === SecurityResourceStatus.Revoked) {
      throw new Error(`Cannot refresh revoked SecurityResource ${id}`);
    }

    const expiresIn = resource.validDuration;
    const now = Date.now();
    const [putUrl, listUrl] = await Promise.all([
      s3Provider.putPresignedUrl(resource.value.bucket, '_placeholder_', expiresIn),
      s3Provider.getPresignedUrl(resource.value.bucket, '', expiresIn),
    ]);

    const updated: SecurityResource = {
      ...resource,
      value: {
        ...resource.value,
        putUrl,
        listUrl,
        expiresAt: new Date(now + expiresIn * 1000).toISOString(),
      },
      status: SecurityResourceStatus.Active,
      updatedAt: now,
    };

    await this.atomic.set(`${PREFIX}${id}`, updated, entry.version);
    return updated;
  }

  // ── Check validity — applicator 调用 ──

  /**
   * 检查资源是否仍然有效。
   * - 状态非 Active → 无效
   * - 已过期 → 无效
   * - 剩余有效期 < refreshThreshold → 无效（需要刷新）
   */
  public checkValidity(resource: SecurityResource): { valid: boolean; reason?: string } {
    const now = Date.now();
    const expiresAt = new Date(resource.value.expiresAt).getTime();
    const remaining = expiresAt - now;

    if (resource.status !== SecurityResourceStatus.Active) {
      return { valid: false, reason: `SecurityResource "${resource.name}" is ${resource.status}` };
    }
    if (remaining <= 0) {
      return { valid: false, reason: `SecurityResource "${resource.name}" has expired` };
    }
    if (remaining < resource.refreshThreshold * 1000) {
      return {
        valid: false,
        reason: `SecurityResource "${resource.name}" expires in ${String(Math.round(remaining / 1000))}s (threshold: ${String(resource.refreshThreshold)}s). Trigger refresh first.`,
      };
    }
    return { valid: true };
  }

  // ── Revoke / Delete ──

  public async markExpired(id: SecurityResourceId): Promise<void> {
    const entry = await this.atomic.get<SecurityResource>(`${PREFIX}${id}`);
    if (entry?.value) {
      await this.atomic.set(`${PREFIX}${id}`, { ...entry.value, status: SecurityResourceStatus.Expired, updatedAt: Date.now() }, entry.version);
    }
  }

  public async revoke(id: SecurityResourceId): Promise<void> {
    const entry = await this.atomic.get<SecurityResource>(`${PREFIX}${id}`);
    if (entry?.value) {
      await this.atomic.set(`${PREFIX}${id}`, { ...entry.value, status: SecurityResourceStatus.Revoked, updatedAt: Date.now() }, entry.version);
    }
  }

  public async delete(id: SecurityResourceId): Promise<void> {
    const entry = await this.atomic.get<SecurityResource>(`${PREFIX}${id}`);
    if (entry) {
      await this.atomic.set(`${PREFIX}${id}`, null, entry.version);
      const idx = await this.atomic.get<string[]>(INDEX_KEY);
      if (idx) {
        await this.atomic.set(INDEX_KEY, idx.value.filter(i => i !== id), idx.version);
      }
    }
  }
}
