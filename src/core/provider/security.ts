import type { CreateContainerGroupInput, ContainerCreateConfig, ProbeSpec } from './types.ts';
import type { IContainerProvider, IContainerGroupProvider } from './interfaces.ts';

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
        path: (p.httpGet.path ?? '/').replace(SHELL_META, ''),
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
/** Keys that need input sanitization wrapping (not plain passthrough). */
const SANITIZE_KEYS = new Set(['create', 'update']);

export function secureContainerProvider(inner: IContainerProvider): IContainerProvider {
  // Build a proxy that sanitizes create/update and passthrough everything else.
  const overrides: Record<string, Function> = {
    create(input: CreateContainerGroupInput) {
      return inner.create(sanitizeContainerInput(input));
    },
  };
  if (inner.update) {
    overrides.update = (providerId: string, input: Partial<CreateContainerGroupInput>) =>
      inner.update!(providerId, sanitizeContainerInput(input as CreateContainerGroupInput));
  }

  const proxy = Object.fromEntries(
    (Object.keys(inner) as (keyof IContainerProvider)[])
      .filter(k => !SANITIZE_KEYS.has(k as string))
      .map(k => [k, (...args: unknown[]) => (inner[k] as Function)(...args)]),
  ) as Record<string, Function>;

  return { ...proxy, ...overrides } as unknown as IContainerProvider;
}

/**
 * Wrap an IContainerGroupProvider with input sanitization.
 */
export function secureContainerGroupProvider(inner: IContainerGroupProvider): IContainerGroupProvider {
  return {
    async createGroup(input) {
      return inner.createGroup(sanitizeContainerInput(input));
    },
    stopGroup(providerId: string) {
      return inner.stopGroup(providerId);
    },
    deleteGroup(providerId: string) {
      return inner.deleteGroup(providerId);
    },
    getGroupStatus(providerId: string) {
      return inner.getGroupStatus(providerId);
    },
    describeGroups(input) {
      return inner.describeGroups(input);
    },
  };
}
