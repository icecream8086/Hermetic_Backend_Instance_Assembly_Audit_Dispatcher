import type { Hono } from 'hono';
import type { Stores } from './store/interfaces.ts';
import type { IProviderRegistry } from './provider/interfaces.ts';
import type { EventBus } from './event-bus/bus.ts';
import type { EventLoop } from './event-bus/loop.ts';
import type { IAuditWriter } from './audit/types.ts';
import type { IMessageQueue } from '../queue/interfaces.ts';

/**
 * Dependency injection root types.
 *
 * Extracted from app.ts to break the circular dependency:
 *   app.ts → generated.ts → feature/index.ts → handler.ts → FeatureDeps (from app.ts)
 *
 * All feature handlers and middleware import from here instead of app.ts.
 */

/** Request-scoped context injected into every Hono route handler.
 *  currentUser is augmented by auth middleware (core/middleware/auth.ts). */
export interface AppContext {
  stores: Stores;
  providers: IProviderRegistry;
  eventBus: EventBus;
  eventLoop: EventLoop;
  audit: IAuditWriter;
  queueProducer: IMessageQueue;
  requestId?: string;
  permissionChecker?: FeatureDeps['permissionChecker'];
}

/** Shared dependencies injected into every feature's createRouter(). */
export interface FeatureDeps {
  stores: Stores;
  providers: IProviderRegistry;
  eventBus: EventBus;
  eventLoop: EventLoop;
  audit: IAuditWriter;
  /** Queue producer for async task dispatch (image pull, sandbox GC). */
  queueProducer: IMessageQueue;
  /** Optional action+resource level permission checker (PermissionService.check compatible). */
  permissionChecker?: { check(params: { userId: string; action: string; resource: string; ip?: string; resourceOwnerId?: string }): Promise<{ allowed: boolean; reason: string }> };
  /** AES-256-GCM envelope encryption for credential secrets at rest. */
  secretEncryption?: import('./auth/secret-encryption.ts').SecretEncryption;
}

/** Assembled application instance returned by createApp(). */
export interface AppInstance {
  app: Hono<{ Variables: AppContext }>;
  stores: Stores;
  providers: IProviderRegistry;
  eventBus: EventBus;
  eventLoop: EventLoop;
  audit: IAuditWriter;
  dispose: () => Promise<void>;
  /** Run background seeding (policy lib, default instance, templates). Use with ctx.waitUntil() in Worker mode. */
  seed: () => Promise<void>;
}
