// AWS S3 provider via SigV4-signed fetch requests.
// No SDK dependency — pure HTTP + SigV4 signing via Web Crypto API.
//
// Clock skew compensation: Workers Date.now() can drift across isolates.
// When AWS returns RequestTimeTooSkewed (403), this provider extracts the
// server time from the error XML, calculates an offset, and retries the
// request with the corrected signing time.

import type {
  IS3Provider,
  S3PutObjectInput,
  S3GetObjectResult,
  S3ObjectInfo,
  S3ListObjectsResult,
} from '../../core/provider/s3.ts';
import type { S3ProviderConfig } from '../../core/provider/s3-types.ts';
import { signSigV4, signPresignedUrl, emptyPayloadHash, payloadHash, extractServerTimeFromError } from '../../core/provider/s3-signer.ts';
import type { SigV4Credentials } from '../../core/provider/s3-signer.ts';

const CLOCK_SKEW_RETRIES = 2;

export class AwsS3Provider implements IS3Provider {
  readonly type = 'aws-s3' as const;
  readonly #region: string;
  readonly #endpoint: string;
  readonly #credentials: SigV4Credentials;
  readonly #config: S3ProviderConfig;
  #clockOffset = 0; // ms to add to Date.now() to compensate for clock skew

  constructor(
    credentials: SigV4Credentials,
    region: string,
    endpoint?: string,
    config?: S3ProviderConfig,
  ) {
    this.#credentials = credentials;
    this.#region = region;
    this.#endpoint = endpoint ?? `https://s3.${region}.amazonaws.com`;
    this.#config = config ?? {};
  }

  #signingTime(): Date {
    return new Date(Date.now() + this.#clockOffset);
  }

