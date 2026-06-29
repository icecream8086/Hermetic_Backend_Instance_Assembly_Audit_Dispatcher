import type {
  IDnsProvider,
  UpdateDnsRecordInput,
  DeleteDnsRecordInput,
} from '../../core/provider/interfaces.ts';

interface StubRecord {
  readonly domain: string;
  readonly type: 'A' | 'CNAME';
  readonly value: string;
  readonly ttl: number;
  readonly proxied: boolean;
  readonly providerRecordId: string;
  readonly zoneId: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** In-memory stub for local development. State is lost on restart. */
export class StubDnsProvider implements IDnsProvider {
  #records = new Map<string, StubRecord>();

  public async updateRecord(input: UpdateDnsRecordInput): Promise<void> {
    const now = Date.now();
    const existing = this.#records.get(input.providerRecordId);

    this.#records.set(input.providerRecordId, {
      domain: input.domain,
      type: input.type,
      value: input.value,
      ttl: input.ttl,
      proxied: input.proxied,
      providerRecordId: input.providerRecordId,
      zoneId: input.zoneId,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
  }

  public async deleteRecord(input: DeleteDnsRecordInput): Promise<void> {
    this.#records.delete(input.providerRecordId);
  }

  /** Expose all tracked records for test inspection. */
  public get entries(): readonly StubRecord[] {
    return [...this.#records.values()];
  }
}
