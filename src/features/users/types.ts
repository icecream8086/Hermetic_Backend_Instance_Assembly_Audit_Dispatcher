// ─── User brand types ───

declare const USER_ID_BRAND: unique symbol;
declare const SESSION_TOKEN_BRAND: unique symbol;

export type UserId = string & { readonly [USER_ID_BRAND]: true };
export type SessionToken = string & { readonly [SESSION_TOKEN_BRAND]: true };

const UUID_V4_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

export function createUserId(raw: string): UserId {
  if (!UUID_V4_PATTERN.test(raw)) throw new TypeError(`Invalid UserId format, expected UUID v4: ${raw}`);
  return raw as UserId;
}

export function createSessionToken(raw: string): SessionToken {
  if (!raw) throw new TypeError('SessionToken must not be empty');
  return raw as SessionToken;
}

export function generateUserId(): UserId {
  return crypto.randomUUID() as UserId;
}

export function generateSessionToken(): SessionToken {
  return `sess_${crypto.randomUUID()}` as SessionToken;
}

// ─── Enums ───

export enum UserRole {
  Root = 'root',
  Operator = 'Operator',
  Viewer = 'Viewer',
}

// ─── Entity ───

export interface User {
  id: UserId;
  email: string;
  passwordHash: string;
  name: string;
  role: UserRole;
  loginPolicy?: LoginPolicy;
  publicKeyEd25519?: string;
  privateKeyEd25519?: string;
  createdAt: number;
  updatedAt: number;
}

// ─── Session entity ───

export interface Session {
  token: SessionToken;
  userId: UserId;
  createdAt: number;
}

// ─── Login policy ───

export interface LoginTimeRange {
  /** Start time in "HH:mm" UTC */
  start: string;
  /** End time in "HH:mm" UTC */
  end: string;
}

export interface LoginPolicy {
  /** false = completely block login for this account */
  enabled: boolean;
  /** Time windows when login is allowed (UTC), empty = no restriction */
  timeRanges: LoginTimeRange[];
  /** CIDR whitelist, empty = no restriction */
  allowedCIDRs: string[];
  /** true = disable password login, require key-based (no-password) auth */
  passwordLoginDisabled?: boolean | undefined;
}

/** Runtime context passed into login() for policy evaluation. */
export interface LoginContext {
  /** Client IP address from X-Forwarded-For or cf-connecting-ip */
  ip: string | undefined;
  /** Site context string for no-password login signature binding */
  siteContext: string | undefined;
}

export interface LoginInfo {
  exists: boolean;
  methods: ('password' | 'no-password')[];
  policy?: {
    enabled: boolean;
    disabled: boolean;
    timeRestricted: boolean;
    timeRanges: LoginTimeRange[];
  };
}

// ─── DTOs (domain-facing, after validation + binding) ───

export interface RegisterInput {
  email: string;
  password: string;   // raw password, hashed before storage
  name: string;
  role: UserRole;
}

export interface LoginInput {
  email: string;
  password: string;
}

export interface UpdateUserInput {
  name: string | undefined;
  password: string | undefined;
  role: UserRole | undefined;
  loginPolicy: LoginPolicy | undefined;
  publicKeyEd25519: string | undefined;
  privateKeyEd25519: string | undefined;
}

export interface NoPasswordLoginInput {
  email: string;
  oneTimeKey: string;
}
