import type { EventBus } from '../event-bus/bus.ts';
import type { EventLoop } from '../event-bus/loop.ts';
import type { SecurityResourceService } from '../security/service.ts';
import type { IS3Provider } from '../provider/s3.ts';

export interface SecurityRefreshDeps {
  securityService: SecurityResourceService;
  s3Resolver: (bucketId: string) => Promise<IS3Provider>;
  eventBus: EventBus;
  eventLoop: EventLoop;
}

/**
 * Periodic SecurityResource presigned URL refresh.
 *
 * Scans all active resources and re-issues tokens approaching expiry
 * via the S3 provider's presigned URL API.
 */
export function registerSecurityRefresh(deps: SecurityRefreshDeps): void {
  const { securityService, eventBus, eventLoop, s3Resolver: _s3Resolver } = deps;

  const REFRESH_THRESHOLD_SEC = 10 * 60; // 10 min — refresh tokens in this window

  eventBus.on('security:refresh', async () => {
    try {
      const resources = await securityService.list();

      for (const resource of resources) {
        try {
          // Check if token is approaching expiry based on tokenTtl
          const elapsed = (Date.now() - resource.updatedAt) / 1000;
          if (elapsed < resource.tokenTtl - REFRESH_THRESHOLD_SEC) continue;

          // Issue a fresh token to extend lifetime
          await securityService.issueToken([resource.name], resource.instanceId);
        } catch (e) {
          console.log(`[security-refresh] failed for ${resource.name}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    } finally {
      eventLoop.enqueuePriority({ type: 'security:refresh', payload: {} });
    }
  });

  // Trigger first refresh cycle
  eventLoop.enqueuePriority({ type: 'security:refresh', payload: {} });
}
