import type { Hono } from 'hono';
import type { IAtomicStore, IBlobStore } from '../../core/store/interfaces.ts';
import type { SecretEncryption } from '../../core/auth/secret-encryption.ts';
import { ContainerSecretService } from './service.ts';
import { createContainerSecretRouter } from './handler.ts';
import { UserKeyring } from '../../core/auth/keyring.ts';

/** Narrow dependency contract — only what this feature actually uses. */
export interface ContainerSecretDeps {
  stores: { atomic: IAtomicStore; blob?: IBlobStore };
  secretEncryption?: SecretEncryption;
}

export function createRouter(deps: ContainerSecretDeps): Hono<{ Variables: AppContext }> {
  const keyring = new UserKeyring(deps.stores.atomic);
  const svc = new ContainerSecretService(
    deps.stores.atomic,
    deps.stores.blob,
    deps.secretEncryption,
    keyring,
  );
  return createContainerSecretRouter(svc);
}
