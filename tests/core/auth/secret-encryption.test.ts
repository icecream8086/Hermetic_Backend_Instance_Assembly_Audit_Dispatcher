import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SecretEncryption } from '../../../src/core/auth/secret-encryption.ts';

// Generate a valid 32-byte key in base64: openssl rand -base64 32
const VALID_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='; // 32 bytes of 0x00

describe('SecretEncryption (white-box)', () => {
  describe('fromEnv', () => {
    afterEach(() => { delete process.env['SECRET_MASTER_KEY']; });

    it('returns undefined when SECRET_MASTER_KEY is not set', () => {
      expect(SecretEncryption.fromEnv()).toBeUndefined();
    });

    it('returns SecretEncryption instance when key is set', () => {
      process.env['SECRET_MASTER_KEY'] = VALID_KEY;
      const enc = SecretEncryption.fromEnv();
      expect(enc).toBeInstanceOf(SecretEncryption);
    });
  });

  describe('constructor', () => {
    it('accepts a valid 32-byte base64 key', () => {
      expect(() => new SecretEncryption(VALID_KEY)).not.toThrow();
    });

    it('throws for wrong-length key', () => {
      expect(() => new SecretEncryption('dG9vc2hvcnQ=')).toThrow('32 bytes');
    });
  });

  describe('encrypt → decrypt roundtrip', () => {
    const enc = new SecretEncryption(VALID_KEY);

    it('encrypts and decrypts plaintext correctly', async () => {
      const cipher = await enc.encrypt('my-secret-password');
      expect(cipher).toMatch(/^\$AES\$/);
      const plain = await enc.decrypt(cipher);
      expect(plain).toBe('my-secret-password');
    });

    it('produces different ciphertext for same plaintext (random IV)', async () => {
      const c1 = await enc.encrypt('same');
      const c2 = await enc.encrypt('same');
      expect(c1).not.toBe(c2);
    });

    it('handles empty string', async () => {
      const cipher = await enc.encrypt('');
      expect(cipher).toMatch(/^\$AES\$/);
      expect(await enc.decrypt(cipher)).toBe('');
    });

    it('handles unicode text', async () => {
      const cipher = await enc.encrypt('密码 🔐');
      expect(await enc.decrypt(cipher)).toBe('密码 🔐');
    });

    it('handles long values (4KB)', async () => {
      const long = 'x'.repeat(4096);
      const cipher = await enc.encrypt(long);
      expect(await enc.decrypt(cipher)).toBe(long);
    });
  });

  describe('decrypt', () => {
    const enc = new SecretEncryption(VALID_KEY);

    it('passes through plaintext without $AES$ prefix (backward compat)', async () => {
      expect(await enc.decrypt('plaintext-secret')).toBe('plaintext-secret');
    });

    it('throws on truncated ciphertext', async () => {
      await expect(enc.decrypt('$AES$YQ==')).rejects.toThrow('too short');
    });

    it('throws on corrupted ciphertext', async () => {
      const prefix = SecretEncryption.ENC_PREFIX;
      const bad = prefix + 'A'.repeat(20);
      await expect(enc.decrypt(bad)).rejects.toThrow();
    });
  });
});
