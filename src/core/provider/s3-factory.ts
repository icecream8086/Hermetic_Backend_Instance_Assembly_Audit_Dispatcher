// ─── S3 provider factory ───
// Creates an IS3Provider instance from type + credentials + config.
// Auth differences are handled per-implementation:
//   aws-s3 / cloudflare-r2 → SigV4 (AWS4-HMAC-SHA256)
//   alibaba-oss → OSS HMAC-SHA1

import type { IS3Provider } from './s3.ts';
import type { S3ProviderType, S3ProviderConfig } from './s3-types.ts';
import { AwsS3Provider } from '../../providers/s3/aws-s3.ts';
import { CloudflareR2S3Provider } from '../../providers/cloudflare/r2-s3.ts';
import { AlibabaOssProvider } from '../../providers/alibaba/oss.ts';
import type { SigV4Credentials } from './s3-signer.ts';

export interface S3Credentials {
  /** For aws-s3 and cloudflare-r2: SigV4 access key + secret. */
  readonly sigV4?: SigV4Credentials;
  /** For alibaba-oss. */
  readonly oss?: {
    readonly accessKeyId: string;
    readonly accessKeySecret: string;
  };
  /** Cloudflare account ID (required for cloudflare-r2). */
  readonly r2AccountId?: string;
}

export function createS3Provider(
  type: S3ProviderType,
  region: string,
  credentials: S3Credentials,
  config?: S3ProviderConfig,
): IS3Provider {
  switch (type) {
    case 'aws-s3': {
      if (!credentials.sigV4) {
        throw new Error('AWS S3 provider requires SigV4 credentials (accessKeyId + secretAccessKey)');
      }
      return new AwsS3Provider(credentials.sigV4, region, undefined, config);
    }

    case 'alibaba-oss': {
      if (!credentials.oss) {
        throw new Error('Alibaba OSS provider requires OSS credentials (accessKeyId + accessKeySecret)');
      }
      return new AlibabaOssProvider(
        credentials.oss.accessKeyId,
        credentials.oss.accessKeySecret,
        region,
        undefined,
        config,
      );
    }

    case 'cloudflare-r2': {
      if (!credentials.sigV4 || !credentials.r2AccountId) {
        throw new Error('Cloudflare R2 provider requires SigV4 credentials + accountId');
      }
      return new CloudflareR2S3Provider(credentials.sigV4, credentials.r2AccountId, config);
    }
  }
}
