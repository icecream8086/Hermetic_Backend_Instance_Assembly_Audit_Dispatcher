import type { IAtomicStore, IStoreTransaction } from '../../core/store/interfaces.ts';
import { TransactConflictError } from '../../core/store/interfaces.ts';
import type { ILogWriter } from '../../core/logger/interfaces.ts';
import { createFacility } from '../../core/brand.ts';
import { measure, lastPerf } from '../../core/perf.ts';
import { LogLevel, AppError } from '../../core/types.ts';
import type { IAuditWriter } from '../../core/audit/types.ts';
import { KernLevel } from '../../core/audit/kern-level.ts';
import type { User, UserId, Session, SessionToken, RegisterInput, LoginInput, LoginContext, NoPasswordLoginInput, UpdateUserInput, LoginInfo } from './types.ts';
import { generateUserId, generateSessionToken, createUserId, createSessionToken, UserRole } from './types.ts';

const FACILITY = createFacility('user-service');
const USER_PREFIX = 'user:';
const EMAIL_INDEX_PREFIX = 'user:email:';
const TOKEN_PREFIX = 'session:';
const USER_SESSION_PREFIX = 'user:lastSession:';
const USER_SESSIONS_PREFIX = 'user:sessions:';
/** Number of shards for the user ID index.  Higher = lower OCC contention
 *  on concurrent register/delete.  list() reads all shards in parallel so
 *  the read cost scales linearly with shard count — 16 is a good balance. */
const USER_IDS_SHARDS = 16;
const USER_IDS_SHARD_PREFIX = 'user:idx:';
const USER_COUNT_KEY = 'user:count';

/** Deterministic shard assignment from a UserId (UUID v4). */
function shardIndex(id: UserId): number {
  let hash = 5381;
  const str = String(id);
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) + str.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash) % USER_IDS_SHARDS;
}

const SESSION_TTL_MS = 2 * 60 * 60 * 1000; // 2 小时

// ─── Password hashing (PBKDF2 via Web Crypto) ───

const PBKDF2_ITERATIONS = 10_000;
const SALT_LENGTH = 16;
const HASH_LENGTH = 256; // bits

function bufferToBase64(buf: Uint8Array): string {
  return btoa(String.fromCharCode(...buf));
}

function base64ToBuffer(b64: string): Uint8Array<ArrayBuffer> {
  const rawStr = atob(b64);
  const raw = new Uint8Array(rawStr.length);
  for (let i = 0; i < rawStr.length; i++) raw[i] = rawStr.charCodeAt(i);
  const copy = new Uint8Array<ArrayBuffer>(new ArrayBuffer(raw.length));
  copy.set(raw);
  return copy;
}

function encodeToBuffer(input: string): ArrayBuffer {
  const encoded = new TextEncoder().encode(input);
  const buffer = new ArrayBuffer(encoded.length);
  new Uint8Array(buffer).set(encoded);
  return buffer;
}

export async function hashPassword(password: string): Promise<string> {
  return measure('PBKDF2 hash', async () => {
    const salt = new Uint8Array(crypto.getRandomValues(new Uint8Array(SALT_LENGTH)));
    const key = await crypto.subtle.importKey('raw', encodeToBuffer(password), 'PBKDF2', false, ['deriveBits']);
    const hash = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
      key, HASH_LENGTH,
    );
    return `${bufferToBase64(salt)}:${bufferToBase64(new Uint8Array(hash))}`;
  });
}

async function verifyPassword(password: string, stored: string): Promise<boolean> {
  return measure('PBKDF2 verify', async () => {
    const colon = stored.indexOf(':');
    if (colon === -1) return false;
    const salt = base64ToBuffer(stored.slice(0, colon));
    const expectedHash = stored.slice(colon + 1);
    const key = await crypto.subtle.importKey('raw', encodeToBuffer(password), 'PBKDF2', false, ['deriveBits']);
    const hash = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
      key, HASH_LENGTH,
    );
    return bufferToBase64(new Uint8Array(hash)) === expectedHash;
  });
}

// ─── Base64url helpers ───

