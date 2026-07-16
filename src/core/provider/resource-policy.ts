import type { ContainerCreateConfig } from './types.ts';

export interface ResourcePolicy {
  readonly minCpu: number;
  readonly minMemory: number;
  readonly ignoreEnvName: string;
  markIgnored(c: ContainerCreateConfig): ContainerCreateConfig;
  isIgnored(c: ContainerCreateConfig): boolean;
}

export class EciResourcePolicy implements ResourcePolicy {
  readonly minCpu = 0.25;
  /** MiB (0.5 GiB — ECI container minimum). */
  readonly minMemory = 512;
  readonly ignoreEnvName = '__ECI_RESOURCE_IGNORE__';

  markIgnored(c: ContainerCreateConfig): ContainerCreateConfig {
    const cpu = c.resources?.limits?.cpu ?? 0;
    const mem = c.resources?.limits?.memory ?? 0;
    if (cpu < this.minCpu || mem < this.minMemory) {
      return {
        ...c,
        env: [...(c.env ?? []), { name: this.ignoreEnvName, value: '1' }],
      };
    }
    return c;
  }

  isIgnored(c: ContainerCreateConfig): boolean {
    return c.env?.some(e => e.name === this.ignoreEnvName) ?? false;
  }
}

export class PodmanResourcePolicy implements ResourcePolicy {
  readonly minCpu = 0.01;
  readonly minMemory = 10;
  readonly ignoreEnvName = '';

  markIgnored(c: ContainerCreateConfig): ContainerCreateConfig {
    return c;
  }

  isIgnored(_c: ContainerCreateConfig): boolean {
    return false;
  }
}
