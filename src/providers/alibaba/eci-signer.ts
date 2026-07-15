/**
 * Alibaba Cloud RPC API caller — uses AkSkProvider from the auth layer.
 *
 * Reference: https://help.aliyun.com/document_detail/110992.html
 *
 * This is a thin wrapper that adapts AkSkProvider (which generates a signed URL)
 * to the ECI-specific call pattern (POST with error parsing).
 */

import { z } from 'zod';
import { AkSkProvider } from '../../core/auth/providers.ts';

export type RpcParams = Readonly<Record<string, string | undefined>>;

/**
 * Call an Alibaba Cloud RPC API and return the parsed JSON response.
 */
export async function rpcCall(
  endpoint: string,
  accessKeyId: string,
  accessKeySecret: string,
  action: string,
  params: RpcParams,
): Promise<Record<string, unknown>> {
  const aksk = AkSkProvider.getOrCreate(accessKeyId, accessKeySecret);

  // Build query params for the specific action
  const queryEntries = Object.entries({
    Action: action,
    Version: '2018-08-08',
    ...params,
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- params values may be undefined
  }).filter(([_, v]) => v !== undefined);

  // Alibaba RPC expects commas in VSwitchId/InstanceType to be literal (not %2C)
  const encodeVal = (v: string): string => encodeURIComponent(v).replace(/%2C/g, ',');
  const queryString = queryEntries.map(([k, v]) => `${encodeURIComponent(k)}=${encodeVal(v)}`).join('&');
  const baseUrl = `https://${endpoint}/?${queryString}`;

  const { url: signedUrl } = await aksk.sign({ method: 'POST', url: baseUrl, headers: {} });
  if (!signedUrl) throw new Error('AkSkProvider did not produce a signed URL');

  const resp = await fetch(signedUrl, { method: 'POST' });
  if (!resp.ok) {
    let text = '<unreadable>';
    try { text = await resp.text(); } catch {
      console.debug("ignore");
    }
    throw new Error(`Alibaba ECI ${action} HTTP ${String(resp.status)}: ${text.slice(0, 500)}`);
  }

  let body: Record<string, unknown>;
  try {
    body = await resp.json();
  } catch {
    let text = '<unreadable>';
    try { text = await resp.text(); } catch {
      console.debug("ignore");
    }
    throw new Error(`Alibaba ECI ${action} returned non-JSON response: ${text.slice(0, 500)}`);
  }

  if (body.Code) {
    const requestId = z.string().optional().parse(body.RequestId) ?? 'unknown';
    const rawCode = z.unknown().parse(body.Code);
    const code = stringifyIfNeeded(rawCode);
    const msg = z.string().optional().parse(body.Message) ?? '(no message)';
    throw new Error(`Alibaba ECI ${action} failed [${requestId}]: ${code} — ${msg}`);
  }
  return body;
}

function stringifyIfNeeded(v: unknown): string {
  let result: string;
  try { result = z.string().parse(v); }
  catch (_e) { result = JSON.stringify(v); }
  return result;
}
