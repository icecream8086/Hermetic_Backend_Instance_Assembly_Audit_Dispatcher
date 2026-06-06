/**
 * Alibaba Cloud OSS provider — OSS-native HMAC-SHA1 auth.
 * Extends S3ClientBase. Auth is the only difference from SigV4 providers.
 */
import { S3ClientBase } from '../../core/provider/s3-client.ts';
import type { S3ProviderConfig } from '../../core/provider/s3-types.ts';
import { hmacSha1 } from '../../core/auth/providers.ts';

export class AlibabaOssProvider extends S3ClientBase {
  readonly type = 'alibaba-oss' as const;
  readonly #accessKeyId: string;
  readonly #accessKeySecret: string;
  readonly #endpoint: string;

  constructor(accessKeyId: string, accessKeySecret: string, region: string, endpoint?: string, config?: S3ProviderConfig) {
    super(config);
    this.#accessKeyId = accessKeyId;
    this.#accessKeySecret = accessKeySecret;
    this.#endpoint = endpoint ?? `https://oss-${region}.aliyuncs.com`;
  }

  protected endpointFor(_bucket: string): string {
    return this.#endpoint;
  }

  protected async authFetch(url: string, method: string, _path: string, _queryString: string, headers: Record<string, string>, _bodyHash: string, body?: BodyInit): Promise<Response> {
    const dateStr = new Date().toUTCString();
    const ossHeaders = Object.keys(headers)
      .filter(k => k.startsWith('x-oss-'))
      .sort()
      .map(k => `${k.toLowerCase()}:${headers[k]}\n`).join('');

    const contentMD5 = headers['content-md5'] ?? '';
    const contentType = headers['content-type'] ?? '';
    const canonicalizedResource = new URL(url).pathname;
    const stringToSign = `${method}\n${contentMD5}\n${contentType}\n${dateStr}\n${ossHeaders}${canonicalizedResource}`;

    const signature = await hmacSha1(this.#accessKeySecret, stringToSign);
    const authHeader = `OSS ${this.#accessKeyId}:${signature}`;

    const res = await fetch(url, {
      method,
      headers: { ...headers, Authorization: authHeader, Date: dateStr, ...(body !== undefined ? { 'content-length': String(headers['content-length'] ?? (body as any).byteLength ?? 0) } : {}) },
      ...(body !== undefined ? { body } : {}),
    });

    if (res.ok || res.status === 404) return res;
    throw new Error(`OSS ${method} failed: ${res.status} ${await res.text()}`);
  }
}
