// Cloudflare DNS provider — placeholder.
// Implements IDnsProvider via Cloudflare REST API (Bearer token auth).

import type { IDnsProvider, UpdateDnsRecordInput, DeleteDnsRecordInput } from '../../core/provider/interfaces.ts';

export class CloudflareDnsProvider implements IDnsProvider {
  // @ts-expect-error — field stored for API calls (not yet wired)
  #apiToken: string;

  constructor(apiToken: string) {
    this.#apiToken = apiToken;
  }

  async updateRecord(_input: UpdateDnsRecordInput): Promise<void> {
    throw new Error('CloudflareDnsProvider.updateRecord not implemented');
  }

  async deleteRecord(_input: DeleteDnsRecordInput): Promise<void> {
    throw new Error('CloudflareDnsProvider.deleteRecord not implemented');
  }
}
