/**
 * Cloud provider authentication abstraction.
 *
 * Supports multiple auth methods with automatic refresh.
 * - AK/SK (HMAC signing): Alibaba, AWS
 * - Bearer token: Cloudflare, OAuth2
 * - No-auth: local Podman
 */

export interface AuthRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body?: string | undefined;
}

export interface SignResult {
  readonly headers: Record<string, string>;
  /** Signed URL override — for providers that embed signature in query params (e.g. Alibaba RPC). */
  readonly url?: string | undefined;
}

export interface IAuthProvider {
  /** Name of this auth method. */
  readonly type: string;

  /** Apply authentication to a request. Returns signed headers and optionally a signed URL. */
  sign(req: AuthRequest): Promise<SignResult>;

  /** Get a Bearer token (for token-based auth). Returns null if not applicable. */
  getToken?(): Promise<{ token: string; expiresAt?: number | undefined } | null>;

  /** Check if the current credentials/token are still valid. */
  isExpired(): boolean;

  /** Refresh credentials/token. */
  refresh(): Promise<void>;
}

// ─── Auth types for config ───

export interface AkSkCredentials {
  readonly type: 'aksk';
  readonly accessKeyId: string;
  readonly accessKeySecret: string;
}

export interface BearerCredentials {
  readonly type: 'bearer';
  readonly token: string;
  readonly tokenUrl?: string;       // OAuth2 token endpoint for refresh
  readonly clientId?: string;
  readonly clientSecret?: string;
}

export interface NoAuthCredentials {
  readonly type: 'none';
}

export type ProviderCredentials = AkSkCredentials | BearerCredentials | NoAuthCredentials;

export type { IAuthProvider as IAuthProviderType };
