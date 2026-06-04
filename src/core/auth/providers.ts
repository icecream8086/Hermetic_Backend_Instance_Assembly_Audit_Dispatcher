import type { IAuthProvider, AuthRequest, SignResult } from './interfaces.ts';

// ─── No-auth (local Podman, stub) ───

export class NoAuthProvider implements IAuthProvider {
  readonly type = 'none';
  async sign(_req: AuthRequest): Promise<SignResult> {
    return { headers: {} };
  }
  isExpired(): boolean { return false; }
  async refresh(): Promise<void> {}
}

// ─── Bearer token (Cloudflare, OAuth2) ───

export class BearerTokenProvider implements IAuthProvider {
  readonly type = 'bearer';
  private token: string;
  private expiresAt = 0;
  private readonly _tokenUrl: string | undefined;
  private readonly _clientId: string | undefined;
  private readonly _clientSecret: string | undefined;

  constructor(token: string, opts?: { tokenUrl?: string; clientId?: string; clientSecret?: string }) {
    this.token = token;
    this._tokenUrl = opts?.tokenUrl;
    this._clientId = opts?.clientId;
    this._clientSecret = opts?.clientSecret;
  }

  async sign(req: AuthRequest): Promise<SignResult> {
    return { headers: { ...req.headers, Authorization: `Bearer ${this.token}` } };
  }

  async getToken(): Promise<{ token: string; expiresAt?: number | undefined } | null> {
    return { token: this.token, expiresAt: this.expiresAt || undefined };
  }

  isExpired(): boolean {
    return this.expiresAt > 0 && Date.now() >= this.expiresAt;
  }

  async refresh(): Promise<void> {
    if (!this._tokenUrl || !this._clientId) return;
    const resp = await fetch(this._tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: this._clientId,
        ...(this._clientSecret ? { client_secret: this._clientSecret } : {}),
      }),
    });
    if (!resp.ok) throw new Error(`Token refresh failed: ${resp.status}`);
    const data = await resp.json() as any;
    this.token = data.access_token ?? data.token ?? data.accessToken ?? '';
    this.expiresAt = data.expires_in ? Date.now() + data.expires_in * 1000 : 0;
  }
}

// ─── Shared HMAC helpers (Alibaba Cloud RPC + OSS) ───

function b64(buf: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buf)));
}

export function percentEncode(s: string): string {
  return encodeURIComponent(s)
    .replace(/!/g, '%21').replace(/'/g, '%27')
    .replace(/\(/g, '%28').replace(/\)/g, '%29').replace(/\*/g, '%2A');
}

export async function hmacSha1(key: string, data: string): Promise<string> {
  const alg = { name: 'HMAC', hash: 'SHA-1' };
  const enc = new TextEncoder();
  const k = await crypto.subtle.importKey('raw', enc.encode(key), alg, false, ['sign']);
  return b64(await crypto.subtle.sign(alg, k, enc.encode(data)));
}

/** HMAC-SHA1 → base64 (for OSS Authorization header). Key is the raw accessKeySecret. */
export async function hmacSha1Base64(key: string, data: string): Promise<string> {
  return hmacSha1(key, data);
}

// ─── AK/SK for Alibaba Cloud RPC (HMAC-SHA1, signature in query params) ───

async function signAlibabaRpc(
  params: Record<string, string>,
  _accessKeyId: string,
  accessKeySecret: string,
): Promise<Record<string, string>> {
  const sortedKeys = Object.keys(params).sort();
  const canonicalized = sortedKeys
    .map(k => `${percentEncode(k)}=${percentEncode(params[k]!)}`)
    .join('&');
  const stringToSign = `POST&${percentEncode('/')}&${percentEncode(canonicalized)}`;
  const signature = await hmacSha1(accessKeySecret + '&', stringToSign);
  return { ...params, Signature: signature };
}

export class AkSkProvider implements IAuthProvider {
  readonly type = 'aksk';

  constructor(
    readonly _accessKeyId: string,
    readonly _accessKeySecret: string,
    /** Region for endpoint resolution (e.g. 'cn-hangzhou'). */
    readonly _region?: string | undefined,
    /** Custom endpoint override. */
    readonly _endpoint?: string | undefined,
  ) {}

  isExpired(): boolean { return false; }
  async refresh(): Promise<void> {}

  /**
   * Sign an Alibaba Cloud RPC request.
   * Embeds the signature into the query string (URL override).
   * For non-Alibaba requests, returns headers as-is.
   */
  async sign(req: AuthRequest): Promise<SignResult> {
    // Parse existing query params from URL
    const urlObj = new URL(req.url);
    const existingParams: Record<string, string> = {};
    urlObj.searchParams.forEach((v, k) => { existingParams[k] = v; });

    // Build common RPC params
    const rpcParams: Record<string, string> = {
      ...existingParams,
      Format: 'JSON',
      AccessKeyId: this._accessKeyId,
      SignatureMethod: 'HMAC-SHA1',
      SignatureVersion: '1.0',
      SignatureNonce: `${Date.now()}${Math.random().toString(36).slice(2)}`,
      Timestamp: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
    };

    const signed = await signAlibabaRpc(rpcParams, this._accessKeyId, this._accessKeySecret);
    const signedUrl = `${urlObj.origin}${urlObj.pathname}?${Object.entries(signed).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')}`;

    return { headers: req.headers, url: signedUrl };
  }
}

// ─── Factory ───

export function createAuthProvider(creds: any): IAuthProvider {
  if (!creds || creds.type === 'none') return new NoAuthProvider();
  if (creds.type === 'bearer') return new BearerTokenProvider(creds.token, creds);
  if (creds.type === 'aksk') return new AkSkProvider(creds.accessKeyId, creds.accessKeySecret, creds.region, creds.endpoint);
  return new NoAuthProvider();
}
