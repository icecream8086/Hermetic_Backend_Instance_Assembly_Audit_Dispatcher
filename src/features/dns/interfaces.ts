// ─── DNS service interfaces ───
// Manages DNS records independently from any specific resource type.

import type { DnsRecordId, DnsRecord, DnsSyncInput } from './types.ts';

export interface IDnsService {
  /** Create or update a DNS record and sync it with the provider. */
  syncRecord(input: DnsSyncInput, actorId?: string): Promise<DnsRecord>;

  /** Delete a DNS record and remove it from the provider. */
  deleteRecord(id: DnsRecordId, actorId?: string): Promise<void>;

  /** Get a single DNS record by ID. */
  getRecord(id: DnsRecordId): Promise<DnsRecord | null>;

  /** List DNS records, optionally filtered by resource reference. */
  listRecords(refId?: string): Promise<readonly DnsRecord[]>;
}
