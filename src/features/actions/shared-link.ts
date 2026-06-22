import type { IAtomicStore } from '../../core/store/interfaces.ts';
import type { IAuditWriter } from '../../core/audit/types.ts';
import { AppError } from '../../core/types.ts';
import { generateVersionId } from '../../core/brand.ts';
import type { VersionId } from '../../core/brand.ts';

const PFX = 'shared-link:';
const IDX = 'shared-link:ids';

export interface SharedLink {
  readonly id: string;
  readonly ownerId: string;
  readonly workflowId: string;
  readonly name: string;
  /** bcrypt-style password hash. Empty string = no password required. */
  readonly passwordHash: string;
  readonly expiresAt: number;          // unix ms
  readonly maxUses: number;           // 0 = unlimited
  readonly useCount: number;
  readonly concurrentMax: number;     // 0 = unlimited
  readonly defaultTtlSeconds: number; // container lifetime after start
  readonly enabled: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly version: VersionId;
}

export interface CreateSharedLinkInput {
  readonly workflowId: string;
  readonly name: string;
  readonly password?: string;
  readonly expiresAt: number;
  readonly maxUses?: number;
  readonly concurrentMax?: number;
  readonly defaultTtlSeconds?: number;
}

export class SharedLinkService {
  constructor(
    private readonly atomic: IAtomicStore,
    private readonly audit: IAuditWriter,
  ) {}

  async create(ownerId: string, input: CreateSharedLinkInput): Promise<SharedLink> {
    const id = `sl_${crypto.randomUUID()}`;
    const now = Date.now();

    if (input.expiresAt <= now) throw new AppError(400, 'INVALID_EXPIRY', 'expiresAt must be in the future');

    const passwordHash = input.password
      ? await this.#hashPassword(input.password)
      : '';

    const link: SharedLink = {
      id,
      ownerId,
      workflowId: input.workflowId,
      name: input.name,
      passwordHash,
      expiresAt: input.expiresAt,
      maxUses: input.maxUses ?? 0,
      useCount: 0,
      concurrentMax: input.concurrentMax ?? 0,
      defaultTtlSeconds: input.defaultTtlSeconds ?? 3600,
      enabled: true,
      createdAt: now,
      updatedAt: now,
      version: generateVersionId(),
    };

    await this.atomic.set(PFX + id, link, null);
    const idx = await this.atomic.get<string[]>(IDX);
    await this.atomic.set(IDX, [...(idx?.value ?? []), id], idx?.version ?? null);

    this.audit.write({
      level: 5, facility: 'shared-link',
      message: `SharedLink created: ${input.name} (${id})`,
      metadata: { linkId: id, ownerId, workflowId: input.workflowId },
    } as any);

    return link;
  }

  /**
   * Validate access to a shared link.
   * Checks: enabled, expiry, maxUses, password.
   * Returns the link if access is granted, throws otherwise.
   */
  async validate(id: string, password?: string): Promise<SharedLink> {
    const entry = await this.atomic.get<SharedLink>(PFX + id);
    if (!entry) throw new AppError(404, 'LINK_NOT_FOUND', 'Shared link not found');

    const link = entry.value;
    const now = Date.now();

    if (!link.enabled) throw new AppError(403, 'LINK_DISABLED', 'This shared link has been disabled');
    if (now > link.expiresAt) throw new AppError(403, 'LINK_EXPIRED', 'This shared link has expired');
    if (link.maxUses > 0 && link.useCount >= link.maxUses) {
      throw new AppError(403, 'LINK_EXHAUSTED', 'This shared link has reached its maximum uses');
    }

    if (link.passwordHash) {
      if (!password) throw new AppError(401, 'PASSWORD_REQUIRED', 'Password required');
      const valid = await this.#verifyPassword(password, link.passwordHash);
      if (!valid) throw new AppError(401, 'INVALID_PASSWORD', 'Invalid password');
    }

    return link;
  }

  /** Record a use of the shared link (increment useCount). */
  async recordUse(id: string): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const entry = await this.atomic.get<SharedLink>(PFX + id);
      if (!entry) return;

      const updated: SharedLink = {
        ...entry.value,
        useCount: entry.value.useCount + 1,
        updatedAt: Date.now(),
        version: generateVersionId(),
      };
      const ver = await this.atomic.set(PFX + id, updated, entry.version);
      if (ver) return;
    }
  }

  async disable(id: string, ownerId: string): Promise<void> {
    const entry = await this.atomic.get<SharedLink>(PFX + id);
    if (!entry) throw new AppError(404, 'LINK_NOT_FOUND', 'Shared link not found');
    if (entry.value.ownerId !== ownerId) throw new AppError(403, 'FORBIDDEN', 'Not the owner');

    const updated: SharedLink = { ...entry.value, enabled: false, updatedAt: Date.now(), version: generateVersionId() };
    const ver = await this.atomic.set(PFX + id, updated, entry.version);
    if (!ver) throw new AppError(409, 'CONFLICT', 'Concurrent modification');
  }

  async list(ownerId: string): Promise<SharedLink[]> {
    const idx = await this.atomic.get<string[]>(IDX);
    if (!idx) return [];
    const entries = await Promise.all(
      idx.value.map(i => this.atomic.get<SharedLink>(PFX + i)),
    );
    return entries.filter(e => e && e.value.ownerId === ownerId).map(e => e!.value);
  }

  async get(id: string): Promise<SharedLink | null> {
    const entry = await this.atomic.get<SharedLink>(PFX + id);
    return entry?.value ?? null;
  }

  // ─── Password helpers ───

  async #hashPassword(password: string): Promise<string> {
    const encoder = new TextEncoder();
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
    const hash = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
      key, 256,
    );
    const saltB64 = btoa(String.fromCharCode(...salt));
    const hashB64 = btoa(String.fromCharCode(...new Uint8Array(hash)));
    return `$pbkdf2$${saltB64}$${hashB64}`;
  }

  async #verifyPassword(password: string, stored: string): Promise<boolean> {
    const parts = stored.split('$');
    if (parts.length !== 4 || parts[1] !== 'pbkdf2') return false;
    const salt = Uint8Array.from(atob(parts[2]!), c => c.charCodeAt(0));
    const expectedHash = parts[3]!;

    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
    const hash = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
      key, 256,
    );
    const hashB64 = btoa(String.fromCharCode(...new Uint8Array(hash)));
    return hashB64 === expectedHash;
  }
}
