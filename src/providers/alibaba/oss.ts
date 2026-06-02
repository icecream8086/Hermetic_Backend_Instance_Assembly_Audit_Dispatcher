// Alibaba Cloud OSS (Object Storage Service) provider.
// Uses OSS-native HMAC-SHA1 auth (different from SigV4).
// Path convention: https://oss-{region}.aliyuncs.com/{bucket}/{key} (path-style)
//
// Auth: Authorization = "OSS " + AccessKeyId + ":" + Signature
// Signature = base64(HMAC-SHA1(VERB + "\n" + Content-MD5 + "\n" + Content-Type + "\n" + Date + "\n" + CanonicalizedResource))
//
// Reference: https://www.alibabacloud.com/help/en/oss/developer-reference/add-signatures-to-requests

import type {
  IS3Provider,
  S3PutObjectInput,
  S3GetObjectResult,
  S3ObjectInfo,
  S3ListObjectsResult,
} from '../../core/provider/s3.ts';
import type { S3ProviderConfig } from '../../core/provider/s3-types.ts';

export class AlibabaOssProvider implements IS3Provider {
  readonly type = 'alibaba-oss' as const;
  readonly #accessKeyId: string;
  readonly #accessKeySecret: string;
  readonly #endpoint: string;
  readonly #config: S3ProviderConfig;
  #clockOffset = 0; // ms to add to Date.now() for clock skew compensation

  constructor(
    accessKeyId: string,
    accessKeySecret: string,
    region: string,
    endpoint?: string,
    config?: S3ProviderConfig,
  ) {
    this.#accessKeyId = accessKeyId;
    this.#accessKeySecret = accessKeySecret;
    this.#endpoint = endpoint ?? `https://oss-${region}.aliyuncs.com`;
    this.#config = config ?? {};
  }

  #signingDate(): string {
    return new Date(Date.now() + this.#clockOffset).toUTCString();
  }

  /** Extract server time from Date header on any response to calibrate clock offset. */
  #calibrateFromResponse(res: Response): void {
    const dateHeader = res.headers.get('date');
    if (dateHeader) {
      const serverTs = new Date(dateHeader).getTime();
      if (!isNaN(serverTs)) {
        this.#clockOffset = serverTs - Date.now();
      }
    }
  }

  #bucket(bucket: string): string {
    return this.#config.bucketNameMapping?.[bucket] ?? bucket;
  }

  async #signedFetch(url: string, method: string, resource: string, body?: BodyInit, extraHeaders?: Record<string, string>): Promise<Response> {
    for (let attempt = 0; attempt <= 2; attempt++) {
      const date = this.#signingDate();
      const contentType = extraHeaders?.['Content-Type'] ?? '';
      const contentMD5 = '';
      const stringToSign = `${method}\n${contentMD5}\n${contentType}\n${date}\n${resource}`;
      const auth = `OSS ${this.#accessKeyId}:${await hmacSha1Base64(this.#accessKeySecret, stringToSign)}`;

      const headers: Record<string, string> = { Authorization: auth, Date: date, ...extraHeaders };
      if (contentType) headers['Content-Type'] = contentType;
      const res = await fetch(url, { method, headers, ...(body !== undefined ? { body } : {}) });

      if (res.ok || res.status === 404) {
        this.#calibrateFromResponse(res);
        return res;
      }

      // On 403, try to calibrate from error response and retry once
      if (res.status === 403 && attempt < 2) {
        this.#calibrateFromResponse(res);
        continue;
      }

      throw new Error(`OSS ${method} failed: ${res.status} ${await res.text()}`);
    }
    throw new Error(`OSS ${method} failed after retries`);
  }

  async putObject(input: S3PutObjectInput): Promise<{ etag: string }> {
    const bodyBuf = await toArrayBuffer(input.body);
    const bucket = this.#bucket(input.bucket);
    const resource = `/${bucket}/${encodeKey(input.key)}`;
    const url = `${this.#endpoint}${resource}`;
    const extraHeaders: Record<string, string> = {};
    extraHeaders['Content-Type'] = input.contentType ?? 'application/octet-stream';
    if (input.cacheControl) extraHeaders['Cache-Control'] = input.cacheControl;

    const res = await this.#signedFetch(url, 'PUT', resource, bodyBuf, extraHeaders);
    return { etag: (res.headers.get('etag') ?? '').replace(/"/g, '') };
  }

  async getObject(bucket: string, key: string): Promise<S3GetObjectResult | null> {
    return this.#fetchObject('GET', bucket, key);
  }

  async deleteObject(bucket: string, key: string): Promise<void> {
    const resource = `/${this.#bucket(bucket)}/${encodeKey(key)}`;
    const url = `${this.#endpoint}${resource}`;
    const res = await this.#signedFetch(url, 'DELETE', resource);
    if (res.status !== 204 && res.status !== 404) {
      throw new Error(`OSS deleteObject failed: ${res.status} ${await res.text()}`);
    }
  }

  async headObject(bucket: string, key: string): Promise<S3ObjectInfo | null> {
    try {
      const resource = `/${this.#bucket(bucket)}/${encodeKey(key)}`;
      const url = `${this.#endpoint}${resource}`;
      const res = await this.#signedFetch(url, 'HEAD', resource);
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
    const qs = new URLSearchParams();
    if (options?.prefix) qs.set('prefix', options.prefix);
    if (options?.delimiter) qs.set('delimiter', options.delimiter);
    if (options?.maxKeys) qs.set('max-keys', String(options.maxKeys));

    const queryString = qs.toString();
    const resource = `/${this.#bucket(bucket)}${queryString ? `?${queryString}` : ''}`;
    const url = `${this.#endpoint}/${this.#bucket(bucket)}${queryString ? `?${queryString}` : ''}`;
    const extraHeaders: Record<string, string> = {};
    if (options?.continuationToken) {
      extraHeaders['x-oss-continuation-token'] = options.continuationToken;
    }

    const res = await this.#signedFetch(url, 'GET', resource, undefined, extraHeaders);
    return parseListResult(await res.text());
  }

  async #fetchObject(method: string, bucket: string, key: string): Promise<S3GetObjectResult | null> {
    const resource = `/${this.#bucket(bucket)}/${encodeKey(key)}`;
    const url = `${this.#endpoint}${resource}`;
    const res = await this.#signedFetch(url, method, resource);
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

  for (const match of xml.matchAll(/<Contents>(.*?)<\/Contents>/gs)) {
    const c = match[1]!;
    objects.push({
      key: decodeURIComponent(c.match(/<Key>(.*?)<\/Key>/)?.[1] ?? ''),
      size: parseInt(c.match(/<Size>(.*?)<\/Size>/)?.[1] ?? '0', 10),
      etag: (c.match(/<ETag>(.*?)<\/ETag>/)?.[1] ?? '').replace(/"/g, ''),
      lastModified: (() => { const d = c.match(/<LastModified>(.*?)<\/LastModified>/)?.[1]; return d ? new Date(d) : new Date(0); })(),
      ...(c.match(/<ContentType>(.*?)<\/ContentType>/)?.[1] ? { contentType: c.match(/<ContentType>(.*?)<\/ContentType>/)![1] } : {}),
    });
  }

  for (const match of xml.matchAll(/<CommonPrefixes>(.*?)<\/CommonPrefixes>/gs)) {
    commonPrefixes.push(match[1]!.match(/<Prefix>(.*?)<\/Prefix>/)?.[1] ?? '');
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

/** HMAC-SHA1 → Base64 — OSS signature scheme. */
async function hmacSha1Base64(secret: string, data: string): Promise<string> {
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-1' },
    false, ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, enc.encode(data));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}
