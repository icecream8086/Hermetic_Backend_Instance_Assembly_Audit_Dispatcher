// ─── User brand types ───

declare const USER_ID_BRAND: unique symbol;
declare const SESSION_TOKEN_BRAND: unique symbol;

export type UserId = string & { readonly [USER_ID_BRAND]: true };
export type SessionToken = string & { readonly [SESSION_TOKEN_BRAND]: true };

export function createUserId(raw: string): UserId {
  if (!raw) throw new TypeError('UserId must not be empty');
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
  return crypto.randomUUID() as SessionToken;
}

// ─── Enums ───

export enum UserRole {
  Admin = 'Admin',
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
  createdAt: number;
  updatedAt: number;
}

// ─── Session entity ───

export interface Session {
  token: SessionToken;
  userId: UserId;
  createdAt: number;
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
}
