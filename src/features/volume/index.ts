import { Hono } from 'hono';
import type { IAtomicStore } from '../../core/store/interfaces.ts';
import type { IAuditWriter } from '../../core/audit/types.ts';
import { ConsoleLogger } from '../../core/audit/console-logger.ts';
import { VolumeService } from './service.ts';
import { createVolumeRouter } from './handler.ts';

/** Narrow dependency contract — only the stores and services this feature actually uses. */
export interface VolumeDeps {
  stores: { atomic: IAtomicStore };
  audit?: IAuditWriter;
}

export function createRouter(deps: VolumeDeps): Hono<any> {
  const svc = new VolumeService(deps.stores.atomic, new ConsoleLogger(), deps.audit);
  return createVolumeRouter(svc);
}
