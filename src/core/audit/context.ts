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

/** Get the current boot ID (set at startup). */
export function getBootId(): string | undefined {
  return _bootId;
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
  // Strip _-prefixed keys from caller metadata to prevent forgery of trusted fields.
  // journald convention: _ prefix = trusted (kernel/journald injected, cannot be set by app).
  const safeMetadata = extra?.metadata ? stripTrustedKeys(extra.metadata) : undefined;

  return {
    facility,
    level,
    message,
    trusted,
    ...(extra?.actorId ? { actorId: extra.actorId } : {}),
    ...(safeMetadata ? { metadata: safeMetadata } : {}),
  };
}

/** Strip any key starting with _ from a metadata record (prevents trusted field forgery). */
function stripTrustedKeys(meta: Record<string, unknown>): Record<string, unknown> {
  const cleaned: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta)) {
    if (!k.startsWith('_')) cleaned[k] = v;
  }
  return cleaned;
}
