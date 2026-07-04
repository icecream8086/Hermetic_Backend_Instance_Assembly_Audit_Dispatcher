import type { PodSpec as AssemblyPodSpec, ServiceDefinition } from './assembly/types.ts';
import type { PodSpec, ContainerSpec, VolumeSpec } from '../../core/pod/types.ts';
import type { VolumeMountConfig } from '../../core/provider/types.ts';

export function assemblyToCorePodSpec(assembly: AssemblyPodSpec): PodSpec {
  const names = Object.keys(assembly.services);

  const allVolumeMounts = collectVolumeMounts(assembly.services);

  const containers: ContainerSpec[] = names.map((name, index) => {
    const svc = assembly.services[name]!;
    const cmd = normalizeCommand(svc.command);
    const env = svc.environment
      ? Object.entries(svc.environment).map(([k, v]) => ({ name: k, value: v }))
      : undefined;
    const cpu = svc.resources?.cpu ? parseFloat(svc.resources.cpu) : 1;
    const memory = svc.resources?.memory ? parseMemoryString(svc.resources.memory) : 2048;

    return {
      name: `${assembly.name}-${name}`,
      image: svc.image,
      ...(cmd.command ? { command: cmd.command } : {}),
      ...(cmd.args ? { args: cmd.args } : {}),
      ...(env ? { env } : {}),
      ...(svc.ports ? { ports: svc.ports.map(p => ({ containerPort: p.containerPort, ...(p.protocol ? { protocol: p.protocol } : {}) })) } : {}),
      resources: { limits: { cpu, memory } },
      ...(index === 0 && allVolumeMounts.length > 0 ? { volumeMounts: allVolumeMounts } : {}),
    };
  });

  const volumeSpecs = collectVolumeSpecs(assembly.services);

  return {
    metadata: {
      name: assembly.name,
      ...(assembly.labels ? { labels: assembly.labels } : {}),
    },
    spec: {
      containers,
      restartPolicy: 'Never',
      ...(volumeSpecs.length > 0 ? { volumes: volumeSpecs } : {}),
    },
    providerOverrides: {
      alibaba: {
        region: assembly.region ?? 'cn-hangzhou',
        ...(assembly.instanceId ? { instanceId: assembly.instanceId } : {}),
      },
    },
  };
}

function normalizeCommand(cmd: ServiceDefinition['command']): { command?: string[]; args?: string[] } {
  if (!cmd) return {};
  if (typeof cmd === 'string') return { command: ['/bin/sh', '-c'], args: [cmd] };
  if (Array.isArray(cmd)) {
    if (cmd.length === 0) return {};
    return { command: cmd };
  }
  return {};
}

function parseMemoryString(s: string): number {
  const match = s.match(/^(\d+)\s*(Gi|Mi|Ki|G|M|K)?$/i);
  if (!match) return 2048;
  const val = parseInt(match[1]!, 10);
  const unit = (match[2] ?? 'Mi').toLowerCase();
  switch (unit) {
    case 'gi': case 'g': return val * 1024;
    case 'mi': case 'm': return val;
    case 'ki': case 'k': return Math.ceil(val / 1024);
    default: return val;
  }
}

function collectVolumeSpecs(services: Record<string, ServiceDefinition>): VolumeSpec[] {
  const specs: VolumeSpec[] = [];
  const seen = new Set<string>();
  for (const svc of Object.values(services)) {
    if (!svc.volumes) continue;
    for (const vol of svc.volumes) {
      if (!seen.has(vol.source)) {
        seen.add(vol.source);
        specs.push({
          id: vol.source,
          type: 'EmptyDirVolume',
          options: {},
        });
      }
    }
  }
  return specs;
}

function collectVolumeMounts(services: Record<string, ServiceDefinition>): VolumeMountConfig[] {
  const mounts: VolumeMountConfig[] = [];
  for (const svc of Object.values(services)) {
    if (!svc.volumes) continue;
    for (const vol of svc.volumes) {
      mounts.push({
        volumeId: vol.source,
        mountPath: vol.destination ?? '/mnt/' + vol.source,
        readOnly: vol.readOnly ?? false,
      });
    }
  }
  return mounts;
}
