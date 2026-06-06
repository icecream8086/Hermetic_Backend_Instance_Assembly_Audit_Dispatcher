import { KernLevel } from '../../core/audit/kern-level.ts';
import type { IAuditWriter } from '../../core/audit/types.ts';
import type { ILogWriter } from '../../core/logger/interfaces.ts';
import { LogLevel } from '../../core/types.ts';
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
) {
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
  logger: ILogWriter,
  eventType: string,
  actor: AuditActor | undefined,
  fields: Record<string, unknown>,
  level: KernLevel,
  message?: string,
) {
  const entry = permEvent(eventType, actor, fields, level, message);
  // Map KernLevel → LogLevel for the writer interface
  const logLevel = level <= KernLevel.ERR ? LogLevel.ERROR
    : level === KernLevel.WARNING ? LogLevel.WARN
    : LogLevel.INFO;
  return logger.logAsync({
    facility: FACILITY,
    level: logLevel,
    message: entry.message,
    metadata: entry.metadata,
  });
}

export function permAudit(
  audit: IAuditWriter | undefined,
  eventType: string,
  actor: AuditActor | undefined,
  fields: Record<string, unknown>,
  level: KernLevel,
  message?: string,
) {
  return audit?.write(permEvent(eventType, actor, fields, level, message));
}

// ─── Convenience: log + audit in one call ───

export function permLogAudit(
  logger: ILogWriter,
  audit: IAuditWriter | undefined,
  eventType: string,
  actor: AuditActor | undefined,
  fields: Record<string, unknown>,
  level: KernLevel,
  message?: string,
) {
  void permLog(logger, eventType, actor, fields, level, message);
  return permAudit(audit, eventType, actor, fields, level, message);
}

// ─── Entity type ───

export type EntityType = 'policy' | 'userGroup' | 'permissionGroup' | 'routeAcl' | 'template';
