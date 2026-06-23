import type { EventBus } from '../event-bus/bus.ts';
import type { EventLoop } from '../event-bus/loop.ts';
import type { IAtomicStore } from '../store/interfaces.ts';
import type { IProviderRegistry } from '../provider/interfaces.ts';
import type { IAuditWriter } from '../audit/types.ts';
import type { IMessageQueue } from '../../queue/interfaces.ts';
import type { Sandbox } from '../../features/sandbox/types.ts';
import { SandboxStatus } from '../../features/sandbox/types.ts';
import { formatDmesgLine } from '../utils/dmesg.ts';

export interface HealthCheckDeps {
  stores: { atomic: IAtomicStore };
  providers: Pick<IProviderRegistry, 'container' | 'resolveContainer'>;
  eventBus: EventBus;
  eventLoop: EventLoop;
  audit: IAuditWriter;
  queueProducer: IMessageQueue;
}

/** Marker key prefix for GC dedup. Value: { expiresAt: number }. */
const GC_MARKER_PREFIX = 'gc:queued:';

/** Marker TTL — if consumer hasn't processed the GC within this window,
 *  the tick re-enqueues (self-healing).  Must be > 2× tick interval. */
const GC_MARKER_TTL_MS = 120_000;

/**
 * Register the health:check handler on the event bus.
 *
 * GC strategy (marker-gated, Queue-first):
 *   tick → check marker → if valid & unexpired → skip (already queued)
 *                       → if expired/missing → enqueue + write marker
 *                       → if Queue unavailable → inline fallback + clear marker
 *
 * The Queue consumer clears the marker on success; if the consumer never runs
 * (Miniflare dev), the marker expires after GC_MARKER_TTL_MS and the tick
 * re-enqueues → self-healing loop.  No inline provider.delete blocks the tick
 * unless Queue is entirely unavailable (e.g. `npm run dev` without wrangler).
 */
