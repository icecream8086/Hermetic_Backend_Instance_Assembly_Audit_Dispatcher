/**
 * Log namespace isolation — per-facility + per-sandbox query helpers.
 *
 * journald §4 model:
 *   _SYSTEMD_UNIT  → per-service isolation
 *   _SYSTEMD_CGROUP → per-container isolation
 *   SYSLOG_FACILITY → per-facility isolation
 *
 * For this project:
 *   facility       → AuditFacility (0-23)
 *   _sandbox_id    → per-sandbox log isolation
 *   _boot_id       → per-session isolation
 */

import { z } from 'zod';
import type { IAuditReader, StoredAuditEntry, LogQuery } from './types.ts';

// ─── Namespace config ───

export interface LogNamespace {
  /** Facility filter — restricts queries to this facility. */
  readonly facility?: string;
  /** Sandbox ID filter — restricts queries to this sandbox. */
  readonly sandboxId?: string;
  /** Boot ID filter — restricts queries to this boot session. */
  readonly bootId?: string;
  /** Minimum priority level. */
  readonly minLevel?: number;
}

// ─── Namespaced reader ───

/** Create a namespaced view over an IAuditReader. */
export class NamespacedAuditReader implements IAuditReader {
  public constructor(
    private readonly reader: IAuditReader,
    private readonly ns: LogNamespace,
  ) {}

  public async query(params?: LogQuery): Promise<{ entries: StoredAuditEntry[]; nextCursor?: string; total?: number }> {
    const merged: LogQuery = {
      ...params,
      ...(this.ns.facility ? { facility: this.ns.facility } : {}),
    };

    const result = await this.reader.query(merged);

    // Client-side filter for sandbox/boot ID (if not natively supported)
    let entries = result.entries;
    if (this.ns.sandboxId) {
      entries = entries.filter(e =>
        z.custom<Record<string, unknown>>().parse(e)['_sandbox_id'] === this.ns.sandboxId ||
        e.metadata?.sandboxId === this.ns.sandboxId,
      );
    }
    if (this.ns.bootId) {
      entries = entries.filter(e =>
        z.custom<Record<string, unknown>>().parse(e)['_boot_id'] === this.ns.bootId ||
        e.metadata?.bootId === this.ns.bootId,
      );
    }
    if (this.ns.minLevel !== undefined) {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-enum-comparison -- KernLevel values are numeric
      entries = entries.filter(e => e.level >= this.ns.minLevel!);
    }

    return { entries, ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}), total: entries.length };
  }

  public async getById(id: any): Promise<StoredAuditEntry | null> {
    return this.reader.getById(id);
  }
}

// ─── Per-sandbox helper ───

export function sandboxLogReader(reader: IAuditReader, sandboxId: string): IAuditReader {
  return new NamespacedAuditReader(reader, { sandboxId });
}

export function facilityLogReader(reader: IAuditReader, facility: string): IAuditReader {
  return new NamespacedAuditReader(reader, { facility });
}

// ─── Query builders ───

export function buildSandboxQuery(_sandboxId: string, base?: LogQuery): LogQuery {
  return { ...base };
}

export function buildFacilityQuery(facility: string, base?: LogQuery): LogQuery {
  return { ...base, facility };
}
