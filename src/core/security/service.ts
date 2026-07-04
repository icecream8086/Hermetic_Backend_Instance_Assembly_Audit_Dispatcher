import type { IAtomicStore } from '../store/interfaces.ts';
import type { IAuditWriter } from '../audit/types.ts';
import type {
  SecurityResource, SecurityResourceId, CreateSecurityResourceInput,
} from './types.ts';
import { SecurityResourceStatus } from './types.ts';
import { createSecurityResourceId } from './types.ts';
import type { S3AccessTokenClaims } from './types.ts';
import { signToken, base64url, base64urlDecode } from './jwt.ts';

const PREFIX = 'security:';
const INDEX_KEY = 'security:ids';
const JWT_SECRET_KEY = '_sys:jwt-secret';

async function getJwtSecret(atomic: IAtomicStore): Promise<Uint8Array> {
  const entry = await atomic.get<string>(JWT_SECRET_KEY);
  if (entry?.value) {
    return base64urlDecode(entry.value);
  }
  // Auto-generate on first use
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  await atomic.set(JWT_SECRET_KEY, base64url(bytes.buffer), null);
  return bytes;
}

export class SecurityResourceService {
  public constructor(
    private readonly atomic: IAtomicStore,
    _audit: IAuditWriter,
  ) {}

  // ── Provision (policy entity, not URLs) ──

  public async provision(input: CreateSecurityResourceInput): Promise<SecurityResource> {
    const now = Date.now();
    const id = createSecurityResourceId(crypto.randomUUID());
    const resource: SecurityResource = {
      id, name: input.name,
      bucketId: input.bucketId,
      instanceId: input.instanceId,
      tokenTtl: input.tokenTtl ?? 3600,
      presignedUrlTtl: input.presignedUrlTtl ?? 300,
      accessPolicy: input.accessPolicy ?? [{ prefix: '', permissions: ['read', 'write', 'list'] }],
      status: SecurityResourceStatus.Active,
      createdAt: now, updatedAt: now,
    };

    await this.atomic.set(`${PREFIX}${id}`, resource, null);
    for (let attempt = 0; attempt < 3; attempt++) {
      const idx = await this.atomic.get<string[]>(INDEX_KEY);
      const ok = await this.atomic.set(INDEX_KEY, [...(idx?.value ?? []), id], idx?.version ?? null);
      if (ok) break;
    }
    return resource;
  }

  // ── Issue JWT for sandbox ──

  /**
   * Issue a JWT token encoding the access policy from all given SecurityResources.
   * Call at sandbox provision time. Token is injected into the container.
   */
  public async issueToken(
    resourceNames: readonly string[],
    sandboxId: string,
  ): Promise<{ token: string; expiresAt: string }> {
    const resources = await Promise.all(
      resourceNames.map(name => this.getByName(name)),
    );
    const found = resources.filter((r): r is SecurityResource => r !== null);
    if (found.length !== resourceNames.length) {
      const missing = resourceNames.filter(
        name => !found.some(r => r.name === name),
      );
      throw new Error(`SecurityResource(s) not found: ${missing.join(', ')}`);
    }

    const now = Math.floor(Date.now() / 1000);
    const ttl = Math.min(...found.map(r => r.tokenTtl));

    const claims: S3AccessTokenClaims = {
      jti: crypto.randomUUID(),
      iss: 'hbi-aad',
      sub: sandboxId,
      iat: now,
      exp: now + ttl,
      grants: found.flatMap(r =>
        r.accessPolicy.map(entry => ({
          bucket: r.bucketId,
          prefix: entry.prefix,
          permissions: entry.permissions,
        })),
      ),
    };

    const secret = await getJwtSecret(this.atomic);
    const token = await signToken(claims, secret);
    return {
      token,
      expiresAt: new Date((now + ttl) * 1000).toISOString(),
    };
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

  public async getByBucketId(bucketId: string): Promise<SecurityResource | null> {
    const all = await this.list();
    return all.find(r => r.bucketId === bucketId) ?? null;
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

  // ── Status management ──

  public async markExpired(id: SecurityResourceId): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const entry = await this.atomic.get<SecurityResource>(`${PREFIX}${id}`);
      if (!entry?.value) return;
      const ok = await this.atomic.set(`${PREFIX}${id}`, {
        ...entry.value, status: SecurityResourceStatus.Expired, updatedAt: Date.now(),
      }, entry.version);
      if (ok) return;
    }
  }

  public async revoke(id: SecurityResourceId): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const entry = await this.atomic.get<SecurityResource>(`${PREFIX}${id}`);
      if (!entry?.value) return;
      const ok = await this.atomic.set(`${PREFIX}${id}`, {
        ...entry.value, status: SecurityResourceStatus.Revoked, updatedAt: Date.now(),
      }, entry.version);
      if (ok) return;
    }
  }

  public async delete(id: SecurityResourceId): Promise<void> {
    const entry = await this.atomic.get<SecurityResource>(`${PREFIX}${id}`);
    if (entry) {
      await this.atomic.set(`${PREFIX}${id}`, null, entry.version);
      for (let attempt = 0; attempt < 3; attempt++) {
        const idx = await this.atomic.get<string[]>(INDEX_KEY);
        if (!idx) break;
        const ok = await this.atomic.set(INDEX_KEY, idx.value.filter(i => i !== id), idx.version);
        if (ok) break;
      }
    }
  }
}
