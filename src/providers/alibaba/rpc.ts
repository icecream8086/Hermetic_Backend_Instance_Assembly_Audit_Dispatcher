/**
 * Generalized Alibaba Cloud RPC API caller.
 *
 * Alibaba Cloud services use a common RPC-style calling convention:
 * - Common parameters (Action, Version, AccessKeyId, Timestamp, SignatureMethod, etc.)
 * - Business parameters appended as query string key-value pairs
 * - HMAC-SHA1 signed via AkSkProvider
 *
 * Reference: https://help.aliyun.com/document_detail/110992.html
 */

import { AkSkProvider } from '../../core/auth/providers.ts';

export type RpcParams = Readonly<Record<string, string | undefined>>;

/**
 * Call an Alibaba Cloud RPC API and return the parsed JSON response.
 *
 * @param endpoint  - The service endpoint (e.g. "eci.cn-hangzhou.aliyuncs.com")
 * @param accessKeyId - Alibaba Cloud AccessKey ID
 * @param accessKeySecret - Alibaba Cloud AccessKey Secret
 * @param action    - API action name (e.g. "DescribeContainerGroups")
 * @param version   - API version (e.g. "2018-08-08", "2018-12-01")
 * @param params    - Business parameters
 * @returns Parsed JSON response body
 */
export async function rpcCall(
  endpoint: string,
  accessKeyId: string,
  accessKeySecret: string,
  action: string,
  version: string,
  params: RpcParams,
): Promise<Record<string, unknown>> {
  const aksk = AkSkProvider.getOrCreate(accessKeyId, accessKeySecret);

  const queryEntries = Object.entries({
    Action: action,
    Version: version,
    ...params,
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- params values may be undefined
  }).filter(([_, v]) => v !== undefined);

  const queryString = queryEntries.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
  const baseUrl = `https://${endpoint}/?${queryString}`;

  const { url: signedUrl } = await aksk.sign({ method: 'POST', url: baseUrl, headers: {} });
  if (!signedUrl) throw new Error('AkSkProvider did not produce a signed URL');

  const resp = await fetch(signedUrl, { method: 'POST' });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '<unreadable>');
    throw new Error(`Alibaba ${action} HTTP ${String(resp.status)}: ${text.slice(0, 500)}`);
  }

  let body: Record<string, unknown>;
  try {
    body = await resp.json();
  } catch {
    const text = await resp.text().catch(() => '<unreadable>');
    throw new Error(`Alibaba ${action} returned non-JSON response: ${text.slice(0, 500)}`);
  }

  if (body.Code) {
    const requestId = typeof body.RequestId === 'string' ? body.RequestId : 'unknown';
    const code = typeof body.Code === 'string' ? body.Code : JSON.stringify(body.Code);
    const msg = typeof body.Message === 'string' ? body.Message : '(no message)';
    throw new Error(`Alibaba ${action} failed [${requestId}]: ${code} — ${msg}`);
  }
  return body;
}
