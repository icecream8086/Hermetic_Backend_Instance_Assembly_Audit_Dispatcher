import { Hono } from 'hono';
import type { IAtomicStore } from '../../core/store/interfaces.ts';
import type { IAuditWriter } from '../../core/audit/types.ts';
import type { INetworkPolicyProvider } from '../../core/provider/interfaces.ts';
import { ConsoleLogger } from '../../core/audit/console-logger.ts';
import { SecurityGroupService } from './service.ts';
import { createSecurityGroupRouter } from './handler.ts';
import { InstanceService } from '../../core/region/instance.ts';

/** Narrow dependency contract — only what this feature actually uses. */
export interface NetworkDeps {
  stores: { atomic: IAtomicStore };
  audit?: IAuditWriter;
  providers: { networkPolicy?: INetworkPolicyProvider | undefined };
}

export function createRouter(deps: NetworkDeps): Hono<any> {
  const instanceSvc = new InstanceService(deps.stores.atomic);
  const svc = new SecurityGroupService(deps.stores.atomic, new ConsoleLogger(), deps.audit, deps.providers.networkPolicy, instanceSvc);
  return createSecurityGroupRouter(svc);
}
