// ─── OCI Runtime interface ───
// Low-level container runtime abstraction.
// Cloud orchestration creates instances → OCI Runtime manages them.

import type {
  ContainerId,
  OciContainer,
  OciContainerStatus,
} from '../../core/provider/types.ts';
import type {
  OciImageRef,
  OciImageInfo,
  OciCreateSpec,
  OciLogOptions,
} from './types.ts';

export interface IOCIRuntime {
  /** Pull a container image from a registry. */
  pullImage(image: OciImageRef): Promise<OciImageInfo>;

  /** List locally available images. */
  listImages(): Promise<readonly OciImageInfo[]>;

  /** Remove a locally cached image. */
  removeImage(image: OciImageRef): Promise<void>;

  /** Create a new container from an image (does not start it). */
  createContainer(spec: OciCreateSpec): Promise<OciContainer>;

  /** Start an existing container. Assigns IP, PID, begins health checks. */
  startContainer(id: ContainerId): Promise<void>;

  /** Stop a running container (graceful shutdown with timeout). */
  stopContainer(id: ContainerId, timeoutSeconds?: number): Promise<void>;

  /** Force-kill a container. */
  killContainer(id: ContainerId, signal?: string): Promise<void>;

  /** Pause a running container (freeze cgroups). */
  pauseContainer(id: ContainerId): Promise<void>;

  /** Unpause a paused container. */
  unpauseContainer(id: ContainerId): Promise<void>;

  /** Remove a stopped container. */
  removeContainer(id: ContainerId): Promise<void>;

  /** Get detailed container state, including current health status. */
  inspectContainer(id: ContainerId): Promise<OciContainer | null>;

  /** List all containers, optionally filtered by status. */
  listContainers(status?: OciContainerStatus): Promise<readonly OciContainer[]>;

  /** Fetch container console logs (stdout/stderr). */
  getLogs(id: ContainerId, options?: OciLogOptions): Promise<string>;
}
