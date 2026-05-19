import type { IAtomicStore } from '../../core/store/interfaces.ts';
import type { ILogWriter } from '../../core/logger/interfaces.ts';
import { createFacility } from '../../core/brand.ts';
import { LogLevel, AppError } from '../../core/types.ts';
import type { User, UserId, Session, SessionToken, RegisterInput, LoginInput, UpdateUserInput } from './types.ts';
import { generateUserId, generateSessionToken, createUserId } from './types.ts';

const FACILITY = createFacility('user-service');
const USER_PREFIX = 'user:';
const EMAIL_INDEX_PREFIX = 'user:email:';
const TOKEN_PREFIX = 'session:';

// ─── Password hashing (PBKDF2 via Web Crypto) ───

const PBKDF2_ITERATIONS = 100_000;
const SALT_LENGTH = 16;
const HASH_LENGTH = 256; // bits

function bufferToBase64(buf: Uint8Array): string {
  return btoa(String.fromCharCode(...buf));
}

function base64ToBuffer(b64: string): Uint8Array<ArrayBuffer> {
  const raw = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  const copy = new Uint8Array<ArrayBuffer>(new ArrayBuffer(raw.length));
  copy.set(raw);
  return copy;
}

/** Encode a string into a fresh ArrayBuffer for Web Crypto API consumption. */
function encodeToBuffer(input: string): ArrayBuffer {
  const encoded = new TextEncoder().encode(input);
  const buffer = new ArrayBuffer(encoded.length);
  new Uint8Array(buffer).set(encoded);
  return buffer;
}

async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_LENGTH));
  const key = await crypto.subtle.importKey('raw', encodeToBuffer(password), 'PBKDF2', false, ['deriveBits']);
  const hash = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    key, HASH_LENGTH,
  );
  return `${bufferToBase64(salt)}:${bufferToBase64(new Uint8Array(hash))}`;
}

async function verifyPassword(password: string, stored: string): Promise<boolean> {
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
}

// ─── Service ───

export interface IUserService {
  register(input: RegisterInput): Promise<{ user: User; token: SessionToken }>;
  login(input: LoginInput): Promise<{ user: User; token: SessionToken }>;
  getById(id: UserId): Promise<User | null>;
  update(id: UserId, input: UpdateUserInput): Promise<User>;
  delete(id: UserId): Promise<void>;
  list(): Promise<User[]>;
  validateToken(token: SessionToken): Promise<User | null>;
}

export class UserService implements IUserService {
  constructor(
    private readonly atomic: IAtomicStore,
    private readonly logger: ILogWriter,
  ) {}

  async register(input: RegisterInput): Promise<{ user: User; token: SessionToken }> {
    const id = generateUserId();
    const passwordHash = await hashPassword(input.password);
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

    await this.logger.logAsync({
      facility: FACILITY,
      level: LogLevel.INFO,
      message: 'User registered',
      metadata: { userId: id as string, email: input.email, role: input.role },
    });

    return { user, token };
  }

  async login(input: LoginInput): Promise<{ user: User; token: SessionToken }> {
    const entry = await this.atomic.get<User>(EMAIL_INDEX_PREFIX + input.email);
    if (!entry) throw new AppError(401, 'INVALID_CREDENTIALS', 'Invalid email or password');

    const user = entry.value;
    const valid = await verifyPassword(input.password, user.passwordHash);
    if (!valid) throw new AppError(401, 'INVALID_CREDENTIALS', 'Invalid email or password');

    const token = await this.createSession(user.id);

    await this.logger.logAsync({
      facility: FACILITY,
      level: LogLevel.INFO,
      message: 'User logged in',
      metadata: { userId: user.id as string, email: user.email },
    });

    return { user, token };
  }

  async getById(id: UserId): Promise<User | null> {
    const entry = await this.atomic.get<User>(USER_PREFIX + id);
    return entry?.value ?? null;
  }

  async update(id: UserId, input: UpdateUserInput): Promise<User> {
    const entry = await this.atomic.get<User>(USER_PREFIX + id);
    if (!entry) throw new AppError(404, 'USER_NOT_FOUND', 'User not found');

    const updated: User = {
      ...entry.value,
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.role !== undefined ? { role: input.role } : {}),
      ...(input.password !== undefined ? { passwordHash: await hashPassword(input.password) } : {}),
      updatedAt: Date.now(),
    };

    const newVersion = await this.atomic.set(USER_PREFIX + id, updated, entry.version);
    if (!newVersion) throw new AppError(409, 'CONFLICT', 'Concurrent modification detected');

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

    await this.logger.logAsync({
      facility: FACILITY,
      level: LogLevel.INFO,
      message: 'User deleted',
      metadata: { userId: id as string, email },
    });
  }

  async list(): Promise<User[]> {
    // Note: full scan is not practical with KV/DO.
    // In production this would use IQueryStore with D1.
    // For now return empty — callers must use getById.
    return [];
  }

  async validateToken(token: SessionToken): Promise<User | null> {
    const entry = await this.atomic.get<{ userId: string }>(TOKEN_PREFIX + token);
    if (!entry) return null;
    const userId = createUserId(entry.value.userId);
    return this.getById(userId);
  }

  private async createSession(userId: UserId): Promise<SessionToken> {
    const token = generateSessionToken();
    const session: Session = {
      token,
      userId,
      createdAt: Date.now(),
    };
    await this.atomic.set(TOKEN_PREFIX + token, session, null);
    return token;
  }
}
