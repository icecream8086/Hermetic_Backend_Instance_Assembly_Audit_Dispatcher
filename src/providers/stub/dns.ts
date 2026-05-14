import type {
  IDnsProvider,
  UpdateDnsRecordInput,
  DeleteDnsRecordInput,
} from '../../core/provider/interfaces.ts';

export class StubDnsProvider implements IDnsProvider {
  #records = new Map<string, { ip: string }>();

  async updateRecord(input: UpdateDnsRecordInput): Promise<void> {
    this.#records.set(input.domain, { ip: input.value });
  }

  async deleteRecord(_input: DeleteDnsRecordInput): Promise<void> {
    // noop
  }
}
