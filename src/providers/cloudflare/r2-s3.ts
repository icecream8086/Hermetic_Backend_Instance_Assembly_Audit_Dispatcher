/**
 * Cloudflare R2 S3 provider — SigV4 with account ID.
 * Extends S3ClientBase. Significant code reduction vs manual implementation.
 */
import { S3ClientBase } from '../../core/provider/s3-client.ts';
import type { S3ProviderConfig } from '../../core/provider/s3-types.ts';
import { signSigV4, emptyPayloadHash, signPresignedUrl } from '../../core/provider/s3-signer.ts';
import type { SigV4Credentials } from '../../core/provider/s3-signer.ts';

const CLOCK_SKEW_RETRIES = 2;

export class CloudflareR2S3Provider extends S3ClientBase {
  public readonly type = 'cloudflare-r2' as const;
  readonly #accountId: string;
  readonly #credentials: SigV4Credentials;
  #clockOffset = 0;

  public constructor(credentials: SigV4Credentials, accountId: string, config?: S3ProviderConfig) {
    super(config);
    this.#credentials = credentials;
    this.#accountId = accountId;
  }

  protected endpointFor(_bucket: string): string {
    return `https://${this.#accountId}.r2.cloudflarestorage.com`;
  }

  #signingTime(): Date {
    return new Date(Date.now() + this.#clockOffset);
  }

  protected async authFetch(url: string, method: string, path: string, queryString: string, headers: Record<string, string>, bodyHash: string, body?: BodyInit): Promise<Response> {
    for (let attempt = 0; attempt <= CLOCK_SKEW_RETRIES; attempt++) {
      const authHeaders = await signSigV4(method, path, queryString, headers, bodyHash || emptyPayloadHash(), this.#credentials, 'auto', 's3', this.#signingTime());
      const res = await fetch(url, { method, headers: { ...headers, ...authHeaders }, ...(body !== undefined ? { body } : {}) });
      if (res.ok || res.status === 404) return res;
      if (res.status === 403 && attempt < CLOCK_SKEW_RETRIES) {
        let bodyText = '';
        try { bodyText = await res.clone().text(); } catch {

          console.debug("ignore");

        }
        if (bodyText.includes('RequestTimeTooSkewed') || bodyText.includes('Skewed')) continue;
      }
      throw new Error(`R2 ${method} failed: ${String(res.status)} ${await res.text()}`);
    }
    throw new Error(`R2 ${method} failed after ${String(CLOCK_SKEW_RETRIES)} retries`);
  }

  public async getPresignedUrl(bucket: string, key: string, expiresInSeconds = 3600): Promise<string> {
    const now = this.#signingTime();
    const canonicalUri = `/${this.#bucketMapping(bucket)}/${key.split('/').map(encodeURIComponent).join('/')}`;
    const host = `${this.#accountId}.r2.cloudflarestorage.com`;
    const url = await signPresignedUrl('GET', canonicalUri, this.#credentials, 'auto', 's3', expiresInSeconds, now, host);
    return url.toString();
  }

  public async putPresignedUrl(bucket: string, key: string, expiresInSeconds = 3600): Promise<string> {
    const now = this.#signingTime();
    const canonicalUri = `/${this.#bucketMapping(bucket)}/${key.split('/').map(encodeURIComponent).join('/')}`;
    const host = `${this.#accountId}.r2.cloudflarestorage.com`;
    const url = await signPresignedUrl('PUT', canonicalUri, this.#credentials, 'auto', 's3', expiresInSeconds, now, host);
    return url.toString();
  }

  #bucketMapping(bucket: string): string {
    return this.config.bucketNameMapping?.[bucket] ?? bucket;
  }
}
