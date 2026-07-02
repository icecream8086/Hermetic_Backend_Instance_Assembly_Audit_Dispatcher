import { z } from 'zod';

const dnsRecordIdSchema = z.string().min(1).brand('DnsRecordId');
export type DnsRecordId = z.infer<typeof dnsRecordIdSchema>;

export function createDnsRecordId(raw: string): DnsRecordId { return dnsRecordIdSchema.parse(raw); }

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
