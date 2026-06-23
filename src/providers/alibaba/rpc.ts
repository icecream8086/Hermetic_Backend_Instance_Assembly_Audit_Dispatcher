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

export interface RpcParams {
  readonly [key: string]: string | undefined;
}

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
): Promise<any> {
  const aksk = AkSkProvider.getOrCreate(accessKeyId, accessKeySecret);

  const queryEntries = Object.entries({
    Action: action,
    Version: version,
    ...params,
  }).filter(([_, v]) => v !== undefined) as [string, string][];

  const queryString = queryEntries.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
  const baseUrl = `https://${endpoint}/?${queryString}`;

  const { url: signedUrl } = await aksk.sign({ method: 'POST', url: baseUrl, headers: {} });
  if (!signedUrl) throw new Error('AkSkProvider did not produce a signed URL');

  const resp = await fetch(signedUrl, { method: 'POST' });
  const body = await resp.json() as any;
  if (body.Code) {
    throw new Error(`Alibaba ${action} failed: ${body.Code} — ${body.Message ?? ''}`);
  }
  return body;
}
