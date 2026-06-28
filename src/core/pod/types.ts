/**
 * Universal Pod abstraction — K8s-aligned, provider-agnostic.
 *
 * Design (CEA):
 * - PodSpec is the single source of truth for container group creation.
 * - Provider-specific extensions live in `providerOverrides` (free-form).
 * - PodPhase / PodCondition / ContainerState follow the K8s Pod model (013).
 * - SandboxStatus (11) is the internal provider-level detail;
 *   π: SandboxStatus → PodPhase projection defined below (018 §8).
 */

import type { EnvVar, ProbeSpec, ContainerPortConfig, VolumeMountConfig } from '../provider/types.ts';
export type { ProbeSpec };
import { SandboxStatus } from '../../features/sandbox/types.ts';

// ═══════════════════════════════════════════════════════════════
// Pod Identity
// ═══════════════════════════════════════════════════════════════

declare const POD_ID_BRAND: unique symbol;
export type PodId = string & { readonly [POD_ID_BRAND]: true };

export function createPodId(raw: string): PodId { if (!raw) throw new TypeError('PodId must not be empty'); return raw as PodId; }

// ═══════════════════════════════════════════════════════════════
// PodPhase — K8s Pod Phase (013 §1.1)
// ═══════════════════════════════════════════════════════════════

export type PodPhase =
  | 'Pending'
  | 'Running'
  | 'Succeeded'
  | 'Failed'
  | 'Unknown';

// ═══════════════════════════════════════════════════════════════
// PodCondition — K8s Pod Conditions (013 §1.2)
// ═══════════════════════════════════════════════════════════════

export type ConditionStatus = 'True' | 'False' | 'Unknown';

export interface PodCondition {
  readonly type: 'PodScheduled' | 'Initialized' | 'ContainersReady' | 'Ready' | 'DisruptionTarget';
  readonly status: ConditionStatus;
  readonly reason?: string | undefined;
  readonly message?: string | undefined;
  readonly lastTransitionTime: number;
}

// ═══════════════════════════════════════════════════════════════
// ContainerState — K8s Container State (013 §1.3)
// ═══════════════════════════════════════════════════════════════

export type ContainerState =
  | { readonly state: 'Waiting'; readonly reason?: string | undefined }
  | { readonly state: 'Running'; readonly startedAt: string }
  | { readonly state: 'Terminated'; readonly exitCode: number; readonly reason?: string | undefined; readonly signal?: number | undefined; readonly startedAt?: string | undefined; readonly finishedAt?: string | undefined };

// ═══════════════════════════════════════════════════════════════
// PodSpec — K8s-aligned creation input
// ═══════════════════════════════════════════════════════════════

export interface ContainerSpec {
  readonly name: string;
  readonly image: string;
  readonly command?: readonly string[] | undefined;
  readonly args?: readonly string[] | undefined;
  readonly env?: readonly EnvVar[] | undefined;
  readonly resources?: {
    readonly limits?: { readonly cpu: number; readonly memory: number; readonly gpu?: number | undefined } | undefined;
  } | undefined;
  readonly ports?: readonly ContainerPortConfig[] | undefined;
  readonly volumeMounts?: readonly VolumeMountConfig[] | undefined;
  readonly livenessProbe?: ProbeSpec | undefined;
  readonly readinessProbe?: ProbeSpec | undefined;
  readonly startupProbe?: ProbeSpec | undefined;
  readonly imagePullPolicy?: string | undefined;
  readonly tty?: boolean | undefined;
  readonly stdin?: boolean | undefined;
  readonly networkMode?: string | undefined;
  readonly providerOverrides?: Record<string, unknown> | undefined;
}

export interface VolumeSpec {
  readonly id: string;
  readonly type: 'NFSVolume' | 'HostPathVolume' | 'EmptyDirVolume' | 'DiskVolume' | 'SecretVolume' | 'ConfigMapVolume';
  readonly options?: Record<string, unknown> | undefined;
}

