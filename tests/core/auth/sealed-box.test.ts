import { describe, it, expect } from 'vitest';
import { SealedBox } from '../../../src/core/auth/sealed-box.ts';

describe('SealedBox (NaCl model)', () => {
  it('generates a keypair', async () => {
    const kp = await SealedBox.generateKeyPair();
    expect(kp.publicKey).toBeTruthy();
    expect(kp.privateKey).toBeTruthy();
    expect(kp.publicKey).not.toBe(kp.privateKey);
  });

  it('seals and opens round-trip', async () => {
    const kp = await SealedBox.generateKeyPair();
    const plaintext = 'hello secret world';
    const sealed = await SealedBox.seal(kp.publicKey, plaintext);
    expect(sealed).toBeTruthy();
    expect(sealed).not.toBe(plaintext);

    const opened = await SealedBox.open(kp.privateKey, sealed);
    expect(opened).toBe(plaintext);
  });

  it('cannot open with wrong private key', async () => {
    const alice = await SealedBox.generateKeyPair();
    const bob = await SealedBox.generateKeyPair();
    const sealed = await SealedBox.seal(alice.publicKey, 'secret');

    await expect(SealedBox.open(bob.privateKey, sealed)).rejects.toThrow();
  });

  it('different plaintexts produce different ciphertexts', async () => {
    const kp = await SealedBox.generateKeyPair();
    const s1 = await SealedBox.seal(kp.publicKey, 'msg1');
    const s2 = await SealedBox.seal(kp.publicKey, 'msg2');
    expect(s1).not.toBe(s2);
  });

  it('same plaintext produces different ciphertexts (ephemeral key)', async () => {
    const kp = await SealedBox.generateKeyPair();
    const s1 = await SealedBox.seal(kp.publicKey, 'same');
    const s2 = await SealedBox.seal(kp.publicKey, 'same');
    expect(s1).not.toBe(s2); // different ephemeral keys
  });

  it('rejects short ciphertext', async () => {
    const kp = await SealedBox.generateKeyPair();
    await expect(SealedBox.open(kp.privateKey, btoa('short'))).rejects.toThrow('too short');
  });

  it('handles Unicode plaintext', async () => {
    const kp = await SealedBox.generateKeyPair();
    const plaintext = '你好世界 🌍🔐';
    const sealed = await SealedBox.seal(kp.publicKey, plaintext);
    const opened = await SealedBox.open(kp.privateKey, sealed);
    expect(opened).toBe(plaintext);
  });

  it('handles empty plaintext', async () => {
    const kp = await SealedBox.generateKeyPair();
    const sealed = await SealedBox.seal(kp.publicKey, '');
    const opened = await SealedBox.open(kp.privateKey, sealed);
    expect(opened).toBe('');
  });
});
