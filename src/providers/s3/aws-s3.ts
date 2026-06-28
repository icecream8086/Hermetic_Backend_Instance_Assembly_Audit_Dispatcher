/**
 * AWS S3 provider — SigV4 auth via S3ClientBase.
 * No SDK dependency: pure HTTP + SigV4 signing via Web Crypto API.
 */
import { S3ClientBase, encodeKey } from '../../core/provider/s3-client.ts';
import type { S3ProviderConfig } from '../../core/provider/s3-types.ts';
import { signSigV4, signPresignedUrl, emptyPayloadHash, extractServerTimeFromError } from '../../core/provider/s3-signer.ts';
import type { SigV4Credentials } from '../../core/provider/s3-signer.ts';

const CLOCK_SKEW_RETRIES = 2;

export class AwsS3Provider extends S3ClientBase {
  readonly type = 'aws-s3' as const;
  readonly #region: string;
  readonly #endpoint: string;
  readonly #credentials: SigV4Credentials;
  #clockOffset = 0;

  public constructor(credentials: SigV4Credentials, region: string, endpoint?: string, config?: S3ProviderConfig) {
    super(config);
    this.#credentials = credentials;
    this.#region = region;
    this.#endpoint = endpoint ?? `https://s3.${region}.amazonaws.com`;
  }

  #signingTime(): Date {
    return new Date(Date.now() + this.#clockOffset);
  }

  protected endpointFor(_bucket: string): string {
    return this.#endpoint;
  }

  protected async authFetch(url: string, method: string, path: string, queryString: string, headers: Record<string, string>, bodyHash: string, body?: BodyInit): Promise<Response> {
    for (let attempt = 0; attempt <= CLOCK_SKEW_RETRIES; attempt++) {
      const authHeaders = await signSigV4(method, path, queryString, headers, bodyHash || emptyPayloadHash(), this.#credentials, this.#region, 's3', this.#signingTime());
      const res = await fetch(url, { method, headers: { ...headers, ...authHeaders }, ...(body !== undefined ? { body } : {}) });

      if (res.ok || res.status === 404) return res;

      if (res.status === 403 && attempt < CLOCK_SKEW_RETRIES) {
        const bodyText = await res.clone().text().catch(() => '');
        const serverTime = extractServerTimeFromError(bodyText);
        if (serverTime) {
          const serverTs = serverTime.getTime();
          if (!isNaN(serverTs)) {
            this.#clockOffset = serverTs - Date.now();
            continue;
          }
        }
      }
      throw new Error(`S3 ${method} failed: ${res.status} ${await res.text()}`);
    }
    throw new Error(`S3 ${method} failed after ${CLOCK_SKEW_RETRIES} retries`);
  }

  public async getPresignedUrl(bucket: string, key: string, expiresInSeconds = 3600): Promise<string> {
    const path = `/${this.bucketMapping(bucket)}/${encodeKey(key)}`;
    const hostname = new URL(this.#endpoint).hostname;
    const url = await signPresignedUrl('GET', path, this.#credentials, this.#region, 's3', expiresInSeconds, this.#signingTime(), hostname);
    return url.toString();
  }

  public async putPresignedUrl(bucket: string, key: string, expiresInSeconds = 3600): Promise<string> {
    const path = `/${this.bucketMapping(bucket)}/${encodeKey(key)}`;
    const hostname = new URL(this.#endpoint).hostname;
    const url = await signPresignedUrl('PUT', path, this.#credentials, this.#region, 's3', expiresInSeconds, this.#signingTime(), hostname);
    return url.toString();
  }
}
