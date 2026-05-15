// Cloudflare R2 S3-compatible provider.
// Uses the S3 API with SigV4 signing.
// Endpoint: https://{account-id}.r2.cloudflarestorage.com
// Auth: R2 Access Key ID + Secret Access Key (from R2 token)

import type {
  IS3Provider,
  S3PutObjectInput,
  S3GetObjectResult,
  S3ObjectInfo,
  S3ListObjectsResult,
} from '../../core/provider/s3.ts';
import type { S3ProviderConfig } from '../../core/provider/s3-types.ts';
import { signSigV4, emptyPayloadHash, payloadHash } from '../../core/provider/s3-signer.ts';
import type { SigV4Credentials } from '../../core/provider/s3-signer.ts';

export class CloudflareR2S3Provider implements IS3Provider {
  readonly type = 'cloudflare-r2' as const;
  readonly #endpoint: string;
  readonly #credentials: SigV4Credentials;
  readonly #config: S3ProviderConfig;

  constructor(
    credentials: SigV4Credentials,
    accountId: string,
    config?: S3ProviderConfig,
  ) {
    this.#credentials = credentials;
    this.#endpoint = `https://${accountId}.r2.cloudflarestorage.com`;
    this.#config = config ?? {};
  }

  #bucket(bucket: string): string {
    return this.#config.bucketNameMapping?.[bucket] ?? bucket;
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
    amzHeaders['x-amz-content-sha256'] = bodyHash;

    const authHeaders = await signSigV4('PUT', path, '', amzHeaders, bodyHash, this.#credentials, 'auto', 's3', new Date());

    const res = await fetch(url, { method: 'PUT', headers: { ...amzHeaders, ...authHeaders }, body: bodyBuf });
    if (!res.ok) throw new Error(`R2 putObject failed: ${res.status} ${await res.text()}`);
    return { etag: (res.headers.get('etag') ?? '').replace(/"/g, '') };
  }

  async getObject(bucket: string, key: string): Promise<S3GetObjectResult | null> {
    return this.#fetchObject('GET', bucket, key);
  }

  async deleteObject(bucket: string, key: string): Promise<void> {
    const path = `/${this.#bucket(bucket)}/${encodeKey(key)}`;
    const url = `${this.#endpoint}${path}`;
    const authHeaders = await signSigV4('DELETE', path, '', { host: new URL(url).host }, emptyPayloadHash(), this.#credentials, 'auto', 's3', new Date());

    const res = await fetch(url, { method: 'DELETE', headers: authHeaders });
    if (!res.ok && res.status !== 204 && res.status !== 404) {
      throw new Error(`R2 deleteObject failed: ${res.status} ${await res.text()}`);
    }
  }

  async headObject(bucket: string, key: string): Promise<S3ObjectInfo | null> {
    try {
      const path = `/${this.#bucket(bucket)}/${encodeKey(key)}`;
      const url = `${this.#endpoint}${path}`;
      const authHeaders = await signSigV4('HEAD', path, '', { host: new URL(url).host }, emptyPayloadHash(), this.#credentials, 'auto', 's3', new Date());

      const res = await fetch(url, { method: 'HEAD', headers: authHeaders });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`R2 headObject failed: ${res.status}`);
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

    const authHeaders = await signSigV4('GET', path, queryString, { host: new URL(url).host }, emptyPayloadHash(), this.#credentials, 'auto', 's3', new Date());

    const res = await fetch(url, { headers: authHeaders });
    if (!res.ok) throw new Error(`R2 listObjects failed: ${res.status} ${await res.text()}`);
    return parseListResult(await res.text());
  }

  async #fetchObject(method: string, bucket: string, key: string): Promise<S3GetObjectResult | null> {
    const path = `/${this.#bucket(bucket)}/${encodeKey(key)}`;
    const url = `${this.#endpoint}${path}`;
    const authHeaders = await signSigV4(method, path, '', { host: new URL(url).host }, emptyPayloadHash(), this.#credentials, 'auto', 's3', new Date());

    const res = await fetch(url, { method, headers: authHeaders });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`R2 ${method} failed: ${res.status} ${await res.text()}`);

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
