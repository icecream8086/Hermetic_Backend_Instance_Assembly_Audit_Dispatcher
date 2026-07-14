import { z } from "zod";

const userIdSchema = z.string().regex(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i).brand('UserId');
const sessionTokenSchema = z.string().min(1).brand('SessionToken');
const uidSchema = z.number().int().nonnegative().brand('Uid');
const gidSchema = z.number().int().nonnegative().brand('Gid');

export type UserId = z.infer<typeof userIdSchema>;
export type SessionToken = z.infer<typeof sessionTokenSchema>;
export type Uid = z.infer<typeof uidSchema>;
export type Gid = z.infer<typeof gidSchema>;

export function createUserId(raw: string): UserId { return userIdSchema.parse(raw); }
export function createSessionToken(raw: string): SessionToken { return sessionTokenSchema.parse(raw); }
export function generateUserId(): UserId { return userIdSchema.parse(crypto.randomUUID()); }
export function generateSessionToken(): SessionToken { return sessionTokenSchema.parse(`sess_${crypto.randomUUID()}`); }
export function createUid(n: number): Uid { try { return uidSchema.parse(n); } catch { throw new Error('Invalid UID'); } }
export function createGid(n: number): Gid { try { return gidSchema.parse(n); } catch { throw new Error('Invalid GID'); } }

export const UID_MIN = 1000;
export const GID_MIN = 1000;
export const DEFAULT_SHELL = '/bin/bash';
export const DEFAULT_HOME_PREFIX = '/home/';

export enum UserRole { Root = 'root', Operator = 'Operator', Viewer = 'Viewer', Wheel = 'wheel' }

export interface LoginTimeRange { start: string; end: string; }
export interface LoginPolicy { enabled: boolean; timeRanges: LoginTimeRange[]; allowedCIDRs: string[]; passwordLoginDisabled?: boolean | undefined; }
export interface LoginContext { ip: string | undefined; siteContext: string | undefined; }
export interface LoginInfo { exists: boolean; methods: ('password' | 'no-password')[]; policy?: { enabled: boolean; disabled: boolean; timeRestricted: boolean; timeRanges: LoginTimeRange[]; }; }

export interface User {
  id: UserId; email: string; passwordHash: string; name: string; role: UserRole;
  loginPolicy?: LoginPolicy; publicKeyEd25519?: string;
  uid: Uid; gid: Gid; gecos: string; directory: string; shell: string;
  supplementaryGids: Gid[]; createdAt: number; updatedAt: number;
}
export interface Session { token: SessionToken; userId: UserId; createdAt: number; expiresAt: number; }
export interface RegisterInput { email: string; password: string; name: string; role: UserRole; }
export interface LoginInput { email: string; password: string; }
export interface UpdateUserInput { name: string | undefined; password: string | undefined; role: UserRole | undefined; loginPolicy: LoginPolicy | undefined; publicKeyEd25519: string | undefined; gecos: string | undefined; directory: string | undefined; shell: string | undefined; supplementaryGids: number[] | undefined; }
export interface NoPasswordLoginInput { email: string; oneTimeKey: string; }
