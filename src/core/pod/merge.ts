import type { PodSpec, ContainerSpec, VolumeSpec } from './types.ts';
import type { SecretMountConfig } from '../provider/types.ts';

/**
 * Strategic merge of two PodSpecs. Child values override parent.
 *
 * Merge rules:
 * - metadata.labels        -> child overwrites parent entirely
 * - metadata.annotations   -> child overwrites parent entirely
 * - spec.containers        -> merge by name (child replaces same-name container)
 * - spec.initContainers    -> merge by name
 * - spec.volumes           -> merge by id
 * - spec.restartPolicy     -> child overrides parent
 * - spec.dnsConfig         -> child overrides parent
 * - spec.hostAliases       -> child overrides parent
 * - spec.priority          -> child overrides parent
 * - spec.nodeSelector      -> child overrides parent
 * - spec.terminationGracePeriodSeconds -> child overrides parent
 * - spec.secretRefs        -> child overrides parent
 * - spec.resolvedSecrets   -> shallow merge by key
 * - spec.secretMounts      -> merge by mountPath (surrogate for name)
 * - spec.topologySpreadConstraints -> child replaces parent
 * - spec.affinity          -> child overrides parent
 * - spec.tolerations       -> child replaces parent
 * - spec.preemptionPolicy  -> child overrides parent
 * - providerOverrides      -> shallow merge by provider key
 *
 * Scalar fields and absent arrays in child are inherited from parent.
 */
export function mergePodSpec(parent: PodSpec, child: PodSpec): PodSpec {
  return {
    metadata: {
      name: child.metadata.name,
      labels: child.metadata.labels !== undefined
        ? child.metadata.labels
        : parent.metadata.labels,
      annotations: child.metadata.annotations !== undefined
        ? child.metadata.annotations
        : parent.metadata.annotations,
    },

    spec: {
      // Required fields — always present; merge by key where applicable
      containers: mergeContainersByIdentity(parent.spec.containers, child.spec.containers),
      restartPolicy: child.spec.restartPolicy,

      // Optional fields — inherit from parent when child omits them
      initContainers: child.spec.initContainers !== undefined
        ? mergeContainersByIdentity(parent.spec.initContainers ?? [], child.spec.initContainers)
        : parent.spec.initContainers,

      volumes: child.spec.volumes !== undefined
        ? mergeVolumesById(parent.spec.volumes, child.spec.volumes)
        : parent.spec.volumes,

      priority: child.spec.priority !== undefined
        ? child.spec.priority
        : parent.spec.priority,

      nodeSelector: child.spec.nodeSelector !== undefined
        ? child.spec.nodeSelector
        : parent.spec.nodeSelector,

      terminationGracePeriodSeconds: child.spec.terminationGracePeriodSeconds !== undefined
        ? child.spec.terminationGracePeriodSeconds
        : parent.spec.terminationGracePeriodSeconds,

      dnsConfig: child.spec.dnsConfig !== undefined
        ? child.spec.dnsConfig
        : parent.spec.dnsConfig,

      hostAliases: child.spec.hostAliases !== undefined
        ? child.spec.hostAliases
        : parent.spec.hostAliases,

      secretRefs: child.spec.secretRefs !== undefined
        ? child.spec.secretRefs
        : parent.spec.secretRefs,

      resolvedSecrets: child.spec.resolvedSecrets !== undefined
        ? { ...(parent.spec.resolvedSecrets ?? {}), ...child.spec.resolvedSecrets }
        : parent.spec.resolvedSecrets,

      secretMounts: child.spec.secretMounts !== undefined
        ? mergeSecretMountsByIdentity(parent.spec.secretMounts, child.spec.secretMounts)
        : parent.spec.secretMounts,

      topologySpreadConstraints: child.spec.topologySpreadConstraints !== undefined
        ? child.spec.topologySpreadConstraints
        : parent.spec.topologySpreadConstraints,

      affinity: child.spec.affinity !== undefined
        ? child.spec.affinity
        : parent.spec.affinity,

      tolerations: child.spec.tolerations !== undefined
        ? child.spec.tolerations
        : parent.spec.tolerations,

      preemptionPolicy: child.spec.preemptionPolicy !== undefined
        ? child.spec.preemptionPolicy
        : parent.spec.preemptionPolicy,
    },

    providerOverrides: child.providerOverrides !== undefined
      ? { ...(parent.providerOverrides ?? {}), ...child.providerOverrides }
      : parent.providerOverrides,
  };
}

// ─── Internal helpers ──────────────────────────────────────────────────────

/** Field-level deep merge: child's fields win, omitted fields inherit from parent.
 *  CEA: if ContainerSpec grows a field, the line below errors — forcing this
 *  function to handle it explicitly. */
function mergeContainerSpec(parent: ContainerSpec, child: ContainerSpec): ContainerSpec {
  return {
    name: child.name,
    image: child.image ?? parent.image,
    command: child.command ?? parent.command,
    args: child.args ?? parent.args,
    env: child.env ?? parent.env,
    resources: child.resources ?? parent.resources,
    ports: child.ports ?? parent.ports,
    volumeMounts: child.volumeMounts ?? parent.volumeMounts,
    livenessProbe: child.livenessProbe ?? parent.livenessProbe,
    readinessProbe: child.readinessProbe ?? parent.readinessProbe,
    startupProbe: child.startupProbe ?? parent.startupProbe,
    imagePullPolicy: child.imagePullPolicy ?? parent.imagePullPolicy,
    tty: child.tty ?? parent.tty,
    stdin: child.stdin ?? parent.stdin,
    networkMode: child.networkMode ?? parent.networkMode,
    providerOverrides: child.providerOverrides ?? parent.providerOverrides,
    // CEA: all ContainerSpec fields must appear above — add new fields here
  } satisfies Record<keyof ContainerSpec, unknown>;
}

function mergeContainersByIdentity(
  parent: readonly ContainerSpec[],
  child: readonly ContainerSpec[],
): ContainerSpec[] {
  const map = new Map<string, ContainerSpec>();
  for (const c of parent) map.set(c.name, c);
  for (const c of child) {
    const existing = map.get(c.name);
    map.set(c.name, existing ? mergeContainerSpec(existing, c) : c);
  }
  return Array.from(map.values());
}

function mergeVolumesById(
  parent: readonly VolumeSpec[] | undefined,
  child: readonly VolumeSpec[],
): VolumeSpec[] {
  const map = new Map<string, VolumeSpec>();
  if (parent) {
    for (const v of parent) map.set(v.id, v);
  }
  for (const v of child) map.set(v.id, v);
  return Array.from(map.values());
}

function mergeSecretMountsByIdentity(
  parent: readonly SecretMountConfig[] | undefined,
  child: readonly SecretMountConfig[],
): SecretMountConfig[] {
  // Use mountPath as the identity key (no explicit `name` field on SecretMountConfig)
  const map = new Map<string, SecretMountConfig>();
  if (parent) {
    for (const s of parent) map.set(s.mountPath, s);
  }
  for (const s of child) map.set(s.mountPath, s);
  return Array.from(map.values());
}
