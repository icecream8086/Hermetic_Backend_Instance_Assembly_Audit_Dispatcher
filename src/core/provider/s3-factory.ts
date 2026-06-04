// ─── S3 provider factory ───
// Creates an IS3Provider instance from type + credentials + config.
// Auth differences are handled per-implementation:
//   aws-s3 / cloudflare-r2 / minio → SigV4 (AWS4-HMAC-SHA256)
//   alibaba-oss → OSS HMAC-SHA1

import type { IS3Provider } from './s3.ts';
import type { S3ProviderType, S3ProviderConfig } from './s3-types.ts';
import type { S3Config } from '../../config/types.ts';
import { AwsS3Provider } from '../../providers/s3/aws-s3.ts';
import { CloudflareR2S3Provider } from '../../providers/cloudflare/r2-s3.ts';
import { AlibabaOssProvider } from '../../providers/alibaba/oss.ts';
import type { SigV4Credentials } from './s3-signer.ts';

export interface S3Credentials {
  readonly sigV4?: SigV4Credentials;
  readonly oss?: { readonly accessKeyId: string; readonly accessKeySecret: string };
  readonly r2AccountId?: string;
}

export function createS3Provider(
  type: S3ProviderType,
  region: string,
  credentials: S3Credentials,
  endpoint?: string,
  config?: S3ProviderConfig,
): IS3Provider {
  switch (type) {
    case 'aws-s3': {
      if (!credentials.sigV4) throw new Error('AWS S3 requires SigV4 credentials');
      return new AwsS3Provider(credentials.sigV4, region, endpoint, config);
    }
    case 'minio': {
      if (!credentials.sigV4) throw new Error('MinIO requires SigV4 credentials');
      return new AwsS3Provider(credentials.sigV4, region, endpoint ?? 'http://localhost:9000', config);
    }
    case 'alibaba-oss': {
      if (!credentials.oss) throw new Error('Alibaba OSS requires OSS credentials');
      return new AlibabaOssProvider(credentials.oss.accessKeyId, credentials.oss.accessKeySecret, region, endpoint, config);
    }
    case 'cloudflare-r2': {
      if (!credentials.sigV4 || !credentials.r2AccountId) throw new Error('Cloudflare R2 requires SigV4 credentials + accountId');
      return new CloudflareR2S3Provider(credentials.sigV4, credentials.r2AccountId, config);
    }
  }
}

// ─── Multi-account S3 registry ───

export interface S3ProviderEntry {
  readonly name: string;
  readonly provider: IS3Provider;
  readonly bucket?: string | undefined;
}

/**
 * Create S3 providers from S3Config, supporting multi-account.
 * Each account becomes a named S3ProviderEntry in the registry.
 */
export function createS3Providers(config: S3Config): { entries: S3ProviderEntry[]; defaultName: string } {
  const type = config.backend === 'none' ? 'minio' : config.backend;
  const entries: S3ProviderEntry[] = [];

  for (const acct of config.accounts) {
    const ak = acct.accessKeyId ?? '';
    const sk = acct.accessKeySecret ?? '';
    if (!ak || !sk) continue;
    const creds: S3Credentials = type === 'alibaba-oss'
      ? { oss: { accessKeyId: ak, accessKeySecret: sk } }
      : type === 'cloudflare-r2'
        ? { sigV4: { accessKeyId: ak, secretAccessKey: sk }, r2AccountId: (acct.extra?.r2AccountId as string) ?? config.region }
        : { sigV4: { accessKeyId: ak, secretAccessKey: sk } };
    const ep = acct.endpoint ?? config.endpoint;
    entries.push({
      name: acct.name,
      provider: createS3Provider(type, acct.defaultRegion ?? config.region, creds, ep),
      bucket: acct.bucket,
    });
  }

  return {
    entries,
    defaultName: config.defaultAccount,
  };
}
