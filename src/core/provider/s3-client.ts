/**
 * S3 客户端基类 — 抽取三套 Provider 的共享逻辑
 *
 * AwsS3Provider / CloudflareR2S3Provider / AlibabaOssProvider 都重复实现
 * 了 encodeKey、parseListResult、parseObjectInfo、toArrayBuffer。
 * 子类只需实现 #authFetch() 方法处理各自的认证签名差异。
 */
import type {
  IS3Provider, S3PutObjectInput, S3GetObjectResult, S3ObjectInfo, S3ListObjectsResult, S3ProviderType,
} from './s3.ts';
import type { S3ProviderConfig } from './s3-types.ts';
import { payloadHash } from './s3-signer.ts';

export abstract class S3ClientBase implements IS3Provider {
  public abstract readonly type: S3ProviderType;
  protected readonly config: S3ProviderConfig;

  public constructor(config?: S3ProviderConfig) {
    this.config = config ?? {};
  }

  /** Subclass implements its own auth scheme (SigV4, OSS HMAC, etc.) */
  protected abstract authFetch(url: string, method: string, path: string, queryString: string, headers: Record<string, string>, bodyHash: string, body?: BodyInit): Promise<Response>;

  /** Bucket name mapping override */
  protected bucketMapping(bucket: string): string {
    return this.config.bucketNameMapping?.[bucket] ?? bucket;
  }

