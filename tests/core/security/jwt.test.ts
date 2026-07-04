import { describe, it, expect } from 'vitest';
import { signToken, verifyToken, base64url, base64urlDecode } from '../../../src/core/security/jwt.ts';
import type { S3AccessTokenClaims } from '../../../src/core/security/types.ts';

const SECRET = crypto.getRandomValues(new Uint8Array(32));

function makeClaims(overrides?: Partial<S3AccessTokenClaims>): S3AccessTokenClaims {
  return {
    jti: crypto.randomUUID(),
    iss: 'hbi-aad',
    sub: 'sandbox-123',
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,
    grants: [{ bucket: 'my-bucket', prefix: 'data/', permissions: ['read', 'write'] }],
    ...overrides,
  };
}

describe('base64url', () => {
  it('encodes and decodes round-trip', () => {
    const original = new Uint8Array([0, 1, 2, 3, 255, 254, 253]);
    const encoded = base64url(original.buffer);
    const decoded = base64urlDecode(encoded);
    expect(new Uint8Array(decoded)).toEqual(original);
  });

  it('produces URL-safe output (no + / or padding)', () => {
    const raw = new Uint8Array([0xfb, 0xff, 0xff]); // would have +// in base64
    const encoded = base64url(raw.buffer);
    expect(encoded).not.toContain('+');
    expect(encoded).not.toContain('/');
    expect(encoded).not.toContain('=');
  });
});

describe('signToken / verifyToken', () => {
  it('signs and verifies a valid token', async () => {
    const claims = makeClaims();
    const token = await signToken(claims, SECRET);
    expect(token).toBeTruthy();
    expect(token.split('.')).toHaveLength(3);

    const result = await verifyToken(token, SECRET);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.claims.jti).toBe(claims.jti);
      expect(result.claims.sub).toBe('sandbox-123');
      expect(result.claims.grants).toHaveLength(1);
      expect(result.claims.grants[0]!.bucket).toBe('my-bucket');
    }
  });

  it('rejects an expired token', async () => {
    const claims = makeClaims({ exp: Math.floor(Date.now() / 1000) - 10 }); // 10s ago
    const token = await signToken(claims, SECRET);
    const result = await verifyToken(token, SECRET);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toMatch(/expired/i);
  });

  it('rejects a tampered token', async () => {
    const claims = makeClaims();
    const token = await signToken(claims, SECRET);
    const parts = token.split('.');
    // Tamper with the payload
    const tamperedPayload = base64url(new TextEncoder().encode(JSON.stringify({ ...claims, sub: 'hacker' })).buffer);
    const tamperedToken = [parts[0], tamperedPayload, parts[2]].join('.');
    const result = await verifyToken(tamperedToken, SECRET);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toMatch(/signature/i);
  });

  it('rejects a malformed token', async () => {
    const result = await verifyToken('not-a-jwt', SECRET);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toMatch(/malformed/i);
  });

  it('rejects token signed with a different secret', async () => {
    const claims = makeClaims();
    const otherSecret = crypto.getRandomValues(new Uint8Array(32));
    const token = await signToken(claims, otherSecret);
    const result = await verifyToken(token, SECRET);
    expect(result.valid).toBe(false);
  });
});
