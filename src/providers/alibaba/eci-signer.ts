/**
 * Alibaba Cloud RPC API caller — uses AkSkProvider from the auth layer.
 *
 * Reference: https://help.aliyun.com/document_detail/110992.html
 *
 * This is a thin wrapper that adapts AkSkProvider (which generates a signed URL)
 * to the ECI-specific call pattern (POST with error parsing).
 */

import { AkSkProvider } from '../../core/auth/providers.ts';

export interface RpcParams {
  readonly [key: string]: string | undefined;
}

/**
 * Call an Alibaba Cloud RPC API and return the parsed JSON response.
 */
export async function rpcCall(
  endpoint: string,
  accessKeyId: string,
  accessKeySecret: string,
  action: string,
  params: RpcParams,
): Promise<any> {
  const aksk = AkSkProvider.getOrCreate(accessKeyId, accessKeySecret);

  // Build query params for the specific action
  const queryEntries = Object.entries({
    Action: action,
    Version: '2018-08-08',
    ...params,
  }).filter(([_, v]) => v !== undefined) as [string, string][];

  // Alibaba RPC expects commas in VSwitchId/InstanceType to be literal (not %2C)
  const encodeVal = (v: string) => encodeURIComponent(v).replace(/%2C/g, ',');
  const queryString = queryEntries.map(([k, v]) => `${encodeURIComponent(k)}=${encodeVal(v)}`).join('&');
  const baseUrl = `https://${endpoint}/?${queryString}`;

  const { url: signedUrl } = await aksk.sign({ method: 'POST', url: baseUrl, headers: {} });
  if (!signedUrl) throw new Error('AkSkProvider did not produce a signed URL');

  const resp = await fetch(signedUrl, { method: 'POST' });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '<unreadable>');
    throw new Error(`Alibaba ECI ${action} HTTP ${resp.status}: ${text.slice(0, 500)}`);
  }

  let body: any;
  try {
    body = await resp.json();
  } catch {
    const text = await resp.text().catch(() => '<unreadable>');
    throw new Error(`Alibaba ECI ${action} returned non-JSON response: ${text.slice(0, 500)}`);
  }

  if (body?.Code) {
    const requestId = body.RequestId ?? 'unknown';
    throw new Error(`Alibaba ECI ${action} failed [${requestId}]: ${body.Code} — ${body.Message ?? '(no message)'}`);
  }
  return body;
}
