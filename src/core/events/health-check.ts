import { z } from 'zod';
import type { EventBus } from '../event-bus/bus.ts';
import type { EventLoop } from '../event-bus/loop.ts';
import type { IAtomicStore } from '../store/interfaces.ts';
import type { IProviderRegistry } from '../provider/interfaces.ts';
import type { IAuditWriter } from '../audit/types.ts';
import type { IMessageQueue } from '../../queue/interfaces.ts';
import { createRegionId } from '../region/types.ts';
import { createInstanceId } from '../region/instance.ts';
import { formatDmesgLine } from '../utils/dmesg.ts';

interface ContainerResolver { resolveContainer: IProviderRegistry['resolveContainer'] }

export type GcReason = 'stopped-gc' | 'provider-gone' | 'exited-gc' | 'unhealthy-gc' | 'failed-gc' | 'expired-gc' | 'stuck-gc' | 'terminating-gc';

/** Pure GC decision function — extracts the branching logic from registerPodHealthCheck.
 *  Maps PodPhase (5-state) to GC reason or null (no action needed).
 *  Independent from event handler wiring; used for differential testing against NRI. */
export function decidePodGc(
  phase: string,
  durationMs: number,
  providerAlive: boolean | undefined,
  containerAlive: boolean[],
  fails: number,
  maxRetries: number,
): GcReason | null {
  if (phase === 'Succeeded') {
    return durationMs >= 60_000 ? 'stopped-gc' : null;
  }
  if (phase === 'Failed') {
    return durationMs >= 24 * 60 * 60 * 1000 ? 'failed-gc' : null;
  }
  if (phase === 'Pending') {
    if (providerAlive === false) return 'provider-gone';
    if (durationMs >= 10 * 60 * 1000) return 'stuck-gc';
    return null;
  }
  if (phase === 'Running') {
    if (providerAlive === false) return 'provider-gone';
    if (maxRetries === -1) return null;
    const anyAlive = containerAlive.some(a => a);
    const allAlive = containerAlive.every(a => a);
    if (!anyAlive) {
      return fails >= maxRetries ? 'exited-gc' : null;
    }
    if (!allAlive) {
      return fails >= maxRetries ? 'unhealthy-gc' : null;
    }
    return null;
  }
  // Unknown phase — catch-all GC after long timeout
  if (durationMs >= 24 * 60 * 60 * 1000) return 'stuck-gc';
  return null;
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
  const { podService, stores, providers, eventBus, eventLoop, audit } = deps;

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
          const instanceId = z.string().optional().parse((pod.spec.providerOverrides)?.instanceId);

          const durationMs = Date.now() - pod.updatedAt;

          // ── Phase-based GC via pure decision function ──
          if (phase === 'Succeeded') {
            const reason = decidePodGc('Succeeded', durationMs, undefined, [], 0, 0);
            if (reason) {
              await dispatchPodGc(stores.atomic, providers, audit, {
                podId: pid, reason, providerId: providerId ?? pid,
                podName: pod.name, createdAt: pod.createdAt,
                ...(instanceId ? { instanceId } : {}),
              });
            }
            continue;
          }

          if (phase === 'Failed') {
            const reason = decidePodGc('Failed', durationMs, undefined, [], 0, 0);
            if (reason) {
              await dispatchPodGc(stores.atomic, providers, audit, {
                podId: pid, reason, providerId: providerId ?? pid,
                podName: pod.name, createdAt: pod.createdAt,
                ...(instanceId ? { instanceId } : {}),
              });
            }
            continue;
          }

          // ── Pending — transient state with provider resource ──
          if (phase === 'Pending') {
            let providerAlive: boolean | undefined;

            if (providerId && instanceId) {
              try {
                const rt = await podService.checkProviderStatus(createPodId(pid));
                if (!rt) {
                  providerAlive = false;
                } else {
                  providerAlive = true;
                  // Scheduling → Running auto-promotion
                  if (rt.status === ContainerGroupState.Running) {
                    try { await podService.syncRuntime(createPodId(pid)); } catch (_e) {
                      console.error('pod runtime sync failed (best-effort):', _e);
                    }
                    continue;
                  }
                }
              } catch (_e) {
                console.error('provider check failed (fall through to timeout):', _e);
              }
            }

            const reason = decidePodGc('Pending', durationMs, providerAlive, [], 0, 0);
            if (reason) {
              await dispatchPodGc(stores.atomic, providers, audit, {
                podId: pid, reason, providerId: providerId ?? pid,
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
            } catch (_e) {
              console.error('runtime check failed:', _e);
            }
            if (!runtime) {
              stableSince.delete(pid);
              const reason = decidePodGc('Running', durationMs, false, [], 0, maxRetries);
              if (reason) {
                await dispatchPodGc(stores.atomic, providers, audit, {
                  podId: pid, reason, providerId,
                  podName: pod.name, createdAt: pod.createdAt,
                  ...(instanceId ? { instanceId } : {}),
                });
              }
              continue;
            }

            const containerAlive = runtime.containers.map(c => c.alive);
            const anyAlive = containerAlive.some(a => a);
            const allAlive = containerAlive.every(a => a);
            const failKey = `pod:health:fails:${pid}`;
            const failEntry = await stores.atomic.get<number>(failKey);

            // All containers healthy — reset counter, mark stable
            if (anyAlive && allAlive) {
              if (failEntry) await stores.atomic.set(failKey, 0, failEntry.version);
              stableSince.set(pid, pod.updatedAt);
              continue;
            }

            // Some or all unhealthy — increment fail counter
            stableSince.delete(pid);
            const currentFails = (failEntry?.value ?? 0) + 1;
            await stores.atomic.set(failKey, currentFails, failEntry?.version ?? null);

            const reason = decidePodGc('Running', durationMs, true, containerAlive, currentFails, maxRetries);
            if (reason) {
              await dispatchPodGc(stores.atomic, providers, audit, {
                podId: pid, reason, providerId,
                podName: pod.name, createdAt: pod.createdAt,
                ...(instanceId ? { instanceId } : {}),
              });
            }
            continue;
          }

          // ── Unknown — unexpected phase, GC after long timeout ──
          const reason = decidePodGc(phase, durationMs, undefined, [], 0, 0);
          if (reason) {
            await dispatchPodGc(stores.atomic, providers, audit, {
              podId: pid, reason, providerId: providerId ?? pid,
              podName: pod.name, createdAt: pod.createdAt,
              ...(instanceId ? { instanceId } : {}),
            });
          }
          continue;
        } catch (_e) {
          console.error('pod health check error (skipping):', _e);
        }
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
  let parsed: InstanceId | undefined;
  try {
    parsed = createInstanceId(raw);
  } catch (_e) {
    console.error('resolvePodGcInstanceId: invalid instance id', _e);
  }
  return parsed;
}

async function dispatchPodGc(
  atomic: IAtomicStore,
  providers: ContainerResolver,
  audit: IAuditWriter | undefined,
  params: PodGcParams,
): Promise<void> {
  const markerKey = POD_GC_MARKER_PREFIX + params.podId;
  const now = Date.now();

  const marker = await atomic.get<{ expiresAt: number }>(markerKey);
  if (marker && marker.value.expiresAt > now) return;

  await atomic.set(markerKey, { expiresAt: now + POD_GC_MARKER_TTL_MS }, marker?.version ?? null);

  // Inline cleanup
  const instId = resolvePodGcInstanceId(params.instanceId);
  if (instId) {
    try {
      const resolved = await providers.resolveContainer(instId);
      await resolved.delete({ region: createRegionId('cn-hangzhou'), providerId: params.providerId });
    } catch (_e) {
      console.error('inline cleanup failed (best-effort):', _e);
    }
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

