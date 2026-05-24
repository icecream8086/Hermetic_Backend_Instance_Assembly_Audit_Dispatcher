import type { IAuthProvider, AuthRequest } from './interfaces.ts';

// ─── No-auth (local Podman, stub) ───

export class NoAuthProvider implements IAuthProvider {
  readonly type = 'none';
  sign(req: AuthRequest): Promise<Record<string, string>> {
    return Promise.resolve(req.headers);
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

  async sign(req: AuthRequest): Promise<Record<string, string>> {
    return { ...req.headers, Authorization: `Bearer ${this.token}` };
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

// ─── AK/SK HMAC-SHA1 signing (Alibaba Cloud) ───

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

export class AkSkProvider implements IAuthProvider {
  readonly type = 'aksk';

  constructor(readonly _accessKeyId: string, readonly _accessKeySecret: string) {}

  isExpired(): boolean { return false; }
  async refresh(): Promise<void> {}

  async sign(req: AuthRequest): Promise<Record<string, string>> {
    return req.headers;
  }
}

// ─── Factory ───

export function createAuthProvider(creds: any): IAuthProvider {
  if (!creds || creds.type === 'none') return new NoAuthProvider();
  if (creds.type === 'bearer') return new BearerTokenProvider(creds.token, creds);
  if (creds.type === 'aksk') return new AkSkProvider(creds.accessKeyId, creds.accessKeySecret);
  return new NoAuthProvider();
}
