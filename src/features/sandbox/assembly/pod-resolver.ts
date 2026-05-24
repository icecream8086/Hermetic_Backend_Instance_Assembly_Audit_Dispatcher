import type { IContainerGroupProvider } from '../../../core/provider/interfaces.ts';
import type { CreateContainerGroupInput, ContainerCreateConfig } from '../../../core/provider/types.ts';
import { createRegionId } from '../../../core/region/types.ts';
import type { PodSpec } from './types.ts';

const LOCAL_REGION = createRegionId('local');

// ─── Helpers ───

/** Parse a CPU string like "1.5" or "0.25" to a fractional number. */
function parseCpu(s: string | undefined): number | undefined {
  if (s === undefined) return undefined;
  const v = parseFloat(s);
  return Number.isFinite(v) && v >= 0 ? v : undefined;
}

/** Parse a memory string like "512Mi" or "1Gi" to MB. */
function parseMemory(s: string | undefined): number | undefined {
  if (s === undefined) return undefined;
  const re = /^(\d+(?:\.\d+)?)\s*(Ki|Mi|Gi|Ti|k|M|G|T|KB|MB|GB|TB)?$/i;
  const m = s.match(re);
  if (!m) return undefined;
  const num = parseFloat(m[1]!);
  if (!Number.isFinite(num) || num < 0) return undefined;
  const unit = (m[2] ?? '').toLowerCase();
  const multipliers: Record<string, number> = {
    ki: 1 / 1024, k: 1 / 1024, kb: 1 / 1024,
    '': 1, m: 1, mb: 1,
    mi: 1,
    gi: 1024, g: 1024, gb: 1024,
    ti: 1024 * 1024, t: 1024 * 1024, tb: 1024 * 1024,
  };
  return num * (multipliers[unit] ?? 1);
}

/**
 * PodResolver — converts a PodSpec (docker-compose-like) into a single
 * `CreateContainerGroupInput` for provider-agnostic submission.
 *
 * Container group is the high-level abstraction:
 * - **Podman**: multi-container → Podman pod (via libpod pods API);
 *   single-container → Docker-compatible API.
 * - **ECI**: all containers submitted as one ContainerGroup (native).
 *
 * The resolver is stateless and provider-neutral — it only maps types.
 * Provider-specific concerns (infra containers, shared namespaces) are handled
 * by the provider implementation.
 */
export class PodResolver {
  readonly #groupProvider: IContainerGroupProvider;

  constructor(groupProvider: IContainerGroupProvider) {
    this.#groupProvider = groupProvider;
  }

  /**
   * Convert a PodSpec to a `CreateContainerGroupInput` without submitting it.
   * All services become containers in a single container group.
   */
  toGroupInput(spec: PodSpec): CreateContainerGroupInput {
    const containers: ContainerCreateConfig[] = Object.entries(spec.services).map(([name, svc]) => {
      const args = typeof svc.command === 'string'
        ? [svc.command]
        : svc.command as readonly string[] | undefined;

      const env = svc.environment
        ? Object.entries(svc.environment).map(([k, v]) => ({ name: k, value: v } as const))
        : undefined;

      const ports = svc.ports?.map(p => ({
        containerPort: p.containerPort,
        ...(p.hostPort !== undefined ? { hostPort: p.hostPort } : {}),
        protocol: p.protocol ?? ('tcp' as const),
      }));

      const cpu = parseCpu(svc.resources?.cpu);
      const memory = parseMemory(svc.resources?.memory);
      const resources = cpu !== undefined || memory !== undefined
        ? { limits: { cpu: cpu ?? 0, memory: memory ?? 0 } }
        : undefined;

      const livenessProbe = svc.healthCheck
        ? {
            exec: { command: [...svc.healthCheck.test] },
            ...(svc.healthCheck.intervalSeconds !== undefined ? { periodSeconds: svc.healthCheck.intervalSeconds } : {}),
            ...(svc.healthCheck.timeoutSeconds !== undefined ? { timeoutSeconds: svc.healthCheck.timeoutSeconds } : {}),
            ...(svc.healthCheck.retries !== undefined ? { failureThreshold: svc.healthCheck.retries } : {}),
            ...(svc.healthCheck.startPeriodSeconds !== undefined ? { initialDelaySeconds: svc.healthCheck.startPeriodSeconds } : {}),
          }
        : undefined;

      return {
        name: `${spec.name}-${name}`,
        image: svc.image,
        ...(args ? { args } : {}),
        ...(env ? { env: env as any } : {}),
        ...(ports ? { ports } : {}),
        ...(resources ? { resources } : {}),
        ...(livenessProbe ? { livenessProbe } : {}),
      } as ContainerCreateConfig;
    });

    const totalCpu = parseCpu(spec.resources?.cpu) ?? 1;
    const totalMem = parseMemory(spec.resources?.memory) ?? 512;

    return {
      name: spec.name,
      region: LOCAL_REGION,
      cpu: totalCpu,
      memory: totalMem,
      spotStrategy: 'None',
      restartPolicy: 'Never',
      containers,
      network: { allocatePublicIp: false },
      ...(spec.labels ? { tags: Object.entries(spec.labels).map(([k, v]) => ({ key: k, value: v })) } : {}),
      ...(spec.sharedNamespaces ? { providerOverrides: { sharedNamespaces: spec.sharedNamespaces.map(s => s.toString()) } } : {}),
    };
  }

  /**
   * Submit a PodSpec as a single container group to the provider.
   * Returns the provider-assigned ID.
   */
  async apply(spec: PodSpec): Promise<{ providerId: string }> {
    const input = this.toGroupInput(spec);
    return this.#groupProvider.createGroup(input);
  }
}
