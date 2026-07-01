import { z } from 'zod';

// ─── AWS SigV4 signing for S3-compatible APIs ───
// Uses Web Crypto API — works in Cloudflare Workers, Node 18+, Deno, Bun.
// Used by both AWS S3 and Cloudflare R2 providers.
//
// Reference: https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html

export interface SigV4Credentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken?: string;
}

/** Hex-encoded SHA-256 digest. */
async function sha256Hex(data: string): Promise<string> {
  const enc = new TextEncoder();
  const hash = await crypto.subtle.digest('SHA-256', enc.encode(data));
  return bytesToHex(new Uint8Array(hash));
}

/** HMAC-SHA256 keyed hash, returns raw bytes. */
async function hmacRaw(key: BufferSource, data: string): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw', key, { name: 'HMAC', hash: 'SHA-256' },
    false, ['sign'],
  );
  return crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(data));
}

/** HMAC-SHA256 → hex string. */
async function hmacHex(key: ArrayBuffer, data: string): Promise<string> {
  return bytesToHex(new Uint8Array(await hmacRaw(key, data)));
}

/** Derive the SigV4 signing key chain. */
async function deriveKey(
  secret: string, dateStamp: string, region: string, service: string,
): Promise<ArrayBuffer> {
  const enc = new TextEncoder();
  const kDate = await hmacRaw(enc.encode(`AWS4${secret}`), dateStamp);
  const kRegion = await hmacRaw(kDate, region);
  const kService = await hmacRaw(kRegion, service);
  return hmacRaw(kService, 'aws4_request');
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Sign headers for an S3-compatible request using AWS SigV4.
 * Returns the `Authorization` header plus `x-amz-date` and optionally `x-amz-security-token`.
 */
export async function signSigV4(
  method: string,
  canonicalUri: string,
  canonicalQueryString: string,
  headers: Record<string, string>,
  payloadHash: string,
  credentials: SigV4Credentials,
  region: string,
  service: string,
  now: Date,
): Promise<Record<string, string>> {
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);

  const signedHeaders: Record<string, string> = {
    'x-amz-date': amzDate,
    ...headers,
  };
  if (credentials.sessionToken) {
    signedHeaders['x-amz-security-token'] = credentials.sessionToken;
  }

  // Canonical headers: lowercase keys, sorted, trimmed values
  const canonicalHeaders = Object.keys(signedHeaders)
    .sort()
    .map(k => `${k.toLowerCase()}:${signedHeaders[k]!.trim()}\n`)
    .join('');

  const signedHeaderList = Object.keys(signedHeaders)
    .sort()
    .map(k => k.toLowerCase())
    .join(';');

  // Canonical request
  const canonicalRequest = [
    method,
    canonicalUri,
    canonicalQueryString,
    canonicalHeaders,
    signedHeaderList,
    payloadHash,
  ].join('\n');

  // String to sign
  const algorithm = 'AWS4-HMAC-SHA256';
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const canonicalRequestHash = await sha256Hex(canonicalRequest);
  const stringToSign = [algorithm, amzDate, credentialScope, canonicalRequestHash].join('\n');

  // Signing key + signature
  const signingKey = await deriveKey(credentials.secretAccessKey, dateStamp, region, service);
  const signature = await hmacHex(signingKey, stringToSign);

  return {
    Authorization: `${algorithm} Credential=${credentials.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaderList}, Signature=${signature}`,
    'x-amz-date': amzDate,
    ...(credentials.sessionToken ? { 'x-amz-security-token': credentials.sessionToken } : {}),
  };
}

/** Compute the SHA-256 payload hash for an empty body (used for GET, HEAD, DELETE). */
export function emptyPayloadHash(): string {
  return 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
}

/** Compute the SHA-256 payload hash for a body. */
export async function payloadHash(body: BufferSource | string): Promise<string> {
  let enc: BufferSource;
  try { enc = new TextEncoder().encode(z.string().parse(body)); } catch { enc = body; }
  const hash = await crypto.subtle.digest('SHA-256', enc);
  return bytesToHex(new Uint8Array(hash));
}

/**
 * Extract the server timestamp from an AWS S3 XML error response.
 * AWS returns a <ServerTime> element inside the <Error> body for
 * RequestTimeTooSkewed errors. Returns null if no server time is found.
 */
export function extractServerTimeFromError(body: string): Date | null {
  const match = /<ServerTime>(.+?)<\/ServerTime>/.exec(body);
  if (match) {
    const d = new Date(match[1]!);
    if (!isNaN(d.getTime())) return d;
  }
  return null;
}

/**
 * Generate a presigned URL for S3-compatible services using SigV4 query-string auth.
 *
 * The returned URL includes all required `X-Amz-*` query parameters and the
 * final `X-Amz-Signature`. The caller must use the same HTTP method as passed here.
 */
export async function signPresignedUrl(
  method: string,
  canonicalUri: string,
  credentials: SigV4Credentials,
  region: string,
  service: string,
  expiresInSeconds: number,
  now: Date,
  /** The endpoint hostname used for both signing and the final URL.
   *  Must match the actual S3-compatible service endpoint (e.g. "s3.us-east-1.amazonaws.com",
   *  "my-bucket.account.r2.cloudflarestorage.com", "192.168.1.100:9000"). */
  hostname: string,
): Promise<URL> {
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const algorithm = 'AWS4-HMAC-SHA256';
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;

  // Build canonical query params (sorted by key), excluding Signature
  const params = new URLSearchParams();
  params.set('X-Amz-Algorithm', algorithm);
  params.set('X-Amz-Credential', `${credentials.accessKeyId}/${credentialScope}`);
  params.set('X-Amz-Date', amzDate);
  params.set('X-Amz-Expires', String(expiresInSeconds));
  params.set('X-Amz-SignedHeaders', 'host');
  if (credentials.sessionToken) {
    params.set('X-Amz-Security-Token', credentials.sessionToken);
  }

  const canonicalQueryString = params.toString();

  // Canonical request with host-only signed headers — signed host MUST match
  // the actual endpoint the client will connect to, otherwise the service
  // rejects the signature. Caller passes the correct hostname.
  const canonicalRequest = [
    method,
    canonicalUri,
    canonicalQueryString,
    `host:${hostname}\n`,
    'host',
    'UNSIGNED-PAYLOAD',
  ].join('\n');

  // String to sign
  const canonicalRequestHash = await sha256Hex(canonicalRequest);
  const stringToSign = [algorithm, amzDate, credentialScope, canonicalRequestHash].join('\n');

  // Signing key + signature
  const signingKey = await deriveKey(credentials.secretAccessKey, dateStamp, region, service);
  const signature = await hmacHex(signingKey, stringToSign);

  params.set('X-Amz-Signature', signature);

  const url = new URL(`https://${hostname}${canonicalUri}`);
  url.search = params.toString();
  return url;
}
