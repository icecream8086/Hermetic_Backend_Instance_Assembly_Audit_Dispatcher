// ─── OCI Runtime types ───
// Core OCI types (ContainerId, OciContainer, OciContainerStatus, etc.) live
// in core/provider/types.ts — cloud orchestration instances ARE OCI containers.
// This file extends with OCIRuntime-specific types (create spec, image info, logs).

import type { OciImageRef } from '../../core/provider/types.ts';
export type {
  ContainerId,
  OciContainer,
  OciContainerStatus,
  OciHealthStatus,
  OciImageRef,
} from '../../core/provider/types.ts';

export { createContainerId } from '../../core/provider/types.ts';

// ─── OCIRuntime-specific types (not needed by core/cloud layer) ───

export interface HealthCheckSpec {
  readonly test: readonly string[];
  readonly intervalSeconds?: number | undefined;
  readonly timeoutSeconds?: number | undefined;
  readonly retries?: number | undefined;
  readonly startPeriodSeconds?: number | undefined;
}

export interface OciImageInfo {
  readonly ref: OciImageRef;
  readonly digest?: string;
  readonly size?: number;
  readonly pulledAt?: string;
}

export interface OciCreateSpec {
  readonly name: string;
  readonly image: OciImageRef;
  readonly args?: readonly string[] | undefined;
  readonly env?: Record<string, string> | undefined;
  readonly workingDir?: string | undefined;
  readonly labels?: Record<string, string> | undefined;
  readonly annotations?: Record<string, string> | undefined;
  readonly mounts?: readonly {
    readonly source: string;
    readonly destination: string;
    readonly type?: string | undefined;
    readonly options?: readonly string[] | undefined;
  }[] | undefined;
  readonly ports?: readonly {
    readonly containerPort: number;
    readonly hostPort?: number | undefined;
    readonly protocol: 'tcp' | 'udp';
  }[] | undefined;
  readonly resources?: {
    readonly cpu?: number | undefined;
    readonly memory?: number | undefined;
    readonly pids?: number | undefined;
  } | undefined;
  readonly healthCheck?: HealthCheckSpec | undefined;
}

export interface OciLogOptions {
  readonly tail?: number | undefined;
  readonly since?: string | undefined;
  readonly timestamps?: boolean | undefined;
  readonly follow?: boolean | undefined;
}
