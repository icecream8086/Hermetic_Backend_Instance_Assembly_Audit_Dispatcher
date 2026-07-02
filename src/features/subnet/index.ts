import type { Hono } from 'hono';
import type { IAtomicStore } from '../../core/store/interfaces.ts';
import type { IAuditWriter } from '../../core/audit/types.ts';
import { ConsoleLogger } from '../../core/audit/console-logger.ts';
import { SubnetService } from './service.ts';
import { createSubnetRouter } from './handler.ts';
import { InstanceService } from '../../core/region/instance.ts';

/** Narrow dependency contract — only what this feature actually uses. */
export interface SubnetDeps {
  stores: { atomic: IAtomicStore };
  audit?: IAuditWriter;
}

export function createRouter(deps: SubnetDeps): Hono<{ Variables: AppContext }> {
  const instanceSvc = new InstanceService(deps.stores.atomic);
  const svc = new SubnetService(deps.stores.atomic, new ConsoleLogger(), deps.audit, instanceSvc);
  return createSubnetRouter(svc);
}
