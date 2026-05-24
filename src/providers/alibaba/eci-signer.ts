/**
 * Alibaba Cloud RPC API caller — uses shared HMAC-SHA1 from auth layer.
 *
 * Reference: https://help.aliyun.com/document_detail/110992.html
 */

import { hmacSha1, percentEncode } from '../../core/auth/providers.ts';

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
  const query: Record<string, string> = {
    Format: 'JSON',
    Version: '2018-08-08',
    AccessKeyId: accessKeyId,
    SignatureMethod: 'HMAC-SHA1',
    Timestamp: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
    SignatureVersion: '1.0',
    SignatureNonce: `${Date.now()}${Math.random().toString(36).slice(2)}`,
    Action: action,
  };
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) query[k] = v;
  }

  const keys = Object.keys(query).sort();
  const canonical = keys.map(k => `${percentEncode(k)}=${percentEncode(query[k]!)}`).join('&');
  const stringToSign = `POST&${percentEncode('/')}&${percentEncode(canonical)}`;
  const signature = await hmacSha1(`${accessKeySecret}&`, stringToSign);

  const url = `https://${endpoint}/?${canonical}&Signature=${percentEncode(signature)}`;
  const resp = await fetch(url, { method: 'POST' });
  const body = await resp.json() as any;
  if (body.Code) {
    throw new Error(`Alibaba ECI ${action} failed: ${body.Code} — ${body.Message ?? ''}`);
  }
  return body;
}
