import type { S3AccessTokenClaims } from './types.ts';

const ENCODER = new TextEncoder();
const DECODER = new TextDecoder();

// ─── Base64url（导出，供 service.ts 编解码 JWT secret） ───

export function base64url(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let str = '';
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64urlDecode(str: string): Uint8Array {
  const base64 = str.replace(/-/g, '+').replace(/_/g, '/').padEnd(
    str.length + ((4 - (str.length % 4)) % 4), '=',
  );
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// ─── Crypto key ───

async function importKey(secret: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw', secret.buffer as ArrayBuffer,
    { name: 'HMAC', hash: 'SHA-256' },
    false, ['sign', 'verify'],
  );
}

// ─── Sign ───

export async function signToken(
  claims: S3AccessTokenClaims,
  secret: Uint8Array,
): Promise<string> {
  const header = base64url(ENCODER.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).buffer);
  const payload = base64url(ENCODER.encode(JSON.stringify(claims)).buffer);
  const key = await importKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, ENCODER.encode(`${header}.${payload}`).buffer as ArrayBuffer);
  return `${header}.${payload}.${base64url(sig)}`;
}

// ─── Verify ───

export interface JwtVerifyResult {
  valid: true;
  claims: S3AccessTokenClaims;
}

export interface JwtVerifyError {
  valid: false;
  reason: string;
}

export async function verifyToken(
  token: string,
  secret: Uint8Array,
): Promise<JwtVerifyResult | JwtVerifyError> {
  const parts = token.split('.');
  if (parts.length !== 3) return { valid: false, reason: 'Malformed token' };

  const [headerB64, payloadB64, sigB64] = parts;
  const key = await importKey(secret);
  const sigBytes = base64urlDecode(sigB64!);

  const valid = await crypto.subtle.verify(
    'HMAC', key, sigBytes.buffer as ArrayBuffer,
    ENCODER.encode(`${headerB64}.${payloadB64}`).buffer as ArrayBuffer,
  );
  if (!valid) return { valid: false, reason: 'Invalid signature' };

  const payloadJson = DECODER.decode(base64urlDecode(payloadB64!));
  const claims = JSON.parse(payloadJson) as S3AccessTokenClaims;

  const now = Math.floor(Date.now() / 1000);
  if (claims.exp <= now) return { valid: false, reason: 'Token expired' };

  return { valid: true, claims };
}
