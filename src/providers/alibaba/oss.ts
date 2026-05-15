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

  #bucket(bucket: string): string {
    return this.#config.bucketNameMapping?.[bucket] ?? bucket;
  }

  async putObject(input: S3PutObjectInput): Promise<{ etag: string }> {
    const bodyBuf = await toArrayBuffer(input.body);
    const contentType = input.contentType ?? 'application/octet-stream';
    const date = new Date().toUTCString();
    const bucket = this.#bucket(input.bucket);
    const resource = `/${bucket}/${encodeKey(input.key)}`;

    const stringToSign = `PUT\n\n${contentType}\n${date}\n${resource}`;
    const auth = `OSS ${this.#accessKeyId}:${await hmacSha1Base64(this.#accessKeySecret, stringToSign)}`;

    const url = `${this.#endpoint}${resource}`;
    const res = await fetch(url, {
      method: 'PUT',
      headers: {
        Authorization: auth,
        'Content-Type': contentType,
        Date: date,
        ...(input.cacheControl ? { 'Cache-Control': input.cacheControl } : {}),
      },
      body: bodyBuf,
    });

    if (!res.ok) throw new Error(`OSS putObject failed: ${res.status} ${await res.text()}`);
    return { etag: (res.headers.get('etag') ?? '').replace(/"/g, '') };
  }

  async getObject(bucket: string, key: string): Promise<S3GetObjectResult | null> {
    return this.#fetchObject('GET', bucket, key);
  }

  async deleteObject(bucket: string, key: string): Promise<void> {
    const resource = `/${this.#bucket(bucket)}/${encodeKey(key)}`;
    const date = new Date().toUTCString();
    const auth = `OSS ${this.#accessKeyId}:${await hmacSha1Base64(this.#accessKeySecret, `DELETE\n\n\n${date}\n${resource}`)}`;

    const url = `${this.#endpoint}${resource}`;
    const res = await fetch(url, { method: 'DELETE', headers: { Authorization: auth, Date: date } });
    if (!res.ok && res.status !== 204 && res.status !== 404) {
      throw new Error(`OSS deleteObject failed: ${res.status} ${await res.text()}`);
    }
  }

  async headObject(bucket: string, key: string): Promise<S3ObjectInfo | null> {
    try {
      const resource = `/${this.#bucket(bucket)}/${encodeKey(key)}`;
      const date = new Date().toUTCString();
      const auth = `OSS ${this.#accessKeyId}:${await hmacSha1Base64(this.#accessKeySecret, `HEAD\n\n\n${date}\n${resource}`)}`;

      const url = `${this.#endpoint}${resource}`;
      const res = await fetch(url, { method: 'HEAD', headers: { Authorization: auth, Date: date } });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`OSS headObject failed: ${res.status}`);
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
    const date = new Date().toUTCString();
    const auth = `OSS ${this.#accessKeyId}:${await hmacSha1Base64(this.#accessKeySecret, `GET\n\n\n${date}\n${resource}`)}`;

    const url = `${this.#endpoint}/${this.#bucket(bucket)}${queryString ? `?${queryString}` : ''}`;
    const headers: Record<string, string> = { Authorization: auth, Date: date };
    if (options?.continuationToken) {
      headers['x-oss-continuation-token'] = options.continuationToken;
    }

    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`OSS listObjects failed: ${res.status} ${await res.text()}`);
    return parseListResult(await res.text());
  }

  async #fetchObject(method: string, bucket: string, key: string): Promise<S3GetObjectResult | null> {
    const resource = `/${this.#bucket(bucket)}/${encodeKey(key)}`;
    const date = new Date().toUTCString();
    const auth = `OSS ${this.#accessKeyId}:${await hmacSha1Base64(this.#accessKeySecret, `${method}\n\n\n${date}\n${resource}`)}`;

    const url = `${this.#endpoint}${resource}`;
    const res = await fetch(url, { method, headers: { Authorization: auth, Date: date } });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`OSS ${method} failed: ${res.status} ${await res.text()}`);

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
