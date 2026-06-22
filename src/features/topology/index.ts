import { Hono } from 'hono';
import type { FeatureDeps } from '../../core/deps.ts';
import { BucketService, InstanceService, ImageRepositoryService } from '../../core/region/index.ts';
import { CredentialService } from '../../core/auth/credential.ts';
import { S3PolicyManager } from '../../core/s3-policy/manager.ts';
import { createTopologyRouter } from './handler.ts';
import { createS3Provider } from '../../core/provider/s3-factory.ts';
import type { S3Credentials } from '../../core/provider/s3-factory.ts';

export function createRouter(deps: FeatureDeps): Hono<any> {
  const buckets = new BucketService(deps.stores.atomic);
  const instances = new InstanceService(deps.stores.atomic);
  const images = new ImageRepositoryService(deps.stores.atomic);
  const credentials = new CredentialService(deps.stores.atomic, deps.secretEncryption);
  const policyManager = new S3PolicyManager(deps.stores.atomic);

  // Resolve S3 provider from env config for multipart API support
  let s3Provider: ReturnType<typeof createS3Provider> | undefined;
  const s3Backend = process.env['S3_BACKEND'];
  if (s3Backend && s3Backend !== 'none') {
    const type = s3Backend as any;
    const region = process.env['S3_REGION'] ?? 'auto';
    const ak = process.env['S3_ACCESS_KEY_ID'] ?? process.env['MINIO_ACCESS_KEY'] ?? process.env['MINIO_ROOT_USER'] ?? '';
    const sk = process.env['S3_SECRET_ACCESS_KEY'] ?? process.env['MINIO_SECRET_KEY'] ?? process.env['MINIO_ROOT_PASSWORD'] ?? '';
    if (ak && sk) {
      const creds: S3Credentials = type === 'cloudflare-r2'
        ? { sigV4: { accessKeyId: ak, secretAccessKey: sk }, r2AccountId: process.env['S3_ACCOUNT_ID'] ?? region }
        : { sigV4: { accessKeyId: ak, secretAccessKey: sk } };
      s3Provider = createS3Provider(type, region, creds, process.env['S3_ENDPOINT'] ?? process.env['MINIO_ENDPOINT']);
    }
  }

  return createTopologyRouter(buckets, instances, images, credentials, policyManager, s3Provider);
}