export function registerHealthCheck(deps: HealthCheckDeps): void {
  const { stores, providers, eventBus, eventLoop, audit, queueProducer } = deps;

  /** Track last stable updatedAt per sandbox to skip redundant provider.getStatus() calls. */
  const stableSince = new Map<string, number>();

  eventBus.on('health:check', async () => {
    try {
      const idx = await stores.atomic.get<string[]>('sandbox:ids');
      if (!idx) return;
      for (const sid of idx.value) {
        try {
          const entry = await stores.atomic.get<Sandbox>(`sandbox:${sid}`);
          if (!entry || entry.value.status === SandboxStatus.Deleted) continue;

          const instanceId = entry.value.config.instanceId;

          // Stopped > 60s → GC
          if (entry.value.status === SandboxStatus.Stopped) {
            const stoppedDuration = Date.now() - entry.value.updatedAt;
            if (stoppedDuration > 60_000) {
              await dispatchGc(stores.atomic, queueProducer, providers, audit, {
                sandboxId: sid, reason: 'stopped-gc',
                providerId: entry.value.providerId ?? sid,
                region: entry.value.config.region,
                ...(instanceId ? { instanceId } : {}),
                containerCount: entry.value.containers.length,
                sandboxName: entry.value.name, createdAt: entry.value.createdAt,
              });
            }
            continue;
          }
          // Failed/Terminated ≥ 60s → GC
          if (entry.value.status === SandboxStatus.Failed || entry.value.status === SandboxStatus.Terminated) {
            const duration = Date.now() - entry.value.updatedAt;
            if (duration > 60_000) {
              await dispatchGc(stores.atomic, queueProducer, providers, audit, {
                sandboxId: sid, reason: `${entry.value.status.toLowerCase()}-gc`,
                providerId: entry.value.providerId ?? sid,
                region: entry.value.config.region,
                ...(instanceId ? { instanceId } : {}),
                containerCount: entry.value.containers.length,
                sandboxName: entry.value.name, createdAt: entry.value.createdAt,
              });
            }
            continue;
          }

          if (entry.value.status !== SandboxStatus.Running) continue;

          const maxRetries = entry.value.config.healthMaxRetries ?? 3;
          if (maxRetries === -1) { stableSince.delete(sid); continue; }

          // Skip provider check if sandbox hasn't changed since last healthy check
          const lastStableAt = stableSince.get(sid);
          if (lastStableAt !== undefined && entry.value.updatedAt <= lastStableAt) continue;

          const containerProvider = instanceId
            ? await providers.resolveContainer?.(instanceId as any)
            : undefined;
          const provider = containerProvider ?? providers.container;
          if (!provider.getStatus) continue;

          const runtime = await provider.getStatus(entry.value.providerId ?? sid);
          if (!runtime) {
            stableSince.delete(sid);
            await dispatchGc(stores.atomic, queueProducer, providers, audit, {
              sandboxId: sid, reason: 'provider-gone',
              providerId: entry.value.providerId ?? sid,
              region: entry.value.config.region,
              ...(instanceId ? { instanceId } : {}),
              containerCount: entry.value.containers.length,
              sandboxName: entry.value.name, createdAt: entry.value.createdAt,
            });
            continue;
          }

          const allHealthy = runtime.containers.every(cc => cc.alive);
          const anyRunning = runtime.containers.some(cc => cc.alive);
          const failKey = `health:fails:${sid}`;

          if (!anyRunning) {
            stableSince.delete(sid);
            await dispatchGc(stores.atomic, queueProducer, providers, audit, {
              sandboxId: sid, reason: 'exited-gc',
              providerId: entry.value.providerId ?? sid,
              region: entry.value.config.region,
              ...(instanceId ? { instanceId } : {}),
              containerCount: entry.value.containers.length,
              sandboxName: entry.value.name, createdAt: entry.value.createdAt,
            });
            continue;
          }

          if (allHealthy) {
            const failEntry = await stores.atomic.get<number>(failKey);
            if (failEntry) await stores.atomic.set(failKey, 0, failEntry.version);
            // Mark as stable — skip provider check next tick if unchanged
            stableSince.set(sid, entry.value.updatedAt);
          } else {
            stableSince.delete(sid); // unhealthy — re-check next tick
            const failEntry = await stores.atomic.get<number>(failKey);
            const fails = (failEntry?.value ?? 0) + 1;
            await stores.atomic.set(failKey, fails, failEntry?.version ?? null);
            if (fails >= maxRetries) {
              stableSince.delete(sid);
              await dispatchGc(stores.atomic, queueProducer, providers, audit, {
                sandboxId: sid, reason: 'unhealthy-gc',
                providerId: entry.value.providerId ?? sid,
                region: entry.value.config.region,
                ...(instanceId ? { instanceId } : {}),
                containerCount: entry.value.containers.length,
                sandboxName: entry.value.name, createdAt: entry.value.createdAt,
              });
            }
          }
        } catch (e) { console.error(`[health] check error ${sid}:`, e instanceof Error ? e.message : e); }
      }

      // Instance heartbeat timeout — 120s no heartbeat → offline (lightweight, stays inline)
      const instIdx = await stores.atomic.get<string[]>('instance:ids');
      if (instIdx) {
        const now = Date.now();
        for (const iid of instIdx.value) {
          try {
            const instEntry = await stores.atomic.get<any>('instance:' + iid);
            if (!instEntry?.value || instEntry.value.status !== 'online') continue;
            if (instEntry.value.updatedAt && (now - instEntry.value.updatedAt > 120_000)) {
              await stores.atomic.set('instance:' + iid, { ...instEntry.value, status: 'offline', updatedAt: now }, instEntry.version);
            }
          } catch { /* skip */ }
        }
      }

      // Bucket key rotation — scan + enqueue (heavy work runs in Queue consumer)
      const BINDING_INDEX_KEY = 'bucket-key:ids';
      const BINDING_PREFIX = 'bucket-key:';
      const bIdx = await stores.atomic.get<string[]>(BINDING_INDEX_KEY);
      if (bIdx) {
        for (const sid of bIdx.value) {
          try {
            const entry = await stores.atomic.get<any>(BINDING_PREFIX + sid);
            if (!entry?.value || entry.value.expiresAt > Date.now()) continue;
            const qSent = await queueProducer.sendBucketKeyRotate({ bindingId: sid });
            if (qSent) continue;
            // Queue unavailable — inline fallback
            const binding = entry.value;
            const ak = binding.accessKeyId;
            const sk = Array.from(crypto.getRandomValues(new Uint8Array(32)))
              .map((b: number) => b.toString(16).padStart(2, '0')).join('');
            binding.secretValue = `${ak}:${sk}`;
            binding.version++;
            binding.expiresAt = Date.now() + (binding.rotationIntervalMs ?? 24 * 60 * 60 * 1000);
            await stores.atomic.set(BINDING_PREFIX + sid, binding, entry.version);
          } catch { /* skip */ }
        }
      }
    } finally {
      eventLoop.enqueuePriority({ type: 'health:check', payload: {} });
    }
  });

  // Trigger first health check
  eventLoop.enqueuePriority({ type: 'health:check', payload: {} });
}

