import { Hono } from 'hono';
import type { FeatureDeps } from '../../core/app.ts';
import { BucketService, InstanceService } from '../../core/region/index.ts';
import { CredentialService } from '../../core/auth/credential.ts';
import { createTopologyRouter } from './handler.ts';

export function createRouter(deps: FeatureDeps): Hono<any> {
  const buckets = new BucketService(deps.stores.atomic);
  const instances = new InstanceService(deps.stores.atomic);
  const credentials = new CredentialService(deps.stores.atomic);
  return createTopologyRouter(buckets, instances, credentials);
}
