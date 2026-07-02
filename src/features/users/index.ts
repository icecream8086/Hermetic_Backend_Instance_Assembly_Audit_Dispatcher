import type { Hono } from 'hono';
import type { FeatureDeps } from '../../core/deps.ts';
import { ConsoleLogger } from '../../core/audit/console-logger.ts';
import { UserService } from './service.ts';
import { createUserRouter } from './handler.ts';

export type { IUserService } from './service.ts';
export type { User, UserId, SessionToken, RegisterInput, LoginInput, UpdateUserInput, Uid, Gid } from './types.ts';
export { UserRole, generateUserId, createUid, createGid, UID_MIN, GID_MIN, DEFAULT_SHELL, DEFAULT_HOME_PREFIX } from './types.ts';
export { RegisterUserSchema, LoginUserSchema, UpdateUserSchema, UserResponseSchema } from './schema.ts';

export function createRouter(deps: FeatureDeps): Hono<{ Variables: AppContext }> {
  const service = new UserService(deps.stores.atomic, new ConsoleLogger(), deps.audit);
  return createUserRouter(service, deps.permissionChecker);
}

export { UserService };