// ─── Marker-gated GC dispatch ───

interface GcParams {
  sandboxId: string;
  reason: string;
  providerId: string;
  region: string;
  instanceId?: string | undefined;
  containerCount: number;
  sandboxName: string;
  createdAt: number;
}

/**
 * Marker-gated GC dispatch.
 *
 * 1. Check marker — if valid & unexpired, skip (already queued).
 * 2. Try Queue → write marker → if accepted, done (consumer handles rest).
 * 3. Queue unavailable → inline fallback → clear marker on success.
 */
async function dispatchGc(
  atomic: IAtomicStore,
  queueProducer: IMessageQueue,
  providers: Pick<IProviderRegistry, 'container' | 'resolveContainer'>,
  audit: IAuditWriter | undefined,
  params: GcParams,
): Promise<void> {
  const markerKey = GC_MARKER_PREFIX + params.sandboxId;
  const now = Date.now();

  // 1. Check existing marker
  const marker = await atomic.get<{ expiresAt: number }>(markerKey);
  if (marker && marker.value.expiresAt > now) {
    // Already queued, marker still fresh — consumer will handle it
    return;
  }

  // 2. Try Queue dispatch
  const qSent = await queueProducer.sendSandboxGc({
    sandboxId: params.sandboxId, reason: params.reason as any,
    providerId: params.providerId, region: params.region,
    ...(params.instanceId ? { instanceId: params.instanceId } : {}),
    containerCount: params.containerCount,
    sandboxName: params.sandboxName, createdAt: params.createdAt,
  });

  // 3. Write marker (prevents other ticks from re-enqueuing)
  //    Use the expired marker's version if it existed, null otherwise.
  await atomic.set(markerKey, { expiresAt: now + GC_MARKER_TTL_MS }, marker?.version ?? null);

  if (qSent) return; // Queue accepted — consumer will process

  // 4. Queue unavailable — inline fallback. Resolve per-instance provider.
  let containerProvider = providers.container;
  if (params.instanceId) {
    const resolved = await providers.resolveContainer?.(params.instanceId as any);
    if (resolved) containerProvider = resolved;
  }
  try {
    await containerProvider.delete({ region: params.region as any, providerId: params.providerId });
  } catch { /* best-effort */ }

  await gcUpdateState(atomic, audit, params.sandboxId, params.reason,
    params.sandboxName, params.providerId, params.containerCount, params.createdAt);

  // 5. Clear marker (we handled it inline)
  const m2 = await atomic.get<{ expiresAt: number }>(markerKey);
  if (m2) await atomic.set(markerKey, null as any, m2.version);
}

// ─── Inline GC state update (OCC retry + audit) ───

/** OCC state update + audit log for sandbox GC (inline fallback path). */
async function gcUpdateState(
  atomic: IAtomicStore,
  audit: IAuditWriter | undefined,
  sid: string,
  reason: string,
  name: string,
  providerId: string,
  containerCount: number,
  createdAt: number,
): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const latest = await atomic.get<any>('sandbox:' + sid);
    if (!latest || latest.value.status === SandboxStatus.Deleted) break;
    const ver = await atomic.set('sandbox:' + sid, {
      ...latest.value, status: SandboxStatus.Deleted, updatedAt: Date.now(),
    }, latest.version);
    if (!ver) continue;
    const idxEntry = await atomic.get<string[]>('sandbox:ids');
    if (idxEntry) await atomic.set('sandbox:ids', idxEntry.value.filter((i: string) => i !== sid), idxEntry.version);
    console.log(formatDmesgLine(`sandbox DELETED (${reason}) id=${sid} name=${name} provider=${providerId} containers=${containerCount} uptime=${Date.now() - createdAt}ms`));
    audit?.write({
      level: 4, facility: 'sandbox-service',
      message: `Sandbox auto-deleted (${reason}) — ${sid}`,
      metadata: { eventType: 'sandbox.auto-deleted', sandboxId: sid, reason },
    } as any);
    break;
  }
}
