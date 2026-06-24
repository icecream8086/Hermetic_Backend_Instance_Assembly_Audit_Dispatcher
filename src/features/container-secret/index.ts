import { Hono } from 'hono';
import type { FeatureDeps } from '../../core/deps.ts';
import { ContainerSecretService } from './service.ts';
import { createContainerSecretRouter } from './handler.ts';
import { UserKeyring } from '../../core/auth/keyring.ts';

export function createRouter(deps: FeatureDeps): Hono<any> {
  const keyring = new UserKeyring(deps.stores.atomic);
  const svc = new ContainerSecretService(
    deps.stores.atomic,
    deps.stores.blob,
    deps.secretEncryption,
    keyring,
  );
  return createContainerSecretRouter(svc);
}
