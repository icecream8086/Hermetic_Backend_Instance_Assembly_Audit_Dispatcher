// ─── DNS service ───
// Manages DNS record lifecycle: persist to atomic store, sync with cloud provider.
// Independent from sandbox — works with any resource that needs DNS.

import type { IAtomicStore } from '../../core/store/interfaces.ts';
import type { ILogWriter } from '../../core/logger/interfaces.ts';
import type { IDnsProvider } from '../../core/provider/interfaces.ts';
import type { IDnsService } from './interfaces.ts';
import type { DnsRecordId, DnsRecord, DnsSyncInput } from './types.ts';
import { DnsRecordStatus } from './types.ts';
import { LogLevel } from '../../core/types.ts';
import { createFacility } from '../../core/brand.ts';
import { AppError } from '../../core/types.ts';

const FACILITY = createFacility('dns-service');
const KEY_PREFIX = 'dns:';

export class DnsService implements IDnsService {
  constructor(
    private readonly atomic: IAtomicStore,
    private readonly logger: ILogWriter,
    private readonly dnsProvider: IDnsProvider,
  ) {}

  async syncRecord(input: DnsSyncInput): Promise<DnsRecord> {
    const { domain, type, value, ttl, proxied, zoneId, id } = input;

    await this.dnsProvider.updateRecord({
      domain,
      type: type as 'A' | 'CNAME',
      value,
      ttl,
      proxied,
      providerRecordId: String(id),
      zoneId,
    });

    const now = Date.now();
    const existingEntry = await this.atomic.get<DnsRecord>(`${KEY_PREFIX}${id}`);
    const record: DnsRecord = {
      id,
      name: domain,
      domain,
      type,
      value,
      ttl,
      proxied,
      status: DnsRecordStatus.Active,
      tags: [],
      createdAt: existingEntry?.value.createdAt ?? now,
      updatedAt: now,
    };

    await this.atomic.set(`${KEY_PREFIX}${id}`, record, existingEntry?.version ?? null);

    await this.logger.logAsync({
      facility: FACILITY,
      level: LogLevel.INFO,
      message: `DNS record ${type} ${domain} → ${value}`,
      metadata: { dnsRecordId: id as string, domain, type, value },
    });

    return record;
  }

  async deleteRecord(id: DnsRecordId): Promise<void> {
    const entry = await this.atomic.get<DnsRecord>(`${KEY_PREFIX}${id}`);
    if (!entry) return;

    await this.dnsProvider.deleteRecord({
      zoneId: 'stub-zone',
      providerRecordId: String(id),
    });

    await this.atomic.set(`${KEY_PREFIX}${id}`, { ...entry.value, status: DnsRecordStatus.Stale }, entry.version);

    await this.logger.logAsync({
      facility: FACILITY,
      level: LogLevel.INFO,
      message: `DNS record deleted ${entry.value.domain}`,
      metadata: { dnsRecordId: id as string, domain: entry.value.domain },
    });
  }

  async getRecord(id: DnsRecordId): Promise<DnsRecord | null> {
    const entry = await this.atomic.get<DnsRecord>(`${KEY_PREFIX}${id}`);
    return entry?.value ?? null;
  }

  async listRecords(refId?: string): Promise<readonly DnsRecord[]> {
    // Atomic store doesn't support prefix scan, so this is a best-effort.
    // In production, this would use IQueryStore (D1).
    if (!refId) return [];
    throw new AppError(501, 'NOT_IMPLEMENTED', 'DnsService.listRecords requires a query store backend');
  }
}
