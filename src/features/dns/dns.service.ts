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
import type { IAuditWriter } from '../../core/audit/types.ts';
import { KernLevel } from '../../core/audit/kern-level.ts';

const FACILITY = createFacility('dns-service');
const KEY_PREFIX = 'dns:';

export class DnsService implements IDnsService {
  constructor(
    private readonly atomic: IAtomicStore,
    private readonly logger: ILogWriter,
    private readonly dnsProvider: IDnsProvider,
    private readonly audit?: IAuditWriter,
  ) {}

  async syncRecord(input: DnsSyncInput, actorId?: string): Promise<DnsRecord> {
    const { domain, type, value, ttl, proxied, zoneId, id } = input;

    if (type !== 'A' && type !== 'CNAME') {
      throw new AppError(400, 'UNSUPPORTED_DNS_TYPE', `DNS type ${type} is not supported by the provider`);
    }

    await this.dnsProvider.updateRecord({
      domain,
      type,
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
      zoneId,
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
      actorId,
      metadata: { dnsRecordId: id as string, domain, type, value },
    });

    this.audit?.write({
      level: KernLevel.INFO,
      facility: FACILITY,
      message: `DNS record synced — ${type} ${domain} → ${value}`,
      actorId,
      metadata: { eventType: 'dns.synced', dnsRecordId: id as string, domain, type, value },
    });

    return record;
  }

  async deleteRecord(id: DnsRecordId, actorId?: string): Promise<void> {
    const entry = await this.atomic.get<DnsRecord>(`${KEY_PREFIX}${id}`);
    if (!entry) return;

    await this.dnsProvider.deleteRecord({
      zoneId: entry.value.zoneId,
      providerRecordId: String(id),
    });

    await this.atomic.set(`${KEY_PREFIX}${id}`, { ...entry.value, status: DnsRecordStatus.Stale }, entry.version);

    await this.logger.logAsync({
      facility: FACILITY,
      level: LogLevel.INFO,
      message: `DNS record deleted ${entry.value.domain}`,
      actorId,
      metadata: { dnsRecordId: id as string, domain: entry.value.domain },
    });

    this.audit?.write({
      level: KernLevel.INFO,
      facility: FACILITY,
      message: `DNS record deleted — ${entry.value.domain}`,
      actorId,
      metadata: { eventType: 'dns.deleted', dnsRecordId: id as string, domain: entry.value.domain },
    });
  }

  async getRecord(id: DnsRecordId): Promise<DnsRecord | null> {
    const entry = await this.atomic.get<DnsRecord>(`${KEY_PREFIX}${id}`);
    return entry?.value ?? null;
  }

  async listRecords(_refId?: string): Promise<readonly DnsRecord[]> {
    // Atomic store (KV + DO) doesn't support prefix scans or relational queries.
    // A query-capable backend (e.g. D1) is needed to implement this efficiently.
    // See wrangler.toml — D1 is reserved for future use.
    return [];
  }
}