  public async putObject(input: S3PutObjectInput): Promise<{ etag: string }> {
    const bodyBuf = await toArrayBuffer(input.body);
    const bodyHash = input.contentType === 'application/octet-stream' ? '' : await payloadHash(bodyBuf);
    const bucket = this.bucketMapping(input.bucket);
    const path = `/${bucket}/${encodeKey(input.key)}`;
    const url = `${this.endpointFor(bucket)}${path}`;
    const amzHeaders: Record<string, string> = { host: new URL(url).host };
    if (input.contentType) amzHeaders['content-type'] = input.contentType;
    if (input.cacheControl) amzHeaders['cache-control'] = input.cacheControl;
    const res = await this.authFetch(url, 'PUT', path, '', amzHeaders, bodyHash, bodyBuf);
    return { etag: (res.headers.get('etag') ?? '').replace(/"/g, '') };
  }

  public async getObject(bucket: string, key: string): Promise<S3GetObjectResult | null> {
    return this.fetchObject('GET', bucket, key);
  }

  public async deleteObject(bucket: string, key: string): Promise<void> {
    const path = `/${this.bucketMapping(bucket)}/${encodeKey(key)}`;
    const url = `${this.endpointFor(bucket)}${path}`;
    const amzHeaders: Record<string, string> = { host: new URL(url).host };
    const res = await this.authFetch(url, 'DELETE', path, '', amzHeaders, '');
    if (res.status !== 204 && res.status !== 404) {
      throw new Error(`S3 deleteObject failed: ${String(res.status)} ${await res.text()}`);
    }
  }

  public async headObject(bucket: string, key: string): Promise<S3ObjectInfo | null> {
    try {
      const path = `/${this.bucketMapping(bucket)}/${encodeKey(key)}`;
      const url = `${this.endpointFor(bucket)}${path}`;
      const amzHeaders: Record<string, string> = { host: new URL(url).host };
      const res = await this.authFetch(url, 'HEAD', path, '', amzHeaders, '');
      if (res.status === 404) return null;
      return parseObjectInfo(key, res);
    } catch (e) { const _r = null; return _r; }
  }

  public async listObjects(
    bucket: string,
    options?: { prefix?: string; delimiter?: string; maxKeys?: number; continuationToken?: string },
  ): Promise<S3ListObjectsResult> {
    const qs = new URLSearchParams({ 'list-type': '2' });
    if (options?.prefix) qs.set('prefix', options.prefix);
    if (options?.delimiter) qs.set('delimiter', options.delimiter);
    if (options?.maxKeys) qs.set('max-keys', String(options.maxKeys));
    if (options?.continuationToken) qs.set('continuation-token', options.continuationToken);
    const queryString = qs.toString();
    const path = `/${this.bucketMapping(bucket)}`;
    const url = `${this.endpointFor(bucket)}${path}?${queryString}`;
    const amzHeaders: Record<string, string> = { host: new URL(url).host };
    const res = await this.authFetch(url, 'GET', path, queryString, amzHeaders, '');
    return parseListResult(await res.text());
  }

  // ─── Multi-part upload ───

  public async createMultipartUpload(input: { bucket: string; key: string; contentType?: string }): Promise<{ uploadId: string; key: string; bucket: string }> {
    const path = `/${this.bucketMapping(input.bucket)}/${encodeKey(input.key)}?uploads`;
    const url = `${this.endpointFor(input.bucket)}${path}`;
    const amzHeaders: Record<string, string> = { host: new URL(url).host };
    if (input.contentType) amzHeaders['content-type'] = input.contentType;
    const res = await this.authFetch(url, 'POST', `/${this.bucketMapping(input.bucket)}/${encodeKey(input.key)}`, 'uploads', amzHeaders, '');
    const xml = await res.text();
    const uploadId = (/<UploadId>(.*?)<\/UploadId>/.exec(xml))?.[1] ?? '';
    return { uploadId, key: input.key, bucket: input.bucket };
  }

  public async uploadPart(input: { bucket: string; key: string; uploadId: string; partNumber: number }, body: Uint8Array): Promise<{ etag: string; partNumber: number }> {
    const path = `/${this.bucketMapping(input.bucket)}/${encodeKey(input.key)}?partNumber=${String(input.partNumber)}&uploadId=${encodeURIComponent(input.uploadId)}`;
    const url = `${this.endpointFor(input.bucket)}${path}`;
    const amzHeaders: Record<string, string> = { host: new URL(url).host };
    const bodyBuf = body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer;
    const bodyHash = await payloadHash(bodyBuf);
    const res = await this.authFetch(url, 'PUT', `/${this.bucketMapping(input.bucket)}/${encodeKey(input.key)}`, `partNumber=${String(input.partNumber)}&uploadId=${encodeURIComponent(input.uploadId)}`, amzHeaders, bodyHash, bodyBuf);
    return { etag: (res.headers.get('etag') ?? '').replace(/"/g, ''), partNumber: input.partNumber };
  }

  public async completeMultipartUpload(input: { bucket: string; key: string; uploadId: string; parts: readonly { partNumber: number; etag: string }[] }): Promise<{ location?: string }> {
    const path = `/${this.bucketMapping(input.bucket)}/${encodeKey(input.key)}?uploadId=${encodeURIComponent(input.uploadId)}`;
    const url = `${this.endpointFor(input.bucket)}${path}`;
    const body = buildCompleteXml(input.parts);
    const amzHeaders: Record<string, string> = { host: new URL(url).host, 'content-type': 'application/xml' };
    const res = await this.authFetch(url, 'POST', `/${this.bucketMapping(input.bucket)}/${encodeKey(input.key)}`, `uploadId=${encodeURIComponent(input.uploadId)}`, amzHeaders, '', body);
    const xml = await res.text();
    const location = (/<Location>(.*?)<\/Location>/.exec(xml))?.[1];
    return { ...(location ? { location } : {}) };
  }

  public async abortMultipartUpload(input: { bucket: string; key: string; uploadId: string }): Promise<void> {
    const path = `/${this.bucketMapping(input.bucket)}/${encodeKey(input.key)}?uploadId=${encodeURIComponent(input.uploadId)}`;
    const url = `${this.endpointFor(input.bucket)}${path}`;
    const amzHeaders: Record<string, string> = { host: new URL(url).host };
    await this.authFetch(url, 'DELETE', `/${this.bucketMapping(input.bucket)}/${encodeKey(input.key)}`, `uploadId=${encodeURIComponent(input.uploadId)}`, amzHeaders, '');
  }

  public async listParts(bucket: string, key: string, uploadId: string): Promise<{ parts: readonly { partNumber: number; size: number; etag: string }[]; uploadId: string; isTruncated: boolean; nextPartNumberMarker?: number }> {
    const path = `/${this.bucketMapping(bucket)}/${encodeKey(key)}?uploadId=${encodeURIComponent(uploadId)}`;
    const url = `${this.endpointFor(bucket)}${path}`;
    const amzHeaders: Record<string, string> = { host: new URL(url).host };
    const res = await this.authFetch(url, 'GET', `/${this.bucketMapping(bucket)}/${encodeKey(key)}`, `uploadId=${encodeURIComponent(uploadId)}`, amzHeaders, '');
    const xml = await res.text();
    const parts: { partNumber: number; size: number; etag: string }[] = [];
    for (const m of xml.matchAll(/<Part>(.*?)<\/Part>/gs)) {
      const pn = parseInt((/<PartNumber>(.*?)<\/PartNumber>/.exec((m[1]!)))?.[1] ?? '0', 10);
      const sz = parseInt((/<Size>(.*?)<\/Size>/.exec((m[1]!)))?.[1] ?? '0', 10);
      const et = ((/<ETag>(.*?)<\/ETag>/.exec((m[1]!)))?.[1] ?? '').replace(/"/g, '');
      parts.push({ partNumber: pn, size: sz, etag: et });
    }
    const truncated = xml.includes('<IsTruncated>true</IsTruncated>');
    const nextMarker = (/<NextPartNumberMarker>(.*?)<\/NextPartNumberMarker>/.exec(xml))?.[1];
    return { parts, uploadId, isTruncated: truncated, ...(nextMarker ? { nextPartNumberMarker: parseInt(nextMarker, 10) } : {}) };
  }

  /** Get the base endpoint URL for a given bucket. Override for provider-specific logic. */
  protected endpointFor(_bucket: string): string { return ''; }

  protected async fetchObject(method: string, bucket: string, key: string): Promise<S3GetObjectResult | null> {
    const path = `/${this.bucketMapping(bucket)}/${encodeKey(key)}`;
    const url = `${this.endpointFor(bucket)}${path}`;
    const amzHeaders: Record<string, string> = { host: new URL(url).host };
    const res = await this.authFetch(url, method, path, '', amzHeaders, '');
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

// ─── 共享工具函数 ───

export function encodeKey(key: string): string {
  return key.split('/').map(encodeURIComponent).join('/');
}

export async function toArrayBuffer(body: ReadableStream | ArrayBuffer | Uint8Array): Promise<ArrayBuffer> {
  if (z.instanceof(ReadableStream).safeParse(body).success) return new Response(body as ReadableStream).arrayBuffer();
  if (z.instanceof(ArrayBuffer).safeParse(body).success) return body as ArrayBuffer;
  return (body as Uint8Array).buffer.slice((body as Uint8Array).byteOffset, (body as Uint8Array).byteOffset + (body as Uint8Array).byteLength) as ArrayBuffer;
}

export function parseObjectInfo(key: string, res: Response): S3ObjectInfo {
  return {
    key,
    size: Number(res.headers.get('content-length') ?? 0),
    etag: (res.headers.get('etag') ?? '').replace(/"/g, ''),
    lastModified: res.headers.get('last-modified') ? new Date(res.headers.get('last-modified')!) : new Date(0),
    ...(res.headers.get('content-type') ? { contentType: res.headers.get('content-type')! } : {}),
  };
}

export function parseListResult(xml: string): S3ListObjectsResult {
  const objects: S3ObjectInfo[] = [];
  const commonPrefixes: string[] = [];
  let isTruncated: boolean;
  let nextToken: string | undefined;

  const contents = xml.matchAll(/<Contents>(.*?)<\/Contents>/gs);
  for (const match of contents) {
    const key = (/<Key>(.*?)<\/Key>/.exec((match[1]!)))?.[1] ?? '';
    const size = parseInt((/<Size>(.*?)<\/Size>/.exec((match[1]!)))?.[1] ?? '0', 10);
    const etag = ((/<ETag>(.*?)<\/ETag>/.exec((match[1]!)))?.[1] ?? '').replace(/"/g, '');
    const lastMod = (/<LastModified>(.*?)<\/LastModified>/.exec((match[1]!)))?.[1];
    const ct = (/<ContentType>(.*?)<\/ContentType>/.exec((match[1]!)))?.[1];
    objects.push({
      key: decodeURIComponent(key), size, etag,
      lastModified: lastMod ? new Date(lastMod) : new Date(0),
      ...(ct ? { contentType: ct } : {}),
    });
  }

  const prefixes = xml.matchAll(/<CommonPrefixes>(.*?)<\/CommonPrefixes>/gs);
  for (const match of prefixes) {
    const prefix = (/<Prefix>(.*?)<\/Prefix>/.exec((match[1]!)))?.[1] ?? '';
    commonPrefixes.push(prefix);
  }

  isTruncated = xml.includes('<IsTruncated>true</IsTruncated>');
  const tokenMatch = /<NextContinuationToken>(.*?)<\/NextContinuationToken>/.exec(xml);
  if (tokenMatch) nextToken = tokenMatch[1];

  return { objects, commonPrefixes, isTruncated, ...(nextToken ? { nextContinuationToken: nextToken } : {}) };
}

function buildCompleteXml(parts: readonly { partNumber: number; etag: string }[]): string {
  const sorted = [...parts].sort((a, b) => a.partNumber - b.partNumber);
  const partTags = sorted.map(p => `  <Part><PartNumber>${String(p.partNumber)}</PartNumber><ETag>"${p.etag}"</ETag></Part>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<CompleteMultipartUpload>\n${partTags}\n</CompleteMultipartUpload>`;
}
