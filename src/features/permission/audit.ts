import type { KernLevel } from '../../core/audit/kern-level.ts';
import type { IAuditWriter } from '../../core/audit/types.ts';
import { createFacility } from '../../core/brand.ts';

const FACILITY = createFacility('perm-audit');

// ─── Actor context ───

export interface AuditActor {
  userId?: string | undefined;
  ip?: string | undefined;
}

// ─── Event builders ───

export function permEvent(
  eventType: string,
  actor: AuditActor | undefined,
  fields: Record<string, unknown>,
  level: KernLevel,
  message?: string,
): AuditEntry {
  return {
    level,
    facility: FACILITY,
    message: message ?? `${eventType} by ${actor?.userId ?? 'unknown'}`,
    actorId: actor?.userId,
    metadata: {
      eventType,
      ...(actor?.userId ? { actorId: actor.userId } : {}),
      ...(actor?.ip ? { actorIp: actor.ip } : {}),
      timestamp: Date.now(),
      ...fields,
    },
  };
}

export function permLog(
  logger: IAuditWriter,
  eventType: string,
  actor: AuditActor | undefined,
  fields: Record<string, unknown>,
  level: KernLevel,
  message?: string,
): void {
  const msg: string = message ?? `${eventType} by ${actor?.userId ?? 'unknown'}`;
  logger.write({
    facility: FACILITY,
    level,
    message: msg,
    actorId: actor?.userId,
    metadata: {
      eventType,
      ...(actor?.userId ? { actorId: actor.userId } : {}),
      ...(actor?.ip ? { actorIp: actor.ip } : {}),
      timestamp: Date.now(),
      ...fields,
    },
  });
}

export function permAudit(
  audit: IAuditWriter | undefined,
  eventType: string,
  actor: AuditActor | undefined,
  fields: Record<string, unknown>,
  level: KernLevel,
  message?: string,
): void {
  return audit?.write(permEvent(eventType, actor, fields, level, message));
}

// ─── Convenience: log + audit in one call ───

export function permLogAudit(
  logger: IAuditWriter,
  audit: IAuditWriter | undefined,
  eventType: string,
  actor: AuditActor | undefined,
  fields: Record<string, unknown>,
  level: KernLevel,
  message?: string,
): void {
  permLog(logger, eventType, actor, fields, level, message);
  permAudit(audit, eventType, actor, fields, level, message);
}

// ─── Entity type ───

export type EntityType = 'policy' | 'userGroup' | 'permissionGroup' | 'routeAcl' | 'template';
