import { z } from 'zod';
import type { EventBus } from '../event-bus/bus.ts';
import type { EventLoop } from '../event-bus/loop.ts';
import type { IAtomicStore } from '../store/interfaces.ts';
import type { IProviderRegistry } from '../provider/interfaces.ts';
import type { IAuditWriter } from '../audit/types.ts';
import type { IMessageQueue } from '../../queue/interfaces.ts';
import type { Sandbox } from '../../features/sandbox/types.ts';
import { SandboxStatus } from '../../features/sandbox/types.ts';
import { createRegionId } from '../region/types.ts';
import { createInstanceId } from '../region/instance.ts';
import { runtimeToNetwork, runtimeToContainers, runtimeToEvents } from '../../features/sandbox/runtime-mapper.ts';
import { formatDmesgLine } from '../utils/dmesg.ts';

type ContainerResolver = { resolveContainer: IProviderRegistry['resolveContainer'] };

export interface HealthCheckDeps {
  stores: { atomic: IAtomicStore };
  providers: ContainerResolver;
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

          // Succeeded (stopped manually) > 60s → GC
          if (entry.value.status === SandboxStatus.Succeeded) {
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
          // Failed/Terminating ≥ 60s → GC
          if (entry.value.status === SandboxStatus.Failed || entry.value.status === SandboxStatus.Terminating) {
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

          // ── Hard terminal states (no cloud resources) ──
          // ScheduleFailed and Expired have no provider resources (never
          // created, or already reclaimed).  Auto-clean after a long window
          // to prevent index bloat while preserving audit metadata.
          if (
            entry.value.status === SandboxStatus.ScheduleFailed ||
            entry.value.status === SandboxStatus.Expired
          ) {
            const TERMINAL_CLEANUP_MS = 24 * 60 * 60 * 1000; // 24h — preserve for audit
            const duration = Date.now() - entry.value.updatedAt;
            if (duration > TERMINAL_CLEANUP_MS) {
              await dispatchGc(stores.atomic, queueProducer, providers, audit, {
                sandboxId: sid, reason: 'expired-gc',
                providerId: entry.value.providerId ?? sid,
                region: entry.value.config.region,
                ...(instanceId ? { instanceId } : {}),
                containerCount: entry.value.containers.length,
                sandboxName: entry.value.name, createdAt: entry.value.createdAt,
              });
            }
            continue;
          }

          // ── Transient states with cloud resources ──
          // Scheduling, Pending, Restarting, Updating — the sandbox has a
          // provider resource that may disappear externally (user deletes ECI
          // from Alibaba console).  Check provider liveness + timeout fallback
          // so we don't leak orphaned sandbox records.
          if (
            entry.value.status === SandboxStatus.Scheduling ||
            entry.value.status === SandboxStatus.Pending ||
            entry.value.status === SandboxStatus.Restarting ||
            entry.value.status === SandboxStatus.Updating
          ) {
            const TRANSIENT_TIMEOUT_MS = 10 * 60 * 1000; // 10 min — generous for ECI scheduling + image pull
            const duration = Date.now() - entry.value.updatedAt;
            const providerIdentity = (entry.value.config as unknown as Record<string, unknown>).providerIdentity;
            const resolvedInstanceId = instanceId ?? (providerIdentity as Record<string, unknown> | undefined)?.instanceId as string | undefined;

            // Try provider status check (only if we have instance routing info)
            if (resolvedInstanceId) {
              try {
                const p = resolvedInstanceId ? await providers.resolveContainer?.(createInstanceId(resolvedInstanceId)) : undefined;
                if (p?.getStatus) {
                  const rt = await p.getStatus(entry.value.providerId ?? sid);
                  if (!rt) {
                    // Provider resource is gone — cloud resource deleted externally
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
                  // Scheduling auto-promotion: provider says Running → promote locally
                  // eslint-disable-next-line @typescript-eslint/no-unsafe-enum-comparison -- rt.status is provider-level string, not SandboxStatus enum
                  if (entry.value.status === SandboxStatus.Scheduling && rt.status === 'Running') {
                    const latest = await stores.atomic.get<Sandbox>(`sandbox:${sid}`);
                    if (latest?.value.status === SandboxStatus.Scheduling) {
                      await stores.atomic.set(`sandbox:${sid}`, {
                        ...latest.value,
                        status: SandboxStatus.Running,
                        network: runtimeToNetwork(rt.network, rt.associatedResources),
                        containers: runtimeToContainers(rt),
                        events: runtimeToEvents(rt),
                        updatedAt: Date.now(),
                      }, latest.version);
                    }
                    continue;
                  }
                }
              } catch (e) {
                console.error(`[health-check] provider check failed for ${sid} (${entry.value.status}): ${e instanceof Error ? e.message : String(e)}`);
              }
            }

            // Timeout fallback — if we can't reach the provider or it's stuck,
            // GC after the timeout window to prevent permanent orphans.
            if (duration > TRANSIENT_TIMEOUT_MS) {
              await dispatchGc(stores.atomic, queueProducer, providers, audit, {
                sandboxId: sid, reason: 'stuck-gc',
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

          if (!instanceId || !providers.resolveContainer) continue;
          const provider = await providers.resolveContainer(instanceId);
          if (!provider?.getStatus) continue;

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
            // Use fail counter — only GC after maxRetries consecutive failures.
            // This gives asyncInit providers (ECI) time to start containers.
            stableSince.delete(sid);
            const failEntry = await stores.atomic.get<number>(failKey);
            const fails = (failEntry?.value ?? 0) + 1;
            await stores.atomic.set(failKey, fails, failEntry?.version ?? null);
            if (fails >= maxRetries) {
              await dispatchGc(stores.atomic, queueProducer, providers, audit, {
                sandboxId: sid, reason: 'exited-gc',
                providerId: entry.value.providerId ?? sid,
                region: entry.value.config.region,
                ...(instanceId ? { instanceId } : {}),
                containerCount: entry.value.containers.length,
                sandboxName: entry.value.name, createdAt: entry.value.createdAt,
              });
            }
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
            const instEntry = await stores.atomic.get<Record<string, unknown>>('instance:' + iid);
            if (!instEntry?.value) continue;
            const instValue = z.object({ status: z.string().optional(), updatedAt: z.number().optional() }).passthrough() /* TODO: Zod v4 z.looseObject() */.parse(instEntry.value);
            if (instValue.status !== 'online') continue;
            if (instValue.updatedAt !== undefined && (now - instValue.updatedAt > 120_000)) {
              await stores.atomic.set('instance:' + iid, { ...instValue, status: 'offline', updatedAt: now }, instEntry.version);
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
            const entry = await stores.atomic.get<Record<string, unknown>>(BINDING_PREFIX + sid);
            if (!entry?.value) continue;
            const bindingSchema = z.object({ expiresAt: z.number(), accessKeyId: z.string(), version: z.number(), rotationIntervalMs: z.number().optional() }).passthrough() /* TODO: Zod v4 z.looseObject() */;
            const parsed = bindingSchema.parse(entry.value);
            if (parsed.expiresAt > Date.now()) continue;
            const qSent = await queueProducer.sendBucketKeyRotate({ bindingId: sid });
            if (qSent) continue;
            const sk = Array.from(crypto.getRandomValues(new Uint8Array(32)))
              .map((b: number) => b.toString(16).padStart(2, '0')).join('');
            const updated = {
              ...parsed,
              secretValue: `${parsed.accessKeyId}:${sk}`,
              version: parsed.version + 1,
              expiresAt: Date.now() + (parsed.rotationIntervalMs ?? 24 * 60 * 60 * 1000),
            };
            await stores.atomic.set(BINDING_PREFIX + sid, updated, entry.version);
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
  providers: ContainerResolver,
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
    sandboxId: params.sandboxId, reason: params.reason as 'stopped-gc' | 'provider-gone' | 'exited-gc' | 'unhealthy-gc' | 'manual' | 'failed-gc' | 'expired-gc' | 'stuck-gc',
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
  if (params.instanceId && providers.resolveContainer) {
    try {
      const resolved = await providers.resolveContainer(createInstanceId(params.instanceId));
      await resolved.delete({ region: createRegionId(params.region), providerId: params.providerId });
    } catch { /* best-effort */ }
  }

  await gcUpdateState(atomic, audit, params.sandboxId, params.reason,
    params.sandboxName, params.providerId, params.containerCount, params.createdAt);

  // 5. Clear marker (we handled it inline)
  const m2 = await atomic.get<{ expiresAt: number }>(markerKey);
  if (m2) await atomic.set<Record<string, unknown> | null>(markerKey, null, m2.version);
}

// ═══════════════════════════════════════════════════════════════
// Pod GC — PodPhase-based health check
// ═══════════════════════════════════════════════════════════════

import type { PodService } from '../pod/service.ts';
import type { PodEntity } from '../pod/types.ts';
import { createPodId } from '../pod/types.ts';
import { ContainerGroupState } from '../provider/container-lifecycle.ts';
import type { InstanceId } from '../region/instance.ts';

export interface PodHealthCheckDeps {
  podService: PodService;
  stores: { atomic: IAtomicStore };
  providers: ContainerResolver;
  eventBus: EventBus;
  eventLoop: EventLoop;
  audit: IAuditWriter;
  queueProducer: IMessageQueue;
}

const POD_GC_MARKER_PREFIX = 'gc:pod:queued:';
const POD_GC_MARKER_TTL_MS = 120_000;

/**
 * Register the Pod health:check handler.
 *
 * GC strategy (PodPhase-based, Queue-first):
 *   Pending   → provider check + timeout → provider-gone / stuck-gc
 *   Running   → health check + retries → exited-gc / unhealthy-gc / provider-gone
 *   Succeeded → timeout → stopped-gc
 *   Failed    → timeout → failed-gc (long window for audit preservation)
 *
 * Uses PodPhase (5 states) instead of SandboxStatus (11 states).
 * Finer differentiation within a phase is done via provider status checks.
 */
export function registerPodHealthCheck(deps: PodHealthCheckDeps): void {
  const { podService, stores, providers, eventBus, eventLoop, audit, queueProducer } = deps;

  /** Track last stable updatedAt per pod to skip redundant provider checks. */
  const stableSince = new Map<string, number>();

  eventBus.on('health:pod:check', async () => {
    try {
      const podIds = await podService.getAllIds();
      for (const pid of podIds) {
        try {
          const pod = await podService.getById(createPodId(pid));
          if (!pod) continue;

          const phase = pod.phase;
          const providerId = pod.providerId;
          const instanceId = (pod.spec.providerOverrides)?.instanceId as string | undefined;

          // ── Succeeded > 60s → stopped-gc ──
          if (phase === 'Succeeded') {
            if (Date.now() - pod.updatedAt > 60_000) {
              await dispatchPodGc(stores.atomic, queueProducer, providers, audit, {
                podId: pid, reason: 'stopped-gc', providerId: providerId ?? pid,
                podName: pod.name, createdAt: pod.createdAt,
                ...(instanceId ? { instanceId } : {}),
              });
            }
            continue;
          }

          // ── Failed > 24h → failed-gc (long window for audit) ──
          if (phase === 'Failed') {
            if (Date.now() - pod.updatedAt > 24 * 60 * 60 * 1000) {
              await dispatchPodGc(stores.atomic, queueProducer, providers, audit, {
                podId: pid, reason: 'failed-gc', providerId: providerId ?? pid,
                podName: pod.name, createdAt: pod.createdAt,
                ...(instanceId ? { instanceId } : {}),
              });
            }
            continue;
          }

          // ── Pending — transient state with provider resource ──
          if (phase === 'Pending') {
            const TRANSIENT_TIMEOUT_MS = 10 * 60 * 1000;
            const duration = Date.now() - pod.updatedAt;

            if (providerId && instanceId) {
              try {
                const rt = await podService.checkProviderStatus(createPodId(pid));
                if (!rt) {
                  await dispatchPodGc(stores.atomic, queueProducer, providers, audit, {
                    podId: pid, reason: 'provider-gone', providerId,
                    podName: pod.name, createdAt: pod.createdAt,
                    ...(instanceId ? { instanceId } : {}),
                  });
                  continue;
                }
                // Scheduling → Running auto-promotion
                if (rt.status === ContainerGroupState.Running) {
                  try { await podService.syncRuntime(createPodId(pid)); } catch { /* best-effort */ }
                  continue;
                }
              } catch { /* provider unreachable — fall through to timeout */ }
            }

            if (duration > TRANSIENT_TIMEOUT_MS) {
              await dispatchPodGc(stores.atomic, queueProducer, providers, audit, {
                podId: pid, reason: 'stuck-gc', providerId: providerId ?? pid,
                podName: pod.name, createdAt: pod.createdAt,
                ...(instanceId ? { instanceId } : {}),
              });
            }
            continue;
          }

          // ── Running — active monitoring ──
          if (phase === 'Running') {
            // Skip if unchanged since last stable check
            const lastStableAt = stableSince.get(pid);
            if (lastStableAt !== undefined && pod.updatedAt <= lastStableAt) continue;

            if (!providerId || !instanceId) continue;

            const maxRetries = 3;
            let runtime;
            try {
              runtime = await podService.checkProviderStatus(createPodId(pid));
            } catch {
              stableSince.delete(pid);
              continue;
            }

            if (!runtime) {
              stableSince.delete(pid);
              await dispatchPodGc(stores.atomic, queueProducer, providers, audit, {
                podId: pid, reason: 'provider-gone', providerId,
                podName: pod.name, createdAt: pod.createdAt,
                ...(instanceId ? { instanceId } : {}),
              });
              continue;
            }

            const allHealthy = runtime.containers.every(cc => cc.alive);
            const anyRunning = runtime.containers.some(cc => cc.alive);
            const failKey = `pod:health:fails:${pid}`;

            if (!anyRunning) {
              stableSince.delete(pid);
              const failEntry = await stores.atomic.get<number>(failKey);
              const fails = (failEntry?.value ?? 0) + 1;
              await stores.atomic.set(failKey, fails, failEntry?.version ?? null);
              if (fails >= maxRetries) {
                await dispatchPodGc(stores.atomic, queueProducer, providers, audit, {
                  podId: pid, reason: 'exited-gc', providerId,
                  podName: pod.name, createdAt: pod.createdAt,
                  ...(instanceId ? { instanceId } : {}),
                });
              }
              continue;
            }

            if (allHealthy) {
              const failEntry = await stores.atomic.get<number>(failKey);
              if (failEntry) await stores.atomic.set(failKey, 0, failEntry.version);
              stableSince.set(pid, pod.updatedAt);
            } else {
              stableSince.delete(pid);
              const failEntry = await stores.atomic.get<number>(failKey);
              const fails = (failEntry?.value ?? 0) + 1;
              await stores.atomic.set(failKey, fails, failEntry?.version ?? null);
              if (fails >= maxRetries) {
                await dispatchPodGc(stores.atomic, queueProducer, providers, audit, {
                  podId: pid, reason: 'unhealthy-gc', providerId,
                  podName: pod.name, createdAt: pod.createdAt,
                  ...(instanceId ? { instanceId } : {}),
                });
              }
            }
            continue;
          }

          // ── Unknown — unexpected phase, GC after long timeout ──
          if (phase === 'Unknown') {
            if (Date.now() - pod.updatedAt > 24 * 60 * 60 * 1000) {
              await dispatchPodGc(stores.atomic, queueProducer, providers, audit, {
                podId: pid, reason: 'stuck-gc', providerId: providerId ?? pid,
                podName: pod.name, createdAt: pod.createdAt,
                ...(instanceId ? { instanceId } : {}),
              });
            }
            continue;
          }
        } catch { /* skip individual pod errors */ }
      }
    } finally {
      eventLoop.enqueuePriority({ type: 'health:pod:check', payload: {} });
    }
  });

  // Trigger first pod health check
  eventLoop.enqueuePriority({ type: 'health:pod:check', payload: {} });
}

// ─── Pod GC dispatch (marker-gated, Queue-first) ───

interface PodGcParams {
  podId: string;
  reason: string;
  providerId: string;
  podName: string;
  createdAt: number;
  instanceId?: string | undefined;
}

function resolvePodGcInstanceId(raw: string | undefined): InstanceId | undefined {
  if (!raw) return undefined;
  try { return createInstanceId(raw); } catch { return undefined; }
}

async function dispatchPodGc(
  atomic: IAtomicStore,
  queueProducer: IMessageQueue,
  providers: ContainerResolver,
  audit: IAuditWriter | undefined,
  params: PodGcParams,
): Promise<void> {
  const markerKey = POD_GC_MARKER_PREFIX + params.podId;
  const now = Date.now();

  const marker = await atomic.get<{ expiresAt: number }>(markerKey);
  if (marker && marker.value.expiresAt > now) return;

  // Queue dispatch — reuses sandbox:gc queue but with pod-scoped markers
  const qSent = await queueProducer.sendSandboxGc({
    sandboxId: params.podId, reason: params.reason as 'stopped-gc' | 'provider-gone' | 'exited-gc' | 'unhealthy-gc' | 'manual' | 'failed-gc' | 'expired-gc' | 'stuck-gc',
    providerId: params.providerId, region: 'cn-hangzhou',
    ...(params.instanceId ? { instanceId: params.instanceId } : {}),
    containerCount: 0,
    sandboxName: params.podName, createdAt: params.createdAt,
  });

  await atomic.set(markerKey, { expiresAt: now + POD_GC_MARKER_TTL_MS }, marker?.version ?? null);

  if (qSent) return;

  // Queue unavailable — inline fallback
  const instId = resolvePodGcInstanceId(params.instanceId);
  if (instId && providers.resolveContainer) {
    try {
      const resolved = await providers.resolveContainer(instId);
      await resolved.delete({ region: createRegionId('cn-hangzhou'), providerId: params.providerId });
    } catch { /* best-effort */ }
  }

  await gcUpdatePodState(atomic, audit, params.podId, params.reason, params.podName, params.providerId, params.createdAt);

  const m2 = await atomic.get<{ expiresAt: number }>(markerKey);
  if (m2) await atomic.set<Record<string, unknown> | null>(markerKey, null, m2.version);
}

async function gcUpdatePodState(
  atomic: IAtomicStore,
  audit: IAuditWriter | undefined,
  pid: string,
  reason: string,
  name: string,
  providerId: string,
  createdAt: number,
): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const latest = await atomic.get<PodEntity>('pod:' + pid);
    if (!latest) break;
    const ver = await atomic.set('pod:' + pid, {
      ...latest.value, phase: 'Failed', updatedAt: Date.now(),
    }, latest.version);
    if (!ver) continue;

    const idxEntry = await atomic.get<string[]>('pod:ids');
    if (idxEntry) await atomic.set('pod:ids', idxEntry.value.filter((i: string) => i !== pid), idxEntry.version);

    console.log(formatDmesgLine(`pod DELETED (${reason}) id=${pid} name=${name} provider=${providerId} uptime=${String(Date.now() - createdAt)}ms`));
    audit?.write({
      level: 4, facility: 'pod-service',
      message: `Pod auto-deleted (${reason}) — ${pid}`,
      metadata: { eventType: 'pod.auto-deleted', podId: pid, reason },
    });
    break;
  }
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
    console.log(formatDmesgLine(`sandbox DELETED (${reason}) id=${sid} name=${name} provider=${providerId} containers=${String(containerCount)} uptime=${String(Date.now() - createdAt)}ms`));
    audit?.write({
      level: 4, facility: 'sandbox-service',
      message: `Sandbox auto-deleted (${reason}) — ${sid}`,
      metadata: { eventType: 'sandbox.auto-deleted', sandboxId: sid, reason },
    });
    break;
  }
}
