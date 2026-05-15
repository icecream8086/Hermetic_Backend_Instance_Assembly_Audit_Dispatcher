// ─── DNS domain types ───
// Independent from sandbox — no sandbox types imported here.

declare const DNS_RECORD_ID_BRAND: unique symbol;
export type DnsRecordId = string & { readonly [DNS_RECORD_ID_BRAND]: true };

export function createDnsRecordId(raw: string): DnsRecordId {
  if (!raw) throw new TypeError('DnsRecordId must not be empty');
  return raw as DnsRecordId;
}

export enum DnsRecordStatus {
  Active = 'Active',
  Stale = 'Stale',
}

export enum DnsRecordType {
  A = 'A',
  CNAME = 'CNAME',
  TXT = 'TXT',
  MX = 'MX',
}

export interface DnsRecord {
  readonly id: DnsRecordId;
  readonly name: string;
  readonly domain: string;
  readonly type: DnsRecordType;
  readonly value: string;
  readonly ttl: number;
  readonly proxied: boolean;
  readonly zoneId: string;
  readonly status: DnsRecordStatus;
  readonly tags: readonly { key: string; value: string }[];
  readonly createdAt: number;
  readonly updatedAt: number;
  /** Opaque reference to the resource this DNS points to (e.g. sandbox ID, load balancer ID). */
  readonly refId?: string;
  readonly description?: string;
}

export interface DnsSyncInput {
  readonly id: DnsRecordId;
  readonly domain: string;
  readonly type: DnsRecordType;
  readonly value: string;
  readonly ttl: number;
  readonly proxied: boolean;
  readonly zoneId: string;
}