export interface PodSpec {
  readonly metadata: {
    readonly name: string;
    readonly labels?: Record<string, string> | undefined;
    readonly annotations?: Record<string, string> | undefined;
  };
  readonly spec: {
    readonly containers: readonly ContainerSpec[];
    readonly initContainers?: readonly ContainerSpec[] | undefined;
    readonly volumes?: readonly VolumeSpec[] | undefined;
    readonly restartPolicy: 'Always' | 'OnFailure' | 'Never';
    /** Scheduling priority. Higher values = more important.
     *  ECI: injected as HBI_PRIORITY env var on each container.
     *  Podman: used for pod creation ordering. */
    readonly priority?: number | undefined;
    /** Simple node affinity labels. Provider matches against instance labels.
     *  ECI: ignored (no node concept). Podman: matched against instance metadata. */
    readonly nodeSelector?: Record<string, string> | undefined;
    readonly terminationGracePeriodSeconds?: number | undefined;
    readonly dnsConfig?: {
      readonly nameservers?: readonly string[] | undefined;
      readonly searches?: readonly string[] | undefined;
      readonly options?: readonly { readonly name: string; readonly value?: string | undefined }[] | undefined;
    } | undefined;
    readonly hostAliases?: readonly { readonly ip: string; readonly hostnames: readonly string[] }[] | undefined;
  };
  readonly providerOverrides?: Record<string, unknown> | undefined;
}

// ═══════════════════════════════════════════════════════════════
// ContainerRuntime — per-container state
// ═══════════════════════════════════════════════════════════════

export interface ContainerRuntime {
  readonly name: string;
  readonly image: string;
  readonly state: ContainerState;
  readonly env: Record<string, string>;
  readonly ports?: readonly { readonly containerPort: number; readonly hostPort?: number | undefined; readonly protocol?: string | undefined }[] | undefined;
  readonly resources?: { readonly cpu: number; readonly memory: number; readonly gpu?: number | undefined } | undefined;
  readonly labels: Record<string, string>;
  readonly annotations: Record<string, string>;
  readonly mounts: readonly { readonly source: string; readonly destination: string; readonly type?: string | undefined }[];
}

export interface PodNetwork {
  readonly privateIp?: string | undefined;
  readonly publicIp?: string | undefined;
  readonly vpcId?: string | undefined;
  readonly subnetId?: string | undefined;
  readonly securityGroupId?: string | undefined;
}

export interface PodEvent {
  readonly reason: string;
  readonly type: string;
  readonly message: string;
  readonly count: number;
}

// ═══════════════════════════════════════════════════════════════
// PodEntity — persisted pod with OCC versioning
// ═══════════════════════════════════════════════════════════════

export interface PodEntity {
  readonly podId: PodId;
  readonly name: string;
  readonly spec: PodSpec;
  readonly phase: PodPhase;
  readonly providerId?: string | undefined;
  readonly network: PodNetwork;
  readonly containers: readonly ContainerRuntime[];
  readonly conditions: readonly PodCondition[];
  readonly events: readonly PodEvent[];
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly version: string;
  readonly creatorId?: string | undefined;
  readonly templateRef?: string | undefined;
}

// ═══════════════════════════════════════════════════════════════
// PodRuntime — provider-agnostic runtime view (decoded from provider)
// ═══════════════════════════════════════════════════════════════

export interface PodRuntime {
  readonly podId: PodId;
  readonly providerId: string;
  readonly name: string;
  readonly phase: PodPhase;
  readonly conditions: readonly PodCondition[];
  readonly containers: readonly ContainerRuntime[];
  readonly volumes: readonly { readonly name: string; readonly type: string }[];
  readonly events: readonly PodEvent[];
  readonly network: PodNetwork;
  readonly createdAt?: string | undefined;
}

// ═══════════════════════════════════════════════════════════════
// π: SandboxStatus → PodPhase (SPEC 018 §8)
// ═══════════════════════════════════════════════════════════════

/**
 * Project internal SandboxStatus (11) to K8s-standard PodPhase (5).
 * ECI is a refinement of K8s — each K8s phase decomposes into ECI sub-states.
 */
export function sandboxStatusToPodPhase(status: SandboxStatus): PodPhase | null {
  switch (status) {
    case SandboxStatus.Scheduling:
    case SandboxStatus.ScheduleFailed:
    case SandboxStatus.Pending:
      return 'Pending';
    case SandboxStatus.Running:
    case SandboxStatus.Restarting:
    case SandboxStatus.Updating:
    case SandboxStatus.Terminating:
      return 'Running';
    case SandboxStatus.Succeeded:
      return 'Succeeded';
    case SandboxStatus.Failed:
    case SandboxStatus.Expired:
      return 'Failed';
    case SandboxStatus.Deleted:
      return null;
  }
}
