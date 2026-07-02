import type { Hono } from 'hono';
import type { IAtomicStore } from '../../core/store/interfaces.ts';
import type { IAuditWriter } from '../../core/audit/types.ts';
import { ConsoleLogger } from '../../core/audit/console-logger.ts';
import { SysGroupService } from './service.ts';
import { createSysGroupRouter } from './handler.ts';

/** Narrow dependency contract — only what this feature actually uses. */
export interface SysGroupDeps {
  stores: { atomic: IAtomicStore };
  audit?: IAuditWriter;
}

export function createRouter(deps: SysGroupDeps): Hono<{ Variables: AppContext }> {
  const service = new SysGroupService(deps.stores.atomic, new ConsoleLogger(), deps.audit);
  return createSysGroupRouter(service);
}
