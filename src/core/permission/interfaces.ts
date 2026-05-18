import type { IAtomicStore } from '../store/interfaces.ts';
import type { ILogWriter } from '../logger/interfaces.ts';
import type { PermissionCheck, PermissionResult, AuthzId, AuthzRecord } from './types.ts';

export interface PermissionDependencies {
  readonly atomic: IAtomicStore;
  readonly logger: ILogWriter;
}

export interface IPermissionChecker {
  check(params: PermissionCheck): Promise<PermissionResult>;
}

export interface IPermissionStore {
  getRecord(id: AuthzId): Promise<AuthzRecord | null>;
}