  #bucket(bucket: string): string {
    return this.#config.bucketNameMapping?.[bucket] ?? bucket;
  }

  /** Sign, fetch, and retry once on clock skew error. */
  async #signedFetch(url: string, method: string, path: string, queryString: string, amzHeaders: Record<string, string>, bodyHash: string, body?: BodyInit): Promise<Response> {
    for (let attempt = 0; attempt <= CLOCK_SKEW_RETRIES; attempt++) {
      const authHeaders = await signSigV4(method, path, queryString, amzHeaders, bodyHash, this.#credentials, this.#region, 's3', this.#signingTime());
      const res = await fetch(url, { method, headers: { ...amzHeaders, ...authHeaders }, ...(body !== undefined ? { body } : {}) });

      if (res.ok || res.status === 404) return res;

      // Clock skew detection: AWS returns RequestTimeTooSkewed with ServerTime
      if (res.status === 403 && attempt < CLOCK_SKEW_RETRIES) {
        const bodyText = await res.clone().text().catch(() => '');
        const serverTime = extractServerTimeFromError(bodyText);
        if (serverTime) {
          const serverTs = serverTime.getTime();
          if (!isNaN(serverTs)) {
            this.#clockOffset = serverTs - Date.now();
            continue; // retry with adjusted clock
          }
        }
      }

      throw new Error(`S3 ${method} failed: ${res.status} ${await res.text()}`);
    }

    // Shouldn't reach here, but Typescript needs it
    throw new Error(`S3 ${method} failed after ${CLOCK_SKEW_RETRIES} retries`);
  }

  async putObject(input: S3PutObjectInput): Promise<{ etag: string }> {
    const bodyBuf = await toArrayBuffer(input.body);
    const bodyHash = await payloadHash(bodyBuf);

    const bucket = this.#bucket(input.bucket);
    const path = `/${bucket}/${encodeKey(input.key)}`;
    const url = `${this.#endpoint}${path}`;
    const amzHeaders: Record<string, string> = { host: new URL(url).host };
    if (input.contentType) amzHeaders['content-type'] = input.contentType;
    if (input.cacheControl) amzHeaders['cache-control'] = input.cacheControl;

    const res = await this.#signedFetch(url, 'PUT', path, '', amzHeaders, bodyHash, bodyBuf);
    return { etag: (res.headers.get('etag') ?? '').replace(/"/g, '') };
  }

  async getObject(bucket: string, key: string): Promise<S3GetObjectResult | null> {
    return this.#fetchObject('GET', bucket, key);
  }

  async deleteObject(bucket: string, key: string): Promise<void> {
    const path = `/${this.#bucket(bucket)}/${encodeKey(key)}`;
    const url = `${this.#endpoint}${path}`;
    const amzHeaders: Record<string, string> = { host: new URL(url).host };
    const res = await this.#signedFetch(url, 'DELETE', path, '', amzHeaders, emptyPayloadHash());
    if (res.status !== 204 && res.status !== 404) {
      throw new Error(`S3 deleteObject failed: ${res.status} ${await res.text()}`);
    }
  }

  async headObject(bucket: string, key: string): Promise<S3ObjectInfo | null> {
    try {
      const path = `/${this.#bucket(bucket)}/${encodeKey(key)}`;
      const url = `${this.#endpoint}${path}`;
      const amzHeaders: Record<string, string> = { host: new URL(url).host };
      const res = await this.#signedFetch(url, 'HEAD', path, '', amzHeaders, emptyPayloadHash());
      if (res.status === 404) return null;
      return parseObjectInfo(key, res);
    } catch {
      return null;
    }
  }

  async listObjects(
    bucket: string,
    options?: { prefix?: string; delimiter?: string; maxKeys?: number; continuationToken?: string },
  ): Promise<S3ListObjectsResult> {
    const qs = new URLSearchParams({ 'list-type': '2' });
    if (options?.prefix) qs.set('prefix', options.prefix);
    if (options?.delimiter) qs.set('delimiter', options.delimiter);
    if (options?.maxKeys) qs.set('max-keys', String(options.maxKeys));
    if (options?.continuationToken) qs.set('continuation-token', options.continuationToken);

    const queryString = qs.toString();
    const path = `/${this.#bucket(bucket)}`;
    const url = `${this.#endpoint}${path}?${queryString}`;
    const amzHeaders: Record<string, string> = { host: new URL(url).host };

    const res = await this.#signedFetch(url, 'GET', path, queryString, amzHeaders, emptyPayloadHash());
    return parseListResult(await res.text());
  }

  async getPresignedUrl(bucket: string, key: string, expiresInSeconds = 3600): Promise<string> {
    const path = `/${this.#bucket(bucket)}/${encodeKey(key)}`;
    const hostname = new URL(this.#endpoint).hostname;
    const url = await signPresignedUrl(
      'GET', path, this.#credentials, this.#region, 's3', expiresInSeconds, this.#signingTime(), hostname,
    );
    return url.toString();
  }

  async putPresignedUrl(bucket: string, key: string, expiresInSeconds = 3600): Promise<string> {
    const path = `/${this.#bucket(bucket)}/${encodeKey(key)}`;
    const hostname = new URL(this.#endpoint).hostname;
    const url = await signPresignedUrl(
      'PUT', path, this.#credentials, this.#region, 's3', expiresInSeconds, this.#signingTime(), hostname,
    );
    return url.toString();
  }

  async #fetchObject(method: string, bucket: string, key: string): Promise<S3GetObjectResult | null> {
    const path = `/${this.#bucket(bucket)}/${encodeKey(key)}`;
    const url = `${this.#endpoint}${path}`;
    const amzHeaders: Record<string, string> = { host: new URL(url).host };

    const res = await this.#signedFetch(url, method, path, '', amzHeaders, emptyPayloadHash());
    if (res.status === 404) return null;

    return {
      body: res.body!,
      ...(res.headers.get('content-type') ? { contentType: res.headers.get('content-type')! } : {}),
      ...(res.headers.get('content-length') ? { contentLength: Number(res.headers.get('content-length')) } : {}),
      ...(res.headers.get('etag') ? { etag: (res.headers.get('etag') ?? '').replace(/"/g, '') } : {}),
      ...(res.headers.get('last-modified') ? { lastModified: new Date(res.headers.get('last-modified')!) } : {}),
    };
  }
}

function encodeKey(key: string): string {
  return key.split('/').map(encodeURIComponent).join('/');
}

async function toArrayBuffer(body: ReadableStream | ArrayBuffer | Uint8Array): Promise<ArrayBuffer> {
  if (body instanceof ReadableStream) return new Response(body).arrayBuffer() as Promise<ArrayBuffer>;
  if (body instanceof ArrayBuffer) return body;
  return body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer;
}

function parseObjectInfo(key: string, res: Response): S3ObjectInfo {
  return {
    key,
    size: Number(res.headers.get('content-length') ?? 0),
    etag: (res.headers.get('etag') ?? '').replace(/"/g, ''),
    lastModified: res.headers.get('last-modified') ? new Date(res.headers.get('last-modified')!) : new Date(0),
    ...(res.headers.get('content-type') ? { contentType: res.headers.get('content-type')! } : {}),
  };
}

function parseListResult(xml: string): S3ListObjectsResult {
  const objects: S3ObjectInfo[] = [];
  const commonPrefixes: string[] = [];
  let isTruncated = false;
  let nextToken: string | undefined;

  const contents = xml.matchAll(/<Contents>(.*?)<\/Contents>/gs);
  for (const match of contents) {
    const key = match[1]!.match(/<Key>(.*?)<\/Key>/)?.[1] ?? '';
    const size = parseInt(match[1]!.match(/<Size>(.*?)<\/Size>/)?.[1] ?? '0', 10);
    const etag = (match[1]!.match(/<ETag>(.*?)<\/ETag>/)?.[1] ?? '').replace(/"/g, '');
    const lastMod = match[1]!.match(/<LastModified>(.*?)<\/LastModified>/)?.[1];
    const ct = match[1]!.match(/<ContentType>(.*?)<\/ContentType>/)?.[1];
    objects.push({
      key: decodeURIComponent(key),
      size,
      etag,
      lastModified: lastMod ? new Date(lastMod) : new Date(0),
      ...(ct ? { contentType: ct } : {}),
    });
  }

  const prefixes = xml.matchAll(/<CommonPrefixes>(.*?)<\/CommonPrefixes>/gs);
  for (const match of prefixes) {
    const prefix = match[1]!.match(/<Prefix>(.*?)<\/Prefix>/)?.[1] ?? '';
    commonPrefixes.push(prefix);
  }

  isTruncated = xml.includes('<IsTruncated>true</IsTruncated>');
  const tokenMatch = xml.match(/<NextContinuationToken>(.*?)<\/NextContinuationToken>/);
  if (tokenMatch) nextToken = tokenMatch[1];

  return {
    objects,
    commonPrefixes,
    isTruncated,
    ...(nextToken ? { nextContinuationToken: nextToken } : {}),
  };
}
