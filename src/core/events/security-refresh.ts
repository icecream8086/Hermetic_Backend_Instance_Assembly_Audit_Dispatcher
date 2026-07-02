import type { EventBus } from '../event-bus/bus.ts';
import type { EventLoop } from '../event-bus/loop.ts';
import type { SecurityResourceService } from '../security/service.ts';
import { SecurityResourceStatus } from '../security/types.ts';
import type { IS3Provider } from '../provider/s3.ts';

export interface SecurityRefreshDeps {
  securityService: SecurityResourceService;
  s3Resolver: (bucketId: string) => Promise<IS3Provider>;
  eventBus: EventBus;
  eventLoop: EventLoop;
}

/**
 * Register a periodic tick that scans Active SecurityResources and refreshes
 * those approaching their expiration threshold.
 *
 * Runs every 5 minutes. Self-scheduling via event loop priority queue.
 */
export function registerSecurityRefresh(deps: SecurityRefreshDeps): void {
  const { securityService, s3Resolver, eventBus, eventLoop } = deps;

  eventBus.on('security:refresh', async () => {
    try {
      const resources = await securityService.list(SecurityResourceStatus.Active);
      for (const r of resources) {
        const check = securityService.checkValidity(r);
        if (check.valid) continue;

        if (check.reason?.includes('expires in')) {
          // 剩余不足 refreshThreshold → 刷新
          try {
            const s3 = await s3Resolver(r.bucketId);
            await securityService.refresh(r.id, s3);
          } catch (e) {
            console.error(`[security] refresh failed for ${r.name}: ${e instanceof Error ? e.message : String(e)}`);
          }
        } else if (check.reason?.includes('expired')) {
          // 已过期 → 标记
          await securityService.markExpired(r.id);
        }
      }
    } finally {
      eventLoop.enqueuePriority({ type: 'security:refresh', payload: {} });
    }
  });

  // Trigger first refresh
  eventLoop.enqueuePriority({ type: 'security:refresh', payload: {} });
}
