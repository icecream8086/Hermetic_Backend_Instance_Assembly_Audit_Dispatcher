/**
 * Log fetch event handler — async container logs via EventBus.
 *
 * ECI DescribeContainerLog is a synchronous snapshot API (no streaming).
 * Instead of blocking the HTTP response or simulating a stream, this handler:
 * 1. Listens for `log:fetch` events on the EventBus
 * 2. Calls the provider's getLogs() asynchronously
 * 3. Caches the result in the atomic store under `log:cache:{sandboxId}:{containerName}`
 *
 * Frontend flow:
 *   POST /api/sandboxes/:id/logs → dispatches log:fetch → returns cached (possibly stale) immediately
 *   GET  /api/sandboxes/:id/logs → returns latest cached content
 *
 * This gives eventual consistency with no WebSocket/DO dependency.
 */

import type { EventBus } from '../event-bus/bus.ts';
import type { IAtomicStore } from '../store/interfaces.ts';
import type { IProviderRegistry } from '../provider/interfaces.ts';
import { createRegionId } from '../region/types.ts';
import { createInstanceId } from '../region/instance.ts';
import { z } from 'zod';

export interface LogFetchDeps {
  atomic: IAtomicStore;
  providers: IProviderRegistry;
  eventBus: EventBus;
}

export interface LogFetchPayload {
  readonly sandboxId: string;
  readonly providerId: string;
  readonly region: string;
  readonly containerName: string;
  readonly instanceId?: string;
  readonly tail?: number;
  readonly sinceSeconds?: number;
}

const LOG_CACHE_PREFIX = 'log:cache:';

function cacheKey(sandboxId: string, containerName: string): string {
  return `${LOG_CACHE_PREFIX}${sandboxId}:${containerName}`;
}

export function registerLogFetchHandler(deps: LogFetchDeps): void {
  const { atomic, providers, eventBus } = deps;

  eventBus.on('log:fetch', async (event: { type: string; payload?: unknown }) => {
    const payloadSchema = z.object({
      sandboxId: z.string(),
      providerId: z.string(),
      region: z.string(),
      containerName: z.string(),
      instanceId: z.string().optional(),
      tail: z.number().optional(),
      sinceSeconds: z.number().optional(),
    }).passthrough().optional();
    const payload = payloadSchema.parse(event.payload);
    if (!payload || !payload.sandboxId || !payload.containerName) return;
    const { sandboxId, providerId, region, containerName, tail, sinceSeconds } = payload;

    try {
      // Check cache marker so concurrent refreshes don't pile up
      const markerKey = `log:fetching:${sandboxId}:${containerName}`;
      const marker = await atomic.get<{ startedAt: number }>(markerKey);
      if (marker && Date.now() - marker.value.startedAt < 10_000) return; // dedup within 10s

      await atomic.set(markerKey, { startedAt: Date.now() }, marker?.version ?? null);

      // Fetch logs from provider — resolve per-instance for correct credential binding
      const resolved = payload.instanceId
        ? await providers.resolveContainer(createInstanceId(payload.instanceId))
        : undefined;
      if (!resolved) return;
      const containerProvider = resolved;

      const result = await containerProvider.getLogs({
        region: createRegionId(region),
        providerId,
        containerName,
        ...(tail !== undefined ? { limitBytes: tail } : {}),
        ...(sinceSeconds !== undefined ? { sinceSeconds } : {}),
      });

      // Cache the result with metadata
      const existing = await atomic.get<any>(cacheKey(sandboxId, containerName));
      await atomic.set(cacheKey(sandboxId, containerName), {
        content: result.content,
        containerName: result.containerName,
        timestamp: result.timestamp,
        fetchedAt: Date.now(),
      }, existing?.version ?? null);

      // Clear marker
      const m2 = await atomic.get(markerKey);
      try { if (m2) await atomic.set<Record<string, unknown> | null>(markerKey, null, m2.version); } catch {
        console.debug("noop");
      }
    } catch (e: any) {
      console.error(`[log:fetch] ${sandboxId}/${containerName} failed:`, e.message);
    }
  });
}

export async function getCachedLogs(
  atomic: IAtomicStore,
  sandboxId: string,
  containerName: string,
): Promise<{ content: string; containerName?: string; timestamp?: string; fetchedAt?: number } | null> {
  const entry = await atomic.get<any>(cacheKey(sandboxId, containerName));
  return entry?.value ?? null;
}
