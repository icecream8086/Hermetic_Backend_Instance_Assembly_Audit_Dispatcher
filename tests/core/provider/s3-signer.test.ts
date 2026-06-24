import { describe, it, expect } from 'vitest';
import { signSigV4, signPresignedUrl, emptyPayloadHash, payloadHash } from '../../../src/core/provider/s3-signer.ts';
import type { SigV4Credentials } from '../../../src/core/provider/s3-signer.ts';

const creds: SigV4Credentials = { accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'secret' };
const now = new Date('2025-01-15T00:00:00Z');

describe('signSigV4 (low-level)', () => {
  it('returns signed headers with x-amz-date and Authorization', async () => {
    const headers = await signSigV4(
      'PUT', '/test.txt', '', { 'content-type': 'text/plain' },
      emptyPayloadHash(), creds, 'us-east-1', 's3', now,
    );
    expect(headers['x-amz-date']).toBe('20250115T000000Z');
    expect(headers['Authorization']).toMatch(/^AWS4-HMAC-SHA256 /);
  });

  it('includes x-amz-security-token when session token present', async () => {
    const headers = await signSigV4(
      'GET', '/key', '', {}, emptyPayloadHash(),
      { ...creds, sessionToken: 'sess-tok' }, 'us-east-1', 's3', now,
    );
    expect(headers['x-amz-security-token']).toBe('sess-tok');
  });

  it('produces deterministic signature for known inputs', async () => {
    // Same inputs twice → same Authorization header
    const args = ['GET', '/key', '', {}, emptyPayloadHash(), creds, 'us-east-1', 's3', now] as const;
    const h1 = await signSigV4(...args);
    const h2 = await signSigV4(...args);
    expect(h1['Authorization']).toBe(h2['Authorization']);
  });
});

describe('emptyPayloadHash', () => {
  it('returns SHA-256 of empty string', () => {
    expect(emptyPayloadHash()).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });
});

describe('payloadHash', () => {
  it('returns SHA-256 of string', async () => {
    expect(await payloadHash('hello')).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
  });
});

describe('signPresignedUrl', () => {
  it('generates presigned URL with required SigV4 query params', async () => {
    const urlObj = await signPresignedUrl(
      'GET', '/bucket/key.txt', creds, 'us-east-1', 's3', 3600, now,
      'bucket.s3.us-east-1.amazonaws.com',
    );
    const url = urlObj.href;
    expect(url).toContain('X-Amz-Algorithm=AWS4-HMAC-SHA256');
    expect(url).toContain('X-Amz-Credential=');
    expect(url).toContain('X-Amz-Expires=3600');
    expect(url).toContain('X-Amz-Signature=');
  });
});
