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

/** GC reason enum — validated at dispatch so callers never bypass the type check. */
const gcReasonSchema = z.enum(['stopped-gc', 'provider-gone', 'exited-gc', 'unhealthy-gc', 'manual', 'failed-gc', 'expired-gc', 'stuck-gc']);

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
          const instanceId = z.string().optional().parse((pod.spec.providerOverrides)?.instanceId);

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
                  try { await podService.syncRuntime(createPodId(pid)); } catch {

                    console.log("best-effort");

                  }
                  continue;
                }
              } catch {

                console.log("provider unreachable — fall through to timeout");

              }
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

              console.log("");

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
          if (Date.now() - pod.updatedAt > 24 * 60 * 60 * 1000) {
            await dispatchPodGc(stores.atomic, queueProducer, providers, audit, {
              podId: pid, reason: 'stuck-gc', providerId: providerId ?? pid,
              podName: pod.name, createdAt: pod.createdAt,
              ...(instanceId ? { instanceId } : {}),
            });
          }
          continue;
        } catch {

          console.log("skip individual pod errors");

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
  try { return createInstanceId(raw); } catch {

    console.log("");

  }
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
    sandboxId: params.podId, reason: gcReasonSchema.parse(params.reason),
    providerId: params.providerId, region: 'cn-hangzhou',
    ...(params.instanceId ? { instanceId: params.instanceId } : {}),
    containerCount: 0,
    sandboxName: params.podName, createdAt: params.createdAt,
  });

  await atomic.set(markerKey, { expiresAt: now + POD_GC_MARKER_TTL_MS }, marker?.version ?? null);

  if (qSent) return;

  // Queue unavailable — inline fallback
  const instId = resolvePodGcInstanceId(params.instanceId);
  if (instId) {
    try {
      const resolved = await providers.resolveContainer(instId);
      await resolved.delete({ region: createRegionId('cn-hangzhou'), providerId: params.providerId });
    } catch {

      console.log("best-effort");

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

