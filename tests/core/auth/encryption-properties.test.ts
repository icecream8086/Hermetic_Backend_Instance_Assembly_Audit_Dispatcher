import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { SecretEncryption } from '../../../src/core/auth/secret-encryption.ts';

// Generate a valid 32-byte base64 key for testing
function generateTestKey(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes));
}

describe('SecretEncryption (property-based)', () => {
  describe('roundtrip: decrypt(encrypt(plaintext)) === plaintext', () => {
    it('correctly roundtrips any plaintext string', async () => {
      const key = generateTestKey();
      const enc = new SecretEncryption(key);

      await fc.assert(
        fc.asyncProperty(
          fc.string(),
          async (plaintext) => {
            const encrypted = await enc.encrypt(plaintext);
            const decrypted = await enc.decrypt(encrypted);
            expect(decrypted).toBe(plaintext);
          },
        ),
        { numRuns: 200 },
      );
    });

    it('encrypted output uses AES prefix', async () => {
      const key = generateTestKey();
      const enc = new SecretEncryption(key);

      await fc.assert(
        fc.asyncProperty(
          fc.string({ minLength: 1 }),
          async (plaintext) => {
            const encrypted = await enc.encrypt(plaintext);
            expect(encrypted.startsWith(SecretEncryption.ENC_PREFIX)).toBe(true);
          },
        ),
        { numRuns: 100 },
      );
    });

    it('encrypted output is different from plaintext', async () => {
      const key = generateTestKey();
      const enc = new SecretEncryption(key);

      await fc.assert(
        fc.asyncProperty(
          fc.string({ minLength: 10 }), // avoid collisions on tiny strings
          async (plaintext) => {
            const encrypted = await enc.encrypt(plaintext);
            expect(encrypted).not.toBe(plaintext);
            // The encrypted form should be longer (IV + ciphertext + prefix)
            expect(encrypted.length).toBeGreaterThan(plaintext.length);
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  describe('backward compatibility', () => {
    it('decrypt returns plaintext as-is when not prefixed with $AES$', async () => {
      const key = generateTestKey();
      const enc = new SecretEncryption(key);

      await fc.assert(
        fc.asyncProperty(
          fc.string(),
          async (plaintext) => {
            const result = await enc.decrypt(plaintext);
            expect(result).toBe(plaintext);
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  describe('encryption uniqueness', () => {
    it('encrypting the same plaintext twice produces different ciphertexts (random IV)', async () => {
      const key = generateTestKey();
      const enc = new SecretEncryption(key);
      const plaintext = 'hello world';

      const e1 = await enc.encrypt(plaintext);
      const e2 = await enc.encrypt(plaintext);
      // Different IVs produce different ciphertexts
      expect(e1).not.toBe(e2);

      // Both should decrypt to the original
      expect(await enc.decrypt(e1)).toBe(plaintext);
      expect(await enc.decrypt(e2)).toBe(plaintext);
    });
  });

  describe('empty string handling', () => {
    it('correctly roundtrips an empty string', async () => {
      const key = generateTestKey();
      const enc = new SecretEncryption(key);
      const encrypted = await enc.encrypt('');
      const decrypted = await enc.decrypt(encrypted);
      expect(decrypted).toBe('');
    });
  });

  describe('unicode handling', () => {
    it('correctly roundtrips unicode strings', async () => {
      const key = generateTestKey();
      const enc = new SecretEncryption(key);

      await fc.assert(
        fc.asyncProperty(
          fc.string(),
          async (plaintext) => {
            const encrypted = await enc.encrypt(plaintext);
            const decrypted = await enc.decrypt(encrypted);
            expect(decrypted).toBe(plaintext);
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  describe('key validation', () => {
    it('rejects a key that is not 32 bytes', () => {
      // 'dG9vLXNob3J0' decodes to 9 bytes — should throw
      expect(() => new SecretEncryption('dG9vLXNob3J0')).toThrow('SECRET_MASTER_KEY must be 32 bytes');
    });

    it('accepts a valid 32-byte base64 key', () => {
      const key = generateTestKey();
      expect(() => new SecretEncryption(key)).not.toThrow();
    });
  });
});
