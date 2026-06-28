import { AppError } from '../types.ts';

const ALGO = 'AES-GCM';
const IV_LENGTH = 12;

/**
 * AES-256-GCM envelope encryption for credential secrets at rest.
 *
 * Usage: `SecretEncryption.fromEnv()` at composition root, pass to
 * `CredentialService` constructor.  When no master key is configured
 * (dev / local-only setups), `fromEnv()` returns null and the service
 * stores secrets in plaintext — functionally identical to today.
 */
export class SecretEncryption {
  static readonly ENV_KEY = 'SECRET_MASTER_KEY';
  static readonly ENC_PREFIX = '$AES$';

  static fromEnv(): SecretEncryption | undefined {
    const key = process.env[SecretEncryption.ENV_KEY];
    if (!key) return undefined;
    return new SecretEncryption(key);
  }

  readonly #keyPromise: Promise<CryptoKey>;

  public constructor(masterKeyBase64: string) {
    const raw = Uint8Array.from(atob(masterKeyBase64), c => c.charCodeAt(0));
    if (raw.byteLength !== 32) {
      throw new AppError(500, 'INVALID_MASTER_KEY', 'SECRET_MASTER_KEY must be 32 bytes encoded as base64');
    }
    this.#keyPromise = crypto.subtle.importKey('raw', raw, { name: ALGO }, false, ['encrypt', 'decrypt']);
  }

  public async encrypt(plaintext: string): Promise<string> {
    const key = await this.#keyPromise;
    const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
    const encoded = new TextEncoder().encode(plaintext);
    const ciphertext = await crypto.subtle.encrypt({ name: ALGO, iv }, key, encoded);
    const combined = new Uint8Array(IV_LENGTH + ciphertext.byteLength);
    combined.set(iv, 0);
    combined.set(new Uint8Array(ciphertext), IV_LENGTH);
    return SecretEncryption.ENC_PREFIX + btoa(String.fromCharCode(...combined));
  }

  public async decrypt(encrypted: string): Promise<string> {
    if (!encrypted.startsWith(SecretEncryption.ENC_PREFIX)) {
      return encrypted; // not encrypted — backward compat with stored plaintext
    }
    const key = await this.#keyPromise;
    const combined = Uint8Array.from(atob(encrypted.slice(SecretEncryption.ENC_PREFIX.length)), c => c.charCodeAt(0));
    if (combined.byteLength < IV_LENGTH + 1) {
      throw new AppError(500, 'INVALID_CIPHERTEXT', 'Encrypted blob too short');
    }
    const iv = combined.slice(0, IV_LENGTH);
    const ciphertext = combined.slice(IV_LENGTH);
    const decrypted = await crypto.subtle.decrypt({ name: ALGO, iv }, key, ciphertext);
    return new TextDecoder().decode(decrypted);
  }
}
