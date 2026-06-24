/**
 * NaCl SealedBox — public-key sealed encryption (GitHub Secret model).
 *
 * Implements the same pattern as libsodium crypto_box_seal:
 *   1. Generate ephemeral ECDH keypair
 *   2. Derive shared secret from ephemeral private key + recipient public key
 *   3. Encrypt plaintext with AES-256-GCM using the shared secret
 *   4. Prepend ephemeral public key to ciphertext
 *
 * Web Crypto compatible — no external dependencies.
 */

const KEY_ALGO = { name: 'ECDH', namedCurve: 'P-256' } as const;
const ENC_ALGO = 'AES-GCM';
const IV_LENGTH = 12;
const TAG_LENGTH = 16; // AES-GCM auth tag

function bufToB64(buf: Uint8Array): string {
  return btoa(String.fromCharCode(...buf));
}

function b64ToBuf(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf;
}

function concat(...arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((s, a) => s + a.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) { out.set(a, offset); offset += a.byteLength; }
  return out;
}

export interface KeyPair {
  publicKey: string;   // base64 raw public key
  privateKey: string;  // base64 raw private key
}

export class SealedBox {
  /** Generate a new ECDH P-256 keypair. */
  static async generateKeyPair(): Promise<KeyPair> {
    const kp = await crypto.subtle.generateKey(KEY_ALGO, true, ['deriveBits']);
    const pubRaw = await crypto.subtle.exportKey('raw', kp.publicKey);
    const privRaw = await crypto.subtle.exportKey('pkcs8', kp.privateKey);
    return {
      publicKey: bufToB64(new Uint8Array(pubRaw)),
      privateKey: bufToB64(new Uint8Array(privRaw)),
    };
  }

  /** Export public key from raw base64. */
  static async importPublicKey(rawB64: string): Promise<CryptoKey> {
    return crypto.subtle.importKey('raw', b64ToBuf(rawB64), KEY_ALGO, false, []);
  }

  /** Import private key from PKCS8 base64. */
  static async importPrivateKey(rawB64: string): Promise<CryptoKey> {
    return crypto.subtle.importKey('pkcs8', b64ToBuf(rawB64), KEY_ALGO, false, ['deriveBits']);
  }

  /**
   * Seal plaintext to a recipient's public key.
   * Returns base64(ephemeralPublicKey || IV || ciphertext).
   */
  static async seal(recipientPubKeyB64: string, plaintext: string): Promise<string> {
    const recipientKey = await SealedBox.importPublicKey(recipientPubKeyB64);

    // Generate ephemeral keypair
    const ephemeral = await crypto.subtle.generateKey(KEY_ALGO, true, ['deriveBits']);

    // Derive shared secret
    const sharedBits = await crypto.subtle.deriveBits(
      { name: 'ECDH', public: recipientKey },
      ephemeral.privateKey,
      256,
    );

    // Encrypt with AES-GCM
    const sharedKey = await crypto.subtle.importKey('raw', sharedBits, { name: ENC_ALGO }, false, ['encrypt']);
    const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
    const encoded = new TextEncoder().encode(plaintext);
    const ciphertext = await crypto.subtle.encrypt({ name: ENC_ALGO, iv }, sharedKey, encoded);

    // Export ephemeral public key
    const ephemPubRaw = await crypto.subtle.exportKey('raw', ephemeral.publicKey);

    // Format: ephemeral_pub || iv || ciphertext
    const sealed = concat(new Uint8Array(ephemPubRaw), iv, new Uint8Array(ciphertext));
    return bufToB64(sealed);
  }

  /**
   * Open a sealed message using the recipient's private key.
   * Expects input as base64(ephemeralPublicKey || IV || ciphertext).
   */
  static async open(recipientPrivKeyB64: string, sealedB64: string): Promise<string> {
    const privKey = await SealedBox.importPrivateKey(recipientPrivKeyB64);
    const sealed = b64ToBuf(sealedB64);

    // Parse: ephemeral_pub (65 bytes for P-256 uncompressed) || IV (12) || ciphertext
    const PUB_KEY_LEN = 65;
    if (sealed.byteLength < PUB_KEY_LEN + IV_LENGTH + TAG_LENGTH) {
      throw new Error('SealedBox: ciphertext too short');
    }

    const ephemPub = sealed.slice(0, PUB_KEY_LEN);
    const iv = sealed.slice(PUB_KEY_LEN, PUB_KEY_LEN + IV_LENGTH);
    const ciphertext = sealed.slice(PUB_KEY_LEN + IV_LENGTH);

    // Import ephemeral public key
    const ephemKey = await crypto.subtle.importKey('raw', ephemPub, KEY_ALGO, false, []);

    // Derive shared secret
    const sharedBits = await crypto.subtle.deriveBits(
      { name: 'ECDH', public: ephemKey },
      privKey,
      256,
    );

    // Decrypt
    const sharedKey = await crypto.subtle.importKey('raw', sharedBits, { name: ENC_ALGO }, false, ['decrypt']);
    const decrypted = await crypto.subtle.decrypt({ name: ENC_ALGO, iv }, sharedKey, ciphertext);
    return new TextDecoder().decode(decrypted);
  }
}
