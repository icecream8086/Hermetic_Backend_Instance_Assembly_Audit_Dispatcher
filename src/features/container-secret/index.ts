import { Hono } from 'hono';
import type { FeatureDeps } from '../../core/app.ts';
import { ContainerSecretService } from './service.ts';
import { createContainerSecretRouter } from './handler.ts';

export function createRouter(deps: FeatureDeps): Hono<any> {
  const svc = new ContainerSecretService(
    deps.stores.atomic,
    deps.stores.blob,
    deps.secretEncryption,
  );
  return createContainerSecretRouter(svc);
}
