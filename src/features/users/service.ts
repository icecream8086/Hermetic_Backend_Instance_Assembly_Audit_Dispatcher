import type { IAtomicStore } from '../../core/store/interfaces.ts';
import type { ILogWriter } from '../../core/logger/interfaces.ts';
import { createFacility } from '../../core/brand.ts';
import { measure, lastPerf } from '../../core/perf.ts';
import { LogLevel, AppError } from '../../core/types.ts';
import type { IAuditWriter } from '../../core/audit/types.ts';
import { KernLevel } from '../../core/audit/kern-level.ts';
import type { User, UserId, Session, SessionToken, RegisterInput, LoginInput, LoginContext, NoPasswordLoginInput, UpdateUserInput, LoginInfo } from './types.ts';
import { generateUserId, generateSessionToken, createUserId, createSessionToken } from './types.ts';

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

async function hashPassword(password: string): Promise<string> {
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

// ─── Nonce replay cache ───

const _nonceCache = new Map<string, number>();

function checkNonce(email: string, nonceB64: string): boolean {
  const key = `${email}:${nonceB64}`;
  const now = Date.now();
  // Map is self-limiting (TTL × login rate). Per-key check only — no O(n) scan.
  if (_nonceCache.has(key)) return false; // replay
  _nonceCache.set(key, now);
  return true;
}

// ─── Login throttle (brute-force protection) ───

const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 60_000;
const _attempts = new Map<string, { count: number; window: number }>();

function checkThrottle(email: string, ip?: string): void {
  const key = ip ? `${email}:${ip}` : email;
  const now = Date.now();
  const entry = _attempts.get(key);
  if (entry && entry.count >= MAX_ATTEMPTS) {
    const elapsed = now - entry.window;
    if (elapsed >= LOCKOUT_MS) {
      _attempts.delete(key);
      return;
    }
    const remaining = Math.ceil((LOCKOUT_MS - elapsed) / 1000);
    throw new AppError(429, 'TOO_MANY_ATTEMPTS', `Too many login attempts. Try again in ${remaining}s`);
  }
}

function recordAttempt(email: string, success: boolean, ip?: string): void {
  const key = ip ? `${email}:${ip}` : email;
  if (success) {
    _attempts.delete(key);
    return;
  }
  const now = Date.now();
  const entry = _attempts.get(key);
  if (entry && now - entry.window < LOCKOUT_MS) {
    entry.count++;
  } else {
    _attempts.set(key, { count: 1, window: now });
  }
  // Trim stale entries once in a while
  if (_attempts.size > 1000) {
    const cutoff = now - LOCKOUT_MS;
    for (const [k, v] of _attempts) {
      if (v.window < cutoff) _attempts.delete(k);
    }
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
  update(id: UserId, input: UpdateUserInput): Promise<User>;
  delete(id: UserId): Promise<void>;
  list(): Promise<User[]>;
  validateToken(token: SessionToken): Promise<User | null>;
  clearLoginPolicy(id: UserId): Promise<User>;
  clearPublicKey(id: UserId): Promise<User>;
  getLoginInfo(email: string): Promise<LoginInfo>;
  /** Bust the KV cache for a user and fetch fresh from authoritative store. */
  refresh(id: UserId): Promise<User | null>;

  /** List active session tokens for a user. */
  listSessions(userId: UserId): Promise<readonly SessionToken[]>;

  /** Revoke a specific session token. No-op if already revoked. */
  revokeSession(token: SessionToken): Promise<void>;
}

export class UserService implements IUserService {
  constructor(
    private readonly atomic: IAtomicStore,
    private readonly logger: ILogWriter,
    private readonly audit?: IAuditWriter,
  ) {}

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

    // Write user first (UUID key, no collision possible)
    const userVersion = await this.atomic.set(USER_PREFIX + id, user, null);
    if (!userVersion) throw new AppError(500, 'CREATE_FAILED', 'Failed to persist user');

    // Email index with OCC create-only — this is the actual uniqueness gate.
    // expectedVersion=null asserts the key must NOT exist, so concurrent
    // registrations with the same email are correctly rejected.
    const emailVersion = await this.atomic.set(EMAIL_INDEX_PREFIX + input.email, user, null);
    if (!emailVersion) {
      // Rollback: remove the user record we just created
      await this.atomic.set(USER_PREFIX + id, null, userVersion);
      throw new AppError(409, 'EMAIL_EXISTS', 'Email already registered');
    }

    // Create session token
    const token = await this.createSession(id);

    // Append to user ID index for list()
    await this.#addToIndex(id);

    // Auto-join "users" group (Linux-style default group)
    await this.#joinDefaultGroup(id);

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
    checkThrottle(email, ip);

    // ─── Credentials ───
    const entry = await this.atomic.get<User>(EMAIL_INDEX_PREFIX + email);
    if (!entry) {
      recordAttempt(email, false, ip);
      throw new AppError(401, 'INVALID_CREDENTIALS', 'Invalid email or password');
    }

    const user = entry.value;
    const valid = await serialisedHash(() => verifyPassword(input.password, user.passwordHash));
    this.logger.logAsync({ facility: FACILITY, level: LogLevel.INFO, message: `PBKDF2 verify: ${lastPerf().toFixed(1)}ms`, metadata: { operation: 'verify', duration: lastPerf() } });
    if (!valid) {
      recordAttempt(email, false, ip);
      throw new AppError(401, 'INVALID_CREDENTIALS', 'Invalid email or password');
    }

    // ─── Login policy check ───
    const policy = user.loginPolicy;
    if (policy) {
      if (!policy.enabled) {
        recordAttempt(email, false, ip);
        throw new AppError(403, 'LOGIN_DISABLED', 'Login disabled for this account');
      }
      if (policy.timeRanges.length) {
        const now = new Date();
        const mm = String(now.getUTCMinutes()).padStart(2, '0');
        const hh = String(now.getUTCHours()).padStart(2, '0');
        const current = `${hh}:${mm}`;
        const inRange = policy.timeRanges.some(r => current >= r.start && current <= r.end);
        if (!inRange) {
          recordAttempt(email, false, ip);
          throw new AppError(403, 'LOGIN_TIME_RESTRICTED', 'Login not allowed at this time');
        }
      }
      if (policy.allowedCIDRs.length && ip) {
        const clientIp: string = ip;
        const allowed = policy.allowedCIDRs.some(cidr => ipInCIDR(clientIp, cidr));
        if (!allowed) {
          recordAttempt(email, false, ip);
          throw new AppError(403, 'LOGIN_IP_RESTRICTED', 'Login not allowed from this IP');
        }
      }
    }

    const token = await this.createSession(user.id);
    recordAttempt(email, true, ip);

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
    checkThrottle(email, ip);

    // Decode one-time key: signature_b64url.timestamp_b64url.nonce_b64url
    const parts = input.oneTimeKey.split('.');
    if (parts.length !== 3) { recordAttempt(email, false, ip); throw new AppError(400, 'BAD_KEY_FORMAT', 'Invalid one-time key format'); }
    const sigB64 = parts[0];
    const tsB64 = parts[1];
    const nonceB64 = parts[2];
    if (!sigB64 || !tsB64 || !nonceB64) { recordAttempt(email, false, ip); throw new AppError(400, 'BAD_KEY_FORMAT', 'Empty component in one-time key'); }

    // Check timestamp window (±30s)
    let ts: number;
    try {
      ts = parseInt(atob(tsB64.replace(/-/g, '+').replace(/_/g, '/')), 10);
    } catch {
      recordAttempt(email, false, ip); throw new AppError(400, 'BAD_TIMESTAMP', 'Invalid timestamp encoding');
    }
    if (isNaN(ts)) { recordAttempt(email, false, ip); throw new AppError(400, 'BAD_TIMESTAMP', 'Invalid timestamp'); }
    const skew = Date.now() - ts * 1000;
    if (Math.abs(skew) > 30_000) { recordAttempt(email, false, ip); throw new AppError(403, 'KEY_EXPIRED', 'One-time key expired'); }

    // Check nonce replay
    if (!checkNonce(email, nonceB64)) { recordAttempt(email, false, ip); throw new AppError(403, 'REPLAY_DETECTED', 'One-time key already used'); }

    // Fetch user by email
    const entry = await this.atomic.get<User>(EMAIL_INDEX_PREFIX + input.email);
    if (!entry) { recordAttempt(email, false, ip); throw new AppError(401, 'INVALID_CREDENTIALS', 'Invalid email or one-time key'); }
    const user = entry.value;

    // Login policy check
    const policy = user.loginPolicy;
    if (policy) {
      if (!policy.enabled) { recordAttempt(email, false, ip); throw new AppError(403, 'LOGIN_DISABLED', 'Login disabled for this account'); }
      if (policy.timeRanges.length) {
        const now = new Date();
        const mm = String(now.getUTCMinutes()).padStart(2, '0');
        const hh = String(now.getUTCHours()).padStart(2, '0');
        const current = `${hh}:${mm}`;
        const inRange = policy.timeRanges.some(r => current >= r.start && current <= r.end);
        if (!inRange) { recordAttempt(email, false, ip); throw new AppError(403, 'LOGIN_TIME_RESTRICTED', 'Login not allowed at this time'); }
      }
      if (policy.allowedCIDRs.length && ctx?.ip) {
        const clientIp: string = ctx.ip;
        const allowed = policy.allowedCIDRs.some(cidr => ipInCIDR(clientIp, cidr));
        if (!allowed) { recordAttempt(email, false, ip); throw new AppError(403, 'LOGIN_IP_RESTRICTED', 'Login not allowed from this IP'); }
      }
    }

    // Verify public key exists
    const pubKeyB64 = user.publicKeyEd25519;
    if (!pubKeyB64) { recordAttempt(email, false, ip); throw new AppError(403, 'NO_PUBLIC_KEY', 'No public key configured for this account'); }

    // Verify Ed25519 signature
    let nonceBytes: ReturnType<typeof base64UrlDecode>;
    let signature: ReturnType<typeof base64UrlDecode>;
    try {
      nonceBytes = base64UrlDecode(nonceB64);
      signature = base64UrlDecode(sigB64);
    } catch {
      recordAttempt(email, false, ip); throw new AppError(400, 'BAD_KEY_FORMAT', 'Invalid base64 encoding in one-time key');
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
      recordAttempt(email, false, ip);
      throw new AppError(500, 'VERIFY_FAILED', 'Signature verification failed');
    }
    if (!valid) { recordAttempt(email, false, ip); throw new AppError(403, 'BAD_SIGNATURE', 'Invalid signature'); }

    // Success
    const token = await this.createSession(user.id);
    recordAttempt(input.email, true, ctx?.ip);

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

  async update(id: UserId, input: UpdateUserInput): Promise<User> {
    const entry = await this.atomic.get<User>(USER_PREFIX + id);
    if (!entry) throw new AppError(404, 'USER_NOT_FOUND', 'User not found');

    const updated: User = {
      ...entry.value,
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.role !== undefined ? { role: input.role } : {}),
      ...(input.password !== undefined ? { passwordHash: await hashPassword(input.password) } : {}),
      ...(input.loginPolicy !== undefined ? { loginPolicy: input.loginPolicy } : {}),
      ...(input.publicKeyEd25519 !== undefined ? { publicKeyEd25519: input.publicKeyEd25519 } : {}),
      ...(input.privateKeyEd25519 !== undefined ? { privateKeyEd25519: input.privateKeyEd25519 } : {}),
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

    return updated;
  }

  async delete(id: UserId): Promise<void> {
    const entry = await this.atomic.get<User>(USER_PREFIX + id);
    if (!entry) throw new AppError(404, 'USER_NOT_FOUND', 'User not found');

    const email = entry.value.email;

    // Delete using OCC: storing null as tombstone, which get() treats as not-found
    const deleted = await this.atomic.set(USER_PREFIX + id, null, entry.version);
    if (!deleted) throw new AppError(409, 'CONFLICT', 'Concurrent modification detected');

    // Best-effort email index cleanup
    const emailEntry = await this.atomic.get<User>(EMAIL_INDEX_PREFIX + email);
    if (emailEntry) {
      await this.atomic.set(EMAIL_INDEX_PREFIX + email, null, emailEntry.version);
    }

    // Remove from ID index
    await this.#removeFromIndex(id);

    await this.logger.logAsync({
      facility: FACILITY,
      level: LogLevel.INFO,
      message: 'User deleted',
      metadata: { userId: id as string, email },
    });
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

  async clearLoginPolicy(id: UserId): Promise<User> {
    const entry = await this.atomic.get<User>(USER_PREFIX + id);
    if (!entry) throw new AppError(404, 'USER_NOT_FOUND', 'User not found');

    const { loginPolicy: _p, ...rest } = entry.value;
    const updated: User = { ...rest, updatedAt: Date.now() };
    const newVersion = await this.atomic.set(USER_PREFIX + id, updated, entry.version);
    if (!newVersion) throw new AppError(409, 'CONFLICT', 'Concurrent modification detected');

    const emailEntry = await this.atomic.get<User>(EMAIL_INDEX_PREFIX + updated.email);
    if (emailEntry) await this.atomic.set(EMAIL_INDEX_PREFIX + updated.email, updated, emailEntry.version);

    return updated;
  }

  async clearPublicKey(id: UserId): Promise<User> {
    const entry = await this.atomic.get<User>(USER_PREFIX + id);
    if (!entry) throw new AppError(404, 'USER_NOT_FOUND', 'User not found');
    const { publicKeyEd25519: _k, ...rest } = entry.value;
    const updated: User = { ...rest, updatedAt: Date.now() };
    const newVersion = await this.atomic.set(USER_PREFIX + id, updated, entry.version);
    if (!newVersion) throw new AppError(409, 'CONFLICT', 'Concurrent modification detected');
    const emailEntry = await this.atomic.get<User>(EMAIL_INDEX_PREFIX + updated.email);
    if (emailEntry) await this.atomic.set(EMAIL_INDEX_PREFIX + updated.email, updated, emailEntry.version);
    return updated;
  }

  async getLoginInfo(email: string): Promise<LoginInfo> {
    const entry = await this.atomic.get<User>(EMAIL_INDEX_PREFIX + email);
    if (!entry) return { exists: false, methods: [] };

    const user = entry.value;
    const methods: ('password' | 'no-password')[] = ['password'];
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
    const entry = await this.atomic.get<{ userId: string }>(TOKEN_PREFIX + token);
    if (!entry) return null;
    const userId = createUserId(entry.value.userId);
    return this.getById(userId);
  }

  private async createSession(userId: UserId): Promise<SessionToken> {
    // 复用 2 小时内活跃 session
    const idxEntry = await this.atomic.get<string>(USER_SESSION_PREFIX + userId);
    if (idxEntry) {
      const existingToken = createSessionToken(idxEntry.value);
      const sessEntry = await this.atomic.get<Session>(TOKEN_PREFIX + existingToken);
      if (sessEntry) {
        const age = Date.now() - sessEntry.value.createdAt;
        if (age < SESSION_TTL_MS) {
          return existingToken;
        }
      }
    }

    const token = generateSessionToken();
    const session: Session = {
      token,
      userId,
      createdAt: Date.now(),
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
    // Filter out expired sessions (still in index but TTL-expired in store)
    const live: SessionToken[] = [];
    for (const raw of entry.value) {
      const t = createSessionToken(raw);
      const s = await this.atomic.get<Session>(TOKEN_PREFIX + t);
      if (s) {
        const age = Date.now() - s.value.createdAt;
        if (age < SESSION_TTL_MS) live.push(t);
      }
    }
    return live;
  }

  async revokeSession(token: SessionToken): Promise<void> {
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
  }

  /** Auto-join "users" group on registration (Linux-style). */
  async #joinDefaultGroup(userId: UserId): Promise<void> {
    try {
      const ugEntry = await this.atomic.get<string[]>('usergroup:ids');
      if (!ugEntry) return;
      for (const id of ugEntry.value) {
        const g = await this.atomic.get<any>('usergroup:' + id);
        if (g?.value?.name === 'users') {
          if (!g.value.memberIds.includes(userId)) {
            g.value.memberIds.push(userId);
            g.value.updatedAt = Date.now();
            await this.atomic.set('usergroup:' + id, g.value, g.version);
          }
          return;
        }
      }
    } catch {
      // Silently ignore — default group is best-effort
    }
  }

  /**
   * Append `id` to its shard (deterministic, OCC-guarded).
   * Contention is bounded by concurrent writes to the same shard, not
   * the total user count — with 16 shards, 160k concurrent signups have
   * the same collision rate as 10k on a single key.
   */
  async #addToIndex(id: UserId): Promise<void> {
    const shardKey = USER_IDS_SHARD_PREFIX + shardIndex(id);
    const entry = await this.atomic.get<string[]>(shardKey);
    const ids = entry?.value ?? [];
    ids.push(id);
    const version = await this.atomic.set(shardKey, ids, entry?.version ?? null);
    if (!version) throw new AppError(500, 'INDEX_FAILED', 'Failed to update user index');
  }

  async #removeFromIndex(id: UserId): Promise<void> {
    const shardKey = USER_IDS_SHARD_PREFIX + shardIndex(id);
    const entry = await this.atomic.get<string[]>(shardKey);
    if (!entry) return;
    const ids = entry.value.filter(i => i !== id);
    await this.atomic.set(shardKey, ids, entry.version);
  }
}
