/**
 * Audit context injection — populates trusted fields from request context.
 *
 * Convention (journald-style):
 *   _prefix = trusted  (injected by framework, cannot be forged by business code)
 *   UPPERCASE = untrusted (caller-provided, like MESSAGE, PRIORITY)
 *   lowercase = custom (application-defined, like duration_ms, errno)
 */
import type { TrustedFields, AuditEntry } from './types.ts';
import type { KernLevel } from './kern-level.ts';

let _bootId: string | undefined;

/** Set the boot ID — called once at app startup. */
export function setBootId(id: string): void {
  _bootId = id;
}

/** Extract trusted fields from a Hono request context. */
export function trustedFromRequest(c: {
  var?: {
    currentUser?: { id?: string } | null;
    requestId?: string;
  };
  req?: {
    header(name: string): string | undefined;
  };
}): TrustedFields {
  const sourceIp = c.req?.header('cf-connecting-ip')
    ?? c.req?.header('x-forwarded-for')?.split(',')[0]?.trim();
  return {
    ...(c.var?.requestId ? { _request_id: c.var.requestId } : {}),
    ...(c.var?.currentUser?.id ? { _user_id: c.var.currentUser.id } : {}),
    ...(sourceIp ? { _source_ip: sourceIp } : {}),
    ...(_bootId ? { _boot_id: _bootId } : {}),
  };
}

/** Create an audit entry with trusted fields injected. */
export function createAuditEntry(
  facility: string,
  level: KernLevel,
  message: string,
  trusted: TrustedFields,
  extra?: { actorId?: string; metadata?: Record<string, unknown> },
): AuditEntry {
  return {
    facility,
    level,
    message,
    trusted,
    ...(extra?.actorId ? { actorId: extra.actorId } : {}),
    ...(extra?.metadata ? { metadata: extra.metadata } : {}),
  };
}