function base64UrlDecode(s: string): Uint8Array<ArrayBuffer> {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const raw = atob(s);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

// ─── Nonce replay cache (persisted via atomic store with TTL) ───
// On Workers, in-memory state is lost on cold start — an attacker could
// replay a one-time key within its validity window (±30s).  By storing
// the nonce in the atomic store with a 90-second TTL we survive cold
// starts and still get auto-cleanup.

const NONCE_TTL_S = 90; // ±30s key window + generous margin

async function checkNonce(atomic: IAtomicStore, email: string, nonceB64: string): Promise<boolean> {
  const key = `nonce:${email}:${nonceB64}`;
  const ver = await atomic.set(key, true, null, NONCE_TTL_S);
  return ver !== null;
}

// ─── Login throttle (brute-force protection) — persisted via atomic store ───

const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 60_000;
const ATTEMPT_TTL_S = 90;

async function checkThrottle(atomic: IAtomicStore, email: string, ip?: string): Promise<void> {
  const key = `login:attempts:${ip ? `${email}:${ip}` : email}`;
  const entry = await atomic.get<{ count: number; window: number }>(key);
  if (entry && entry.value.count >= MAX_ATTEMPTS) {
    const elapsed = Date.now() - entry.value.window;
    if (elapsed >= LOCKOUT_MS) return;
    const remaining = Math.ceil((LOCKOUT_MS - elapsed) / 1000);
    throw new AppError(429, 'TOO_MANY_ATTEMPTS', `Too many login attempts. Try again in ${remaining}s`);
  }
}

async function recordAttempt(atomic: IAtomicStore, email: string, success: boolean, ip?: string): Promise<void> {
  const key = `login:attempts:${ip ? `${email}:${ip}` : email}`;
  if (success) {
    const existing = await atomic.get<{ count: number; window: number }>(key);
    if (existing) await atomic.set(key, null, existing.version);
    return;
  }
  const now = Date.now();
  const entry = await atomic.get<{ count: number; window: number }>(key);
  if (entry && now - entry.value.window < LOCKOUT_MS) {
    await atomic.set(key, { count: entry.value.count + 1, window: entry.value.window }, entry.version, ATTEMPT_TTL_S);
  } else {
    await atomic.set(key, { count: 1, window: now }, null, ATTEMPT_TTL_S);
  }
}

// ─── PBKDF2 concurrency gate ───
// Serialises hash operations so N concurrent logins don't spike CPU.
let _hashGate: Promise<void> = Promise.resolve();

function serialisedHash<T>(fn: () => Promise<T>): Promise<T> {
  const prev = _hashGate;
  let release!: () => void;
  _hashGate = new Promise(resolve => { release = resolve; });
  return prev.then(fn).finally(release);
}

// ─── CIDR matcher ───

function ipInCIDR(ip: string, cidr: string): boolean {
  const parts = cidr.split('/');
  const range = parts[0]!;
  const bits = parts[1] ?? '32';
  const mask = ~(2 ** (32 - parseInt(bits)) - 1) >>> 0;
  const ipInt = ip.split('.').reduce((acc, oct) => (acc << 8) + parseInt(oct), 0) >>> 0;
  const rangeInt = range.split('.').reduce((acc, oct) => (acc << 8) + parseInt(oct), 0) >>> 0;
  return (ipInt & mask) === (rangeInt & mask);
}

// ─── Service ───

export interface IUserService {
  register(input: RegisterInput): Promise<{ user: User; token: SessionToken }>;
  login(input: LoginInput, ctx?: LoginContext): Promise<{ user: User; token: SessionToken }>;
  loginNoPassword(input: NoPasswordLoginInput, ctx?: LoginContext): Promise<{ user: User; token: SessionToken }>;
  getById(id: UserId): Promise<User | null>;
  update(id: UserId, input: UpdateUserInput, actorId?: string): Promise<User>;
  delete(id: UserId, actorId?: string): Promise<void>;
  list(): Promise<User[]>;
  listPaginated(page?: number, limit?: number): Promise<{ items: User[]; total: number }>;
  validateToken(token: SessionToken): Promise<User | null>;
  clearLoginPolicy(id: UserId, actorId?: string): Promise<User>;
  clearPublicKey(id: UserId, actorId?: string): Promise<User>;
  getLoginInfo(email: string): Promise<LoginInfo>;
  /** Bust the KV cache for a user and fetch fresh from authoritative store. */
  refresh(id: UserId): Promise<User | null>;

  /** List active session tokens for a user. */
  listSessions(userId: UserId): Promise<readonly SessionToken[]>;

  /** Revoke a specific session token. No-op if already revoked. */
  revokeSession(token: SessionToken, actorId?: string): Promise<void>;
}

export class UserService implements IUserService {
  constructor(
    private readonly atomic: IAtomicStore,
    private readonly logger: ILogWriter,
    private readonly audit?: IAuditWriter,
  ) {}

  async #transactWithRetry<T>(fn: (txn: IStoreTransaction) => Promise<T>, maxRetries = 3): Promise<T> {
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        return await this.atomic.transact(fn);
      } catch (err) {
        if (err instanceof TransactConflictError && attempt < maxRetries - 1) continue;
        throw err;
      }
    }
    throw new AppError(409, 'CONFLICT', 'Transaction failed after retries');
  }

  async register(input: RegisterInput): Promise<{ user: User; token: SessionToken }> {
    const id = generateUserId();
    const passwordHash = await hashPassword(input.password);
    this.logger.logAsync({ facility: FACILITY, level: LogLevel.INFO, message: `PBKDF2 hash: ${lastPerf().toFixed(1)}ms`, metadata: { operation: 'hash', duration: lastPerf() } });
    const now = Date.now();

    const user: User = {
      id,
      email: input.email,
      passwordHash,
      name: input.name,
      role: input.role,
      createdAt: now,
      updatedAt: now,
    };

    // Atomically: write user + email index (uniqueness) + user ID index
    await this.#transactWithRetry(async (txn) => {
      const emailEntry = await txn.get<any>(EMAIL_INDEX_PREFIX + input.email);
      if (emailEntry) throw new AppError(409, 'EMAIL_EXISTS', 'Email already registered');
      const shardKey = USER_IDS_SHARD_PREFIX + shardIndex(id);
      const idx = await txn.get<string[]>(shardKey);
      txn.set(shardKey, [...(idx ?? []), id]);
      txn.set(USER_PREFIX + id, user);
      txn.set(EMAIL_INDEX_PREFIX + input.email, user);
    });

    // Best-effort counter update (outside transaction to avoid cross-shard contention)
    await this.#incrCounter().catch(() => {});

    // Create session token (separate — 'session' prefix maps to different DO shard)
    const token = await this.createSession(id);

    // Auto-join "users" group (Linux-style default group)
    await this.#joinDefaultGroup(id);

    // Root users also join the "root" group to get perm.operator policies
    if (input.role === UserRole.Root) {
      await this.#joinNamedGroup(id, 'root');
    }

    await this.logger.logAsync({
      facility: FACILITY,
      level: LogLevel.INFO,
      message: 'User registered',
      metadata: { userId: id as string, email: input.email, role: input.role },
    });

    await this.audit?.write({
      level: KernLevel.NOTICE,
      facility: FACILITY,
      message: `User registered — ${input.email} (role=${input.role})`,
    });

    return { user, token };
  }

  async login(input: LoginInput, ctx?: LoginContext): Promise<{ user: User; token: SessionToken }> {
    const email = input.email;
    const ip = ctx?.ip;

    // ─── Throttle check ───
    await checkThrottle(this.atomic, email, ip);

    // ─── Credentials ───
    const entry = await this.atomic.get<User>(EMAIL_INDEX_PREFIX + email);
    if (!entry) {
      await recordAttempt(this.atomic, email, false, ip);
      throw new AppError(401, 'INVALID_CREDENTIALS', 'Invalid email or password');
    }

    const user = entry.value;
    const valid = await serialisedHash(() => verifyPassword(input.password, user.passwordHash));
    this.logger.logAsync({ facility: FACILITY, level: LogLevel.INFO, message: `PBKDF2 verify: ${lastPerf().toFixed(1)}ms`, metadata: { operation: 'verify', duration: lastPerf() } });
    if (!valid) {
      await recordAttempt(this.atomic, email, false, ip);
      throw new AppError(401, 'INVALID_CREDENTIALS', 'Invalid email or password');
    }

    // ─── Login policy check ───
    const policy = user.loginPolicy;
    if (policy) {
      if (!policy.enabled) {
        await recordAttempt(this.atomic, email, false, ip);
        throw new AppError(403, 'LOGIN_DISABLED', 'Login disabled for this account');
      }
      if (policy.passwordLoginDisabled) {
        await recordAttempt(this.atomic, email, false, ip);
        throw new AppError(403, 'PASSWORD_LOGIN_DISABLED', 'Password login disabled for this account — use key-based authentication');
      }
      if (policy.timeRanges.length) {
        const now = new Date();
        const mm = String(now.getUTCMinutes()).padStart(2, '0');
        const hh = String(now.getUTCHours()).padStart(2, '0');
        const current = `${hh}:${mm}`;
        const inRange = policy.timeRanges.some(r => current >= r.start && current <= r.end);
        if (!inRange) {
          await recordAttempt(this.atomic, email, false, ip);
          throw new AppError(403, 'LOGIN_TIME_RESTRICTED', 'Login not allowed at this time');
        }
      }
      if (policy.allowedCIDRs.length && ip) {
        const clientIp: string = ip;
        const allowed = policy.allowedCIDRs.some(cidr => ipInCIDR(clientIp, cidr));
        if (!allowed) {
          await recordAttempt(this.atomic, email, false, ip);
          throw new AppError(403, 'LOGIN_IP_RESTRICTED', 'Login not allowed from this IP');
        }
      }
    }

    const token = await this.createSession(user.id);
    await recordAttempt(this.atomic, email, true, ip);

    await this.logger.logAsync({
      facility: FACILITY,
      level: LogLevel.INFO,
      message: 'User logged in',
      metadata: { userId: user.id, email, ip },
    });

    await this.audit?.write({
      level: KernLevel.NOTICE,
      facility: FACILITY,
      message: `User logged in — ${email}${ip ? ` from ${ip}` : ''}`,
    });

    return { user, token };
  }

  async loginNoPassword(input: NoPasswordLoginInput, ctx?: LoginContext): Promise<{ user: User; token: SessionToken }> {
    const email = input.email;
    const ip = ctx?.ip;

    // ─── Throttle ───
    await checkThrottle(this.atomic, email, ip);

    // Decode one-time key: signature_b64url.timestamp_b64url.nonce_b64url
    const parts = input.oneTimeKey.split('.');
    if (parts.length !== 3) { await recordAttempt(this.atomic, email, false, ip); throw new AppError(400, 'BAD_KEY_FORMAT', 'Invalid one-time key format'); }
    const sigB64 = parts[0];
    const tsB64 = parts[1];
    const nonceB64 = parts[2];
    if (!sigB64 || !tsB64 || !nonceB64) { await recordAttempt(this.atomic, email, false, ip); throw new AppError(400, 'BAD_KEY_FORMAT', 'Empty component in one-time key'); }

    // Check timestamp window (±30s)
    let ts: number;
    try {
      ts = parseInt(atob(tsB64.replace(/-/g, '+').replace(/_/g, '/')), 10);
    } catch {
      await recordAttempt(this.atomic, email, false, ip); throw new AppError(400, 'BAD_TIMESTAMP', 'Invalid timestamp encoding');
    }
    if (isNaN(ts)) { await recordAttempt(this.atomic, email, false, ip); throw new AppError(400, 'BAD_TIMESTAMP', 'Invalid timestamp'); }
    const skew = Date.now() - ts * 1000;
    if (Math.abs(skew) > 30_000) { await recordAttempt(this.atomic, email, false, ip); throw new AppError(403, 'KEY_EXPIRED', 'One-time key expired'); }

    // Check nonce replay
    if (!await checkNonce(this.atomic, email, nonceB64)) { await recordAttempt(this.atomic, email, false, ip); throw new AppError(403, 'REPLAY_DETECTED', 'One-time key already used'); }

    // Fetch user by email
    const entry = await this.atomic.get<User>(EMAIL_INDEX_PREFIX + input.email);
    if (!entry) { await recordAttempt(this.atomic, email, false, ip); throw new AppError(401, 'INVALID_CREDENTIALS', 'Invalid email or one-time key'); }
    const user = entry.value;

    // Login policy check
    const policy = user.loginPolicy;
    if (policy) {
      if (!policy.enabled) { await recordAttempt(this.atomic, email, false, ip); throw new AppError(403, 'LOGIN_DISABLED', 'Login disabled for this account'); }
      if (policy.timeRanges.length) {
        const now = new Date();
        const mm = String(now.getUTCMinutes()).padStart(2, '0');
        const hh = String(now.getUTCHours()).padStart(2, '0');
        const current = `${hh}:${mm}`;
        const inRange = policy.timeRanges.some(r => current >= r.start && current <= r.end);
        if (!inRange) { await recordAttempt(this.atomic, email, false, ip); throw new AppError(403, 'LOGIN_TIME_RESTRICTED', 'Login not allowed at this time'); }
      }
      if (policy.allowedCIDRs.length && ctx?.ip) {
        const clientIp: string = ctx.ip;
        const allowed = policy.allowedCIDRs.some(cidr => ipInCIDR(clientIp, cidr));
        if (!allowed) { await recordAttempt(this.atomic, email, false, ip); throw new AppError(403, 'LOGIN_IP_RESTRICTED', 'Login not allowed from this IP'); }
      }
    }

    // Verify public key exists
    const pubKeyB64 = user.publicKeyEd25519;
    if (!pubKeyB64) { await recordAttempt(this.atomic, email, false, ip); throw new AppError(403, 'NO_PUBLIC_KEY', 'No public key configured for this account'); }

    // Verify Ed25519 signature
    let nonceBytes: ReturnType<typeof base64UrlDecode>;
    let signature: ReturnType<typeof base64UrlDecode>;
    try {
      nonceBytes = base64UrlDecode(nonceB64);
      signature = base64UrlDecode(sigB64);
    } catch {
      await recordAttempt(this.atomic, email, false, ip); throw new AppError(400, 'BAD_KEY_FORMAT', 'Invalid base64 encoding in one-time key');
    }
    const message = new Uint8Array(new TextEncoder().encode(`${ts}${input.email}${ctx?.siteContext ?? ''}`));
    const pkRaw = atob(pubKeyB64);
    const publicKeyBytes = new Uint8Array(pkRaw.length);
    for (let i = 0; i < pkRaw.length; i++) publicKeyBytes[i] = pkRaw.charCodeAt(i);

    let valid: boolean;
    try {
      const key = await crypto.subtle.importKey('raw', publicKeyBytes, { name: 'Ed25519' }, false, ['verify']);
      const signedData = new Uint8Array(message.length + nonceBytes.length);
      signedData.set(message, 0);
      signedData.set(nonceBytes, message.length);
      valid = await crypto.subtle.verify({ name: 'Ed25519' }, key, signature, signedData);
    } catch {
      await recordAttempt(this.atomic, email, false, ip);
      throw new AppError(500, 'VERIFY_FAILED', 'Signature verification failed');
    }
    if (!valid) { await recordAttempt(this.atomic, email, false, ip); throw new AppError(403, 'BAD_SIGNATURE', 'Invalid signature'); }

    // Success
    const token = await this.createSession(user.id);
    await recordAttempt(this.atomic, input.email, true, ctx?.ip);

    await this.logger.logAsync({
      facility: FACILITY,
      level: LogLevel.INFO,
      message: 'User logged in (no-password)',
      metadata: { userId: user.id, email: user.email, ip: ctx?.ip },
    });

    await this.audit?.write({
      level: KernLevel.NOTICE,
      facility: FACILITY,
      message: `User logged in (no-password) — ${user.email}${ctx?.ip ? ` from ${ctx.ip}` : ''}`,
    });

    return { user, token };
  }

  async getById(id: UserId): Promise<User | null> {
    const entry = await this.atomic.get<User>(USER_PREFIX + id);
    return entry?.value ?? null;
  }

  async refresh(id: UserId): Promise<User | null> {
    // Evict KV cache → next getById() misses cache and re-fetches from DO
    await this.atomic.invalidateCache?.(USER_PREFIX + id);
    return this.getById(id);
  }

  async update(id: UserId, input: UpdateUserInput, actorId?: string): Promise<User> {
    const entry = await this.atomic.get<User>(USER_PREFIX + id);
    if (!entry) throw new AppError(404, 'USER_NOT_FOUND', 'User not found');

    const updated: User = {
      ...entry.value,
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.role !== undefined ? { role: input.role } : {}),
      ...(input.password !== undefined ? { passwordHash: await hashPassword(input.password) } : {}),
      ...(input.loginPolicy !== undefined ? { loginPolicy: input.loginPolicy } : {}),
      ...(input.publicKeyEd25519 !== undefined ? { publicKeyEd25519: input.publicKeyEd25519 } : {}),
      updatedAt: Date.now(),
    };

    if (input.password !== undefined) {
      this.logger.logAsync({ facility: FACILITY, level: LogLevel.INFO, message: `PBKDF2 hash: ${lastPerf().toFixed(1)}ms`, metadata: { operation: 'hash', duration: lastPerf() } });
    }

    const newVersion = await this.atomic.set(USER_PREFIX + id, updated, entry.version);
    if (!newVersion) throw new AppError(409, 'CONFLICT', 'Concurrent modification detected');

    // Sync email index so login() reads fresh data (including loginPolicy)
    const emailEntry = await this.atomic.get<User>(EMAIL_INDEX_PREFIX + updated.email);
    if (emailEntry) {
      await this.atomic.set(EMAIL_INDEX_PREFIX + updated.email, updated, emailEntry.version);
    }

    await this.logger.logAsync({
      facility: FACILITY,
      level: LogLevel.INFO,
      message: 'User updated',
      metadata: { userId: id as string },
    });

    await this.audit?.write({
      level: KernLevel.INFO,
      facility: FACILITY,
      message: `User profile updated — ${updated.email}`,
      metadata: { eventType: 'user.updated', userId: id as string, actorId },
    });

    return updated;
  }

  async delete(id: UserId, actorId?: string): Promise<void> {
    const entry = await this.atomic.get<User>(USER_PREFIX + id);
    if (!entry) throw new AppError(404, 'USER_NOT_FOUND', 'User not found');

    const email = entry.value.email;

    // Atomically: tombstone user + remove email index + remove from ID index
    await this.#transactWithRetry(async (txn) => {
      const e = await txn.get<User>(USER_PREFIX + id);
      if (!e) throw new AppError(404, 'USER_NOT_FOUND', 'User not found');
      const shardKey = USER_IDS_SHARD_PREFIX + shardIndex(id);
      const idx = await txn.get<string[]>(shardKey);
      if (idx) txn.set(shardKey, idx.filter((i: string) => i !== id));
      txn.set(USER_PREFIX + id, null);
      const emEntry = await txn.get<any>(EMAIL_INDEX_PREFIX + email);
      if (emEntry) txn.set(EMAIL_INDEX_PREFIX + email, null);
    });

    // Best-effort counter update
    await this.#decrCounter().catch(() => {});

    await this.logger.logAsync({
      facility: FACILITY,
      level: LogLevel.INFO,
      message: 'User deleted',
      metadata: { userId: id as string, email },
    });

    await this.audit?.write({
      level: KernLevel.WARNING,
      facility: FACILITY,
      message: `User deleted — ${email}`,
      metadata: { eventType: 'user.deleted', userId: id as string, email, actorId },
    });
  }

  /** Increment user count — best-effort, OCC retry ×3. */
  async #incrCounter(): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const entry = await this.atomic.get<number>(USER_COUNT_KEY);
      const ver = await this.atomic.set(USER_COUNT_KEY, (entry?.value ?? 0) + 1, entry?.version ?? null);
      if (ver) return;
    }
  }

  /** Decrement user count — best-effort, OCC retry ×3. */
  async #decrCounter(): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const entry = await this.atomic.get<number>(USER_COUNT_KEY);
      const cur = entry?.value ?? 0;
      if (cur <= 0) return;
      const ver = await this.atomic.set(USER_COUNT_KEY, cur - 1, entry?.version ?? null);
      if (ver) return;
    }
  }

  async list(): Promise<User[]> {
    // Read all shards in parallel, then merge.
    const shardKeys = Array.from(
      { length: USER_IDS_SHARDS },
      (_, i) => USER_IDS_SHARD_PREFIX + i,
    );
    const shards = await Promise.all(shardKeys.map(k => this.atomic.get<string[]>(k)));
    const ids = shards.flatMap(s => s?.value ?? []);
    if (ids.length === 0) return [];

    const users = await Promise.all(ids.map(id => this.atomic.get<User>(USER_PREFIX + id)));
    return users.filter((u): u is NonNullable<typeof u> => u !== null).map(u => u.value);
  }

  async listPaginated(page = 1, limit = 50): Promise<{ items: User[]; total: number }> {
    // Read total from counter (1 I/O) — avoids reading all 16 shard indices.
    const countEntry = await this.atomic.get<number>(USER_COUNT_KEY);
    const total = countEntry?.value ?? 0;
    if (total === 0) return { items: [], total };

    const start = (page - 1) * limit;
    if (start >= total) return { items: [], total };

    // Scan shards sequentially, collecting only enough IDs for the requested page.
    const pageIds: string[] = [];
    let remaining = limit;
    let skip = start;

    for (let i = 0; i < USER_IDS_SHARDS && remaining > 0; i++) {
      const shard = await this.atomic.get<string[]>(USER_IDS_SHARD_PREFIX + i);
      const ids = shard?.value ?? [];
      if (ids.length === 0) continue;

      if (skip >= ids.length) {
        skip -= ids.length;
        continue;
      }

      const take = Math.min(ids.length - skip, remaining);
      pageIds.push(...ids.slice(skip, skip + take));
      remaining -= take;
      skip = 0;
    }

    if (pageIds.length === 0) return { items: [], total };

    const users = await Promise.all(pageIds.map(id => this.atomic.get<User>(USER_PREFIX + id)));
    const items = users.filter((u): u is NonNullable<typeof u> => u !== null).map(u => u.value);
    return { items, total };
  }

  async clearLoginPolicy(id: UserId, actorId?: string): Promise<User> {
    const entry = await this.atomic.get<User>(USER_PREFIX + id);
    if (!entry) throw new AppError(404, 'USER_NOT_FOUND', 'User not found');

    const { loginPolicy: _p, ...rest } = entry.value;
    const updated: User = { ...rest, updatedAt: Date.now() };
    const newVersion = await this.atomic.set(USER_PREFIX + id, updated, entry.version);
    if (!newVersion) throw new AppError(409, 'CONFLICT', 'Concurrent modification detected');

    const emailEntry = await this.atomic.get<User>(EMAIL_INDEX_PREFIX + updated.email);
    if (emailEntry) await this.atomic.set(EMAIL_INDEX_PREFIX + updated.email, updated, emailEntry.version);

    await this.audit?.write({
      level: KernLevel.NOTICE,
      facility: FACILITY,
      message: `Login policy cleared for user — ${updated.email}`,
      metadata: { eventType: 'user.loginPolicy.cleared', userId: id as string, actorId },
    });

    return updated;
  }

  async clearPublicKey(id: UserId, actorId?: string): Promise<User> {
    const entry = await this.atomic.get<User>(USER_PREFIX + id);
    if (!entry) throw new AppError(404, 'USER_NOT_FOUND', 'User not found');
    const { publicKeyEd25519: _k, ...rest } = entry.value;
    const updated: User = { ...rest, updatedAt: Date.now() };
    const newVersion = await this.atomic.set(USER_PREFIX + id, updated, entry.version);
    if (!newVersion) throw new AppError(409, 'CONFLICT', 'Concurrent modification detected');
    const emailEntry = await this.atomic.get<User>(EMAIL_INDEX_PREFIX + updated.email);
    if (emailEntry) await this.atomic.set(EMAIL_INDEX_PREFIX + updated.email, updated, emailEntry.version);

    await this.audit?.write({
      level: KernLevel.NOTICE,
      facility: FACILITY,
      message: `Public key cleared for user — ${updated.email}`,
      metadata: { eventType: 'user.publicKey.cleared', userId: id as string, actorId },
    });

    return updated;
  }

  async getLoginInfo(email: string): Promise<LoginInfo> {
    const entry = await this.atomic.get<User>(EMAIL_INDEX_PREFIX + email);
    if (!entry) return { exists: false, methods: [] };

    const user = entry.value;
    const methods: ('password' | 'no-password')[] = [];
    if (!user.loginPolicy?.passwordLoginDisabled) methods.push('password');
    if (user.publicKeyEd25519) methods.push('no-password');

    const policy = user.loginPolicy;
    if (!policy) return { exists: true, methods };

    return {
      exists: true,
      methods,
      policy: {
        enabled: policy.enabled,
        disabled: !policy.enabled,
        timeRestricted: !!(policy.timeRanges.length),
        timeRanges: policy.timeRanges,
      },
    };
  }

  async validateToken(token: SessionToken): Promise<User | null> {
    const entry = await this.atomic.get<Session>(TOKEN_PREFIX + token);
    if (!entry) return null;
    const expiresAt = entry.value.expiresAt ?? entry.value.createdAt + SESSION_TTL_MS;
    if (Date.now() >= expiresAt) return null;
    const userId = createUserId(entry.value.userId);
    return this.getById(userId);
  }

  private async createSession(userId: UserId): Promise<SessionToken> {
    // Reuse active session within TTL
    const idxEntry = await this.atomic.get<string>(USER_SESSION_PREFIX + userId);
    if (idxEntry) {
      const existingToken = createSessionToken(idxEntry.value);
      const sessEntry = await this.atomic.get<Session>(TOKEN_PREFIX + existingToken);
      if (sessEntry) {
        const expiresAt = sessEntry.value.expiresAt ?? sessEntry.value.createdAt + SESSION_TTL_MS;
        if (Date.now() < expiresAt) {
          return existingToken;
        }
      }
    }

    const now = Date.now();
    const token = generateSessionToken();
    const session: Session = {
      token,
      userId,
      createdAt: now,
      expiresAt: now + SESSION_TTL_MS,
    };
    await this.atomic.set(TOKEN_PREFIX + token, session, null);
    await this.atomic.set(USER_SESSION_PREFIX + userId, token, idxEntry?.version ?? null);

    // Track session in per-user list for revocation
    const sessIdx = await this.atomic.get<string[]>(USER_SESSIONS_PREFIX + userId);
    await this.atomic.set(
      USER_SESSIONS_PREFIX + userId,
      [...(sessIdx?.value ?? []), token],
      sessIdx?.version ?? null,
    );
    return token;
  }

  async listSessions(userId: UserId): Promise<readonly SessionToken[]> {
    const entry = await this.atomic.get<string[]>(USER_SESSIONS_PREFIX + userId);
    if (!entry) return [];
    const live: SessionToken[] = [];
    const expired: string[] = [];
    const now = Date.now();
    for (const raw of entry.value) {
      const t = createSessionToken(raw);
      const s = await this.atomic.get<Session>(TOKEN_PREFIX + t);
      if (s) {
        const expiresAt = s.value.expiresAt ?? s.value.createdAt + SESSION_TTL_MS;
        if (now < expiresAt) live.push(t);
        else expired.push(t);
      }
    }
    // Clean up expired sessions from index
    if (expired.length > 0) {
      const remaining = entry.value.filter(r => !expired.includes(r));
      await this.atomic.set(USER_SESSIONS_PREFIX + userId, remaining, entry.version);
      // Best-effort remove from store
      await Promise.allSettled(expired.map(t => this.atomic.set(TOKEN_PREFIX + createSessionToken(t), null, null)));
    }
    return live;
  }

  async revokeSession(token: SessionToken, actorId?: string): Promise<void> {
    // Read session before deleting to find userId for index cleanup
    const entry = await this.atomic.get<Session>(TOKEN_PREFIX + token);
    if (!entry) return;
    const userId = entry.value.userId;

    // Remove from store
    await this.atomic.set(TOKEN_PREFIX + token, null, entry.version);

    // Remove from user's session index
    const sessIdx = await this.atomic.get<string[]>(USER_SESSIONS_PREFIX + userId);
    if (sessIdx) {
      await this.atomic.set(
        USER_SESSIONS_PREFIX + userId,
        sessIdx.value.filter(t => t !== token),
        sessIdx.version,
      );
    }

    await this.audit?.write({
      level: KernLevel.INFO,
      facility: FACILITY,
      message: `Session revoked for user ${userId}`,
      metadata: { eventType: 'user.session.revoked', userId: userId as string, tokenHint: (token as string).slice(-4), actorId },
    });
  }

  /** Auto-join "users" group on registration (Linux-style). */
  async #joinDefaultGroup(userId: UserId): Promise<void> {
    return this.#joinNamedGroup(userId, 'users');
  }

  /** Add a user to a named user group by group name. */
  async #joinNamedGroup(userId: UserId, groupName: string): Promise<void> {
    try {
      const ugEntry = await this.atomic.get<string[]>('usergroup:ids');
      if (!ugEntry) return;
      for (const id of ugEntry.value) {
        const g = await this.atomic.get<any>('usergroup:' + id);
        if (g?.value?.name === groupName) {
          if (!g.value.memberIds.includes(userId)) {
            g.value.memberIds.push(userId);
            g.value.updatedAt = Date.now();
            await this.atomic.set('usergroup:' + id, g.value, g.version);
          }
          return;
        }
      }
    } catch {
      // Silently ignore — group may not exist yet
    }
  }

}
