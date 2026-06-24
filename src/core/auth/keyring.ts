/**
 * Keyring hierarchy — RHEL keyring model.
 *
 * RHEL Linux keyrings:
 *   session keyring — per-login-session, cleared on logout
 *   user keyring    — per-UID, persists across sessions
 *
 * For this project:
 *   SessionKeyring — ephemeral keys tied to a request/session lifecycle
 *   UserKeyring    — per-user keypair stored in atomic store (persistent)
 *
 * Key types:
 *   sealed-box — ECDH P-256 keypair for NaCl SealedBox encryption
 *   signing    — Ed25519 keypair for request signing (extends publicKeyEd25519)
 */

import type { IAtomicStore } from '../store/interfaces.ts';
import { SealedBox, type KeyPair } from './sealed-box.ts';

// ─── Storage keys ───

const USER_KEYRING_PREFIX = 'user:keyring:';

// ─── User keyring ───

export interface UserKeyringEntry {
  /** SealedBox ECDH keypair for secret encryption. */
  sealedBox?: { publicKey: string; privateKey: string };
  /** Ed25519 keypair for request signing. */
  signing?: { publicKey: string; privateKey: string };
  createdAt: number;
  updatedAt: number;
}

export class UserKeyring {
  constructor(private readonly atomic: IAtomicStore) {}

  #key(userId: string): string { return USER_KEYRING_PREFIX + userId; }

  async get(userId: string): Promise<UserKeyringEntry | null> {
    const entry = await this.atomic.get<UserKeyringEntry>(this.#key(userId));
    return entry?.value ?? null;
  }

  /** Ensure a SealedBox keypair exists for this user. Creates one if missing. */
  async ensureSealedBox(userId: string): Promise<KeyPair> {
    const entry = await this.get(userId);
    if (entry?.sealedBox?.publicKey) {
      return { publicKey: entry.sealedBox.publicKey, privateKey: entry.sealedBox.privateKey };
    }
    const kp = await SealedBox.generateKeyPair();
    const now = Date.now();
    const updated: UserKeyringEntry = {
      ...(entry ?? { createdAt: now, updatedAt: now }),
      sealedBox: { publicKey: kp.publicKey, privateKey: kp.privateKey },
      updatedAt: now,
    };
    await this.atomic.set(this.#key(userId), updated, null);
    return kp;
  }

  /** Get public key for a user (returns null if not yet created). */
  async getPublicKey(userId: string): Promise<string | null> {
    const entry = await this.get(userId);
    return entry?.sealedBox?.publicKey ?? null;
  }

  /** Rotate the SealedBox keypair. Returns new keypair. Old secrets must be re-encrypted. */
  async rotateSealedBox(userId: string): Promise<KeyPair> {
    const kp = await SealedBox.generateKeyPair();
    const entry = await this.get(userId);
    const now = Date.now();
    const updated: UserKeyringEntry = {
      ...(entry ?? { createdAt: now, updatedAt: now }),
      sealedBox: { publicKey: kp.publicKey, privateKey: kp.privateKey },
      updatedAt: now,
    };
    await this.atomic.set(this.#key(userId), updated, entry ? null : null);
    return kp;
  }
}

// ─── Session keyring (in-memory, ephemeral) ───

export interface SessionKeyringEntry {
  keypair: KeyPair;
  expiresAt: number;
}

export class SessionKeyring {
  readonly #keys = new Map<string, SessionKeyringEntry>();

  /** Create a session-scoped keypair with TTL. */
  async create(sessionId: string, ttlMs = 3_600_000): Promise<KeyPair> {
    const existing = this.#keys.get(sessionId);
    if (existing && Date.now() < existing.expiresAt) return existing.keypair;

    const kp = await SealedBox.generateKeyPair();
    this.#keys.set(sessionId, { keypair: kp, expiresAt: Date.now() + ttlMs });
    return kp;
  }

  get(sessionId: string): KeyPair | null {
    const entry = this.#keys.get(sessionId);
    if (!entry || Date.now() >= entry.expiresAt) {
      this.#keys.delete(sessionId);
      return null;
    }
    return entry.keypair;
  }

  clear(sessionId: string): void { this.#keys.delete(sessionId); }
  clearAll(): void { this.#keys.clear(); }
}
