import { Hono } from 'hono';
import type { FeatureDeps } from '../../core/app.ts';
import { ConsoleLogger } from '../../core/logger/console-logger.ts';
import { UserService } from './service.ts';
import { createUserRouter } from './handler.ts';

export type { IUserService } from './service.ts';
export type { User, UserId, SessionToken, RegisterInput, LoginInput, UpdateUserInput } from './types.ts';
export { UserRole, generateUserId } from './types.ts';
export { RegisterUserSchema, LoginUserSchema, UpdateUserSchema, UserResponseSchema } from './schema.ts';

export function createRouter(deps: FeatureDeps): Hono<any> {
  const service = new UserService(deps.stores.atomic, new ConsoleLogger());
  return createUserRouter(service);
}

export { UserService };
