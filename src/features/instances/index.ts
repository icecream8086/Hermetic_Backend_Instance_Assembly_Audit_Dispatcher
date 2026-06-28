import type { Hono } from 'hono';
import type { IAtomicStore } from '../../core/store/interfaces.ts';
import type { IAuditWriter } from '../../core/audit/types.ts';
import { ConsoleLogger } from '../../core/audit/console-logger.ts';
import { RunnerService } from './service.ts';
import { createInstancesRouter } from './handler.ts';

/** Narrow dependency contract — only what this feature actually uses. */
export interface InstancesDeps {
  stores: { atomic: IAtomicStore };
  audit?: IAuditWriter;
}

export function createRouter(deps: InstancesDeps): Hono<any> {
  const service = new RunnerService(deps.stores.atomic, new ConsoleLogger(), deps.audit);
  return createInstancesRouter(service);
}
