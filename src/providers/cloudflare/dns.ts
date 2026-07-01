// Cloudflare DNS provider via REST API (Bearer token auth).
//
// Reference: catch/script0/alibaba_l4d2_runtime_test.py
//   PUT https://api.cloudflare.com/client/v4/zones/{zone_id}/dns_records/{record_id}

import type { IDnsProvider, UpdateDnsRecordInput, DeleteDnsRecordInput } from '../../core/provider/interfaces.ts';
import { BearerTokenProvider } from '../../core/auth/providers.ts';

const { parse: parseJson } = JSON;

interface CfError {
  readonly code: number;
  readonly message: string;
}

interface CfApiResponse {
  readonly success: boolean;
  readonly errors: readonly CfError[];
  readonly result?: unknown;
}

export const CF_API_BASE_URL = 'https://api.cloudflare.com/client/v4';

export class CloudflareDnsProvider implements IDnsProvider {
  readonly #auth: BearerTokenProvider;

  public constructor(apiToken: string) {
    this.#auth = new BearerTokenProvider(apiToken);
  }

  public async updateRecord(input: UpdateDnsRecordInput): Promise<void> {
    const res = await this.#fetch('PUT',
      `${CF_API_BASE_URL}/zones/${input.zoneId}/dns_records/${input.providerRecordId}`,
      input,
    );

    if (res.status === 404) {
      // Record doesn't exist yet — create it
      await this.#createRecord(input);
      return;
    }

    const data = await parseCfResponse(res);
    if (!data.success) {
      throw new Error(`Cloudflare DNS update failed: ${formatErrors(data.errors)}`);
    }
  }

  public async deleteRecord(input: DeleteDnsRecordInput): Promise<void> {
    const res = await this.#fetch('DELETE',
      `${CF_API_BASE_URL}/zones/${input.zoneId}/dns_records/${input.providerRecordId}`,
    );

    if (res.status === 404) return; // already deleted

    const data = await parseCfResponse(res);
    if (!data.success) {
      throw new Error(`Cloudflare DNS delete failed: ${formatErrors(data.errors)}`);
    }
  }

  async #createRecord(input: UpdateDnsRecordInput): Promise<void> {
    const res = await this.#fetch('POST',
      `${CF_API_BASE_URL}/zones/${input.zoneId}/dns_records`,
      input,
    );

    const data = await parseCfResponse(res);
    if (!data.success) {
      throw new Error(`Cloudflare DNS create failed: ${formatErrors(data.errors)}`);
    }
  }

  async #fetch(method: string, url: string, bodyInput?: UpdateDnsRecordInput): Promise<Response> {
    const headers = await this.#headers();
    const init: RequestInit = { method, headers };
    if (bodyInput) {
      init.body = JSON.stringify({
        type: bodyInput.type,
        name: bodyInput.domain,
        content: bodyInput.value,
        ttl: bodyInput.ttl,
        proxied: bodyInput.proxied,
      });
    }
    return fetch(url, init);
  }

  async #headers(): Promise<Record<string, string>> {
    const base = { 'Content-Type': 'application/json' };
    const { headers } = await this.#auth.sign({ method: 'GET', url: '', headers: base });
    return headers;
  }
}

async function parseCfResponse(res: Response): Promise<CfApiResponse> {
  const text = await res.text();
  try {    return parseJson(text) as CfApiResponse;
  } catch (e) {
    const cfError = { success: false, errors: [{ code: res.status, message: text.slice(0, 200) }] };
    return cfError;
  }
}

function formatErrors(errors: readonly CfError[]): string {
  if (errors.length === 0) return 'unknown error';
  return errors.map(e => `[${String(e.code)}] ${e.message}`).join('; ');
}
