import type { CreateContainerGroupInput, ContainerCreateConfig, ProbeSpec } from './types.ts';
import type { IContainerProvider, IContainerGroupProvider } from './interfaces.ts';
import type { PodSpec, ContainerSpec } from '../pod/types.ts';
import { z } from 'zod';

// ─── Probe sanitization ───

/** Shell metacharacters that should be stripped from probe arguments. */
const SHELL_META = /[;|&$()`'\n]/g;

/**
 * Sanitize a ProbeSpec to prevent command injection through shell metacharacters:
 *
 * - exec.command elements: strip shell metacharacters (already argv-safe when used
 *   with CMD instead of CMD-SHELL at the provider level, but defense-in-depth).
 * - httpGet.path: strip shell metacharacters, default to '/'. Port: coerce to number.
 * - tcpSocket: coerce port to number.
 */
export function sanitizeProbe(p: ProbeSpec): ProbeSpec {
  if (p.exec) {
    return {
      ...p,
      exec: {
        command: p.exec.command.map(s => s.replace(SHELL_META, '')),
      },
    };
  }
  if (p.httpGet) {
    return {
      ...p,
      httpGet: {
        port: Number(p.httpGet.port),
        path: p.httpGet.path.replace(SHELL_META, ''),
        ...(p.httpGet.scheme !== undefined ? { scheme: p.httpGet.scheme } : {}),
      },
    };
  }
  if (p.tcpSocket) {
    return {
      ...p,
      tcpSocket: { port: Number(p.tcpSocket.port) },
    };
  }
  return p;
}

function sanitizeContainer(c: ContainerCreateConfig): ContainerCreateConfig {
  return {
    ...c,
    ...(c.livenessProbe ? { livenessProbe: sanitizeProbe(c.livenessProbe) } : {}),
    ...(c.readinessProbe ? { readinessProbe: sanitizeProbe(c.readinessProbe) } : {}),
    ...(c.startupProbe ? { startupProbe: sanitizeProbe(c.startupProbe) } : {}),
  };
}

/**
 * Sanitize a CreateContainerGroupInput in-place, cleaning all probes
 * across all containers to remove potential shell injection vectors.
 */
export function sanitizeContainerInput(input: CreateContainerGroupInput): CreateContainerGroupInput {
  return {
    ...input,
    containers: input.containers.map(sanitizeContainer),
  };
}

// ─── Provider decorators ───

/**
 * Wrap an IContainerProvider with input sanitization.
 * All containers' probes are cleaned before reaching the implementation.
 */
export function secureContainerProvider(inner: IContainerProvider): IContainerProvider {
  // Proxy intercepts create/update for sanitization, passes everything else through.
  // Class methods live on the prototype — Object.keys() can't see them, so we use Proxy.
  return new Proxy(inner, {
    get(target, prop: string | symbol, receiver) {
      if (prop === 'create') {
        return (input: CreateContainerGroupInput) => target.create(sanitizeContainerInput(input));
      }
      if (prop === 'update' && target.update) {
        // eslint-disable-next-line @typescript-eslint/no-restricted-types -- proxy delegates to target with same Partial signature
        return (providerId: string, input: Partial<CreateContainerGroupInput>) => {
          const sanitizedContainers = input.containers?.map(sanitizeContainer);
          return target.update!(providerId, {
            ...input,
            ...(sanitizedContainers ? { containers: sanitizedContainers } : {}),
          });
        };
      }
      const val = Reflect.get(target, prop, receiver);
      try { return z.function().parse(val).bind(target); } catch { /* not a function — return raw value */ }
      return val;
    },
  });
}

/** Sanitize probes across all containers in a PodSpec (defense-in-depth). */
function sanitizePodSpec(spec: PodSpec): PodSpec {
  return {
    ...spec,
    spec: {
      ...spec.spec,
      containers: spec.spec.containers.map(sanitizePodContainer),
      ...(spec.spec.initContainers ? { initContainers: spec.spec.initContainers.map(sanitizePodContainer) } : {}),
    },
  };
}

function sanitizePodContainer(c: ContainerSpec): ContainerSpec {
  return {
    ...c,
    ...(c.livenessProbe ? { livenessProbe: sanitizeProbe(c.livenessProbe) } : {}),
    ...(c.readinessProbe ? { readinessProbe: sanitizeProbe(c.readinessProbe) } : {}),
    ...(c.startupProbe ? { startupProbe: sanitizeProbe(c.startupProbe) } : {}),
  };
}

/**
 * Wrap an IContainerGroupProvider with input sanitization.
 */
export function secureContainerGroupProvider(inner: IContainerGroupProvider): IContainerGroupProvider {
  return new Proxy(inner, {
    get(target, prop: string | symbol, receiver) {
      if (prop === 'createPod') {
        return (input: PodSpec) => target.createPod(sanitizePodSpec(input));
      }
      const val = Reflect.get(target, prop, receiver);
      try { return z.function().parse(val).bind(target); } catch { /* not a function — return raw value */ }
      return val;
    },
  });
}
