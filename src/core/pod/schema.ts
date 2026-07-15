import { z } from 'zod';

export const EnvVarSchema = z.object({
  name: z.string().min(1),
  value: z.string().optional(),
  valueFrom: z.unknown().optional(),
});

export const ContainerPortSchema = z.object({
  containerPort: z.number().int().positive(),
  hostPort: z.number().int().optional(),
  protocol: z.string().optional(),
});

export const VolumeMountSchema = z.object({
  volumeId: z.string().min(1),
  mountPath: z.string().min(1),
  readOnly: z.boolean(),
  mountPropagation: z.string().optional(),
  credentialRef: z.string().optional(),
});

export const ProbeSpecSchema = z.object({
  httpGet: z.object({
    path: z.string(),
    port: z.number(),
    scheme: z.string().optional(),
  }).optional(),
  tcpSocket: z.object({
    port: z.number(),
  }).optional(),
  exec: z.object({
    command: z.array(z.string()).readonly(),
  }).optional(),
  initialDelaySeconds: z.number().optional(),
  periodSeconds: z.number().optional(),
  timeoutSeconds: z.number().optional(),
  successThreshold: z.number().optional(),
  failureThreshold: z.number().optional(),
});

export const ContainerSpecSchema = z.object({
  name: z.string().min(1),
  image: z.string().min(1),
  command: z.array(z.string()).readonly().optional(),
  args: z.array(z.string()).readonly().optional(),
  env: z.array(EnvVarSchema).readonly().optional(),
  resources: z.object({
    limits: z.object({
      cpu: z.number(),
      memory: z.number(),
      gpu: z.number().optional(),
    }).optional(),
  }).optional(),
  ports: z.array(ContainerPortSchema).readonly().optional(),
  volumeMounts: z.array(VolumeMountSchema).readonly().optional(),
  livenessProbe: ProbeSpecSchema.optional(),
  readinessProbe: ProbeSpecSchema.optional(),
  startupProbe: ProbeSpecSchema.optional(),
  imagePullPolicy: z.string().optional(),
  tty: z.boolean().optional(),
  stdin: z.boolean().optional(),
  networkMode: z.string().optional(),
  providerOverrides: z.record(z.string(), z.unknown()).optional(),
});

export const VolumeSpecSchema = z.object({
  id: z.string().min(1),
  type: z.enum(['NFSVolume', 'EmptyDirVolume', 'DiskVolume', 'SecretVolume', 'ConfigMapVolume', 'OSSVolume']),
  options: z.record(z.string(), z.unknown()).optional(),
});

export const PodSpecSchema = z.object({
  metadata: z.object({
    name: z.string().min(1),
    labels: z.record(z.string(), z.string()).optional(),
    annotations: z.record(z.string(), z.string()).optional(),
  }),
  spec: z.object({
    containers: z.array(ContainerSpecSchema).min(1).readonly(),
    initContainers: z.array(ContainerSpecSchema).readonly().optional(),
    volumes: z.array(VolumeSpecSchema).readonly().optional(),
    restartPolicy: z.enum(['Always', 'OnFailure', 'Never']),
    priority: z.number().optional(),
    nodeSelector: z.record(z.string(), z.string()).optional(),
    terminationGracePeriodSeconds: z.number().optional(),
    secretRefs: z.array(z.object({
      secretName: z.string(),
      mountPath: z.string(),
      keys: z.array(z.string()).readonly().optional(),
      mode: z.number().optional(),
    })).readonly().optional(),
    resolvedSecrets: z.record(z.string(), z.object({
      value: z.string().optional(),
      platformRefs: z.object({
        eci: z.string().optional(),
        k8s: z.string().optional(),
        podman: z.string().optional(),
        aws: z.string().optional(),
      }).optional(),
    })).optional(),
    secretMounts: z.array(z.object({
      mountPath: z.string(),
      data: z.string(),
      mode: z.number().optional(),
    })).readonly().optional(),
  }),
  providerOverrides: z.record(z.string(), z.unknown()).optional(),
});

export const AlibabaOverridesSchema = z.object({
  region: z.string().optional(),
  securityGroupId: z.string().optional(),
  vSwitchId: z.string().optional(),
  subnetIds: z.array(z.string()).optional(),
  autoCreateEip: z.union([z.boolean(), z.string()]).optional(),
  spotStrategy: z.string().optional(),
  spotPriceLimit: z.number().optional(),
  ramRoleName: z.string().optional(),
  resourceGroupId: z.string().optional(),
  activeDeadlineSeconds: z.number().optional(),
  instanceId: z.string().optional(),
  instanceType: z.string().optional(),
  eipBandwidth: z.number().optional(),
  account: z.string().optional(),
  healthMaxRetries: z.number().optional(),
  apiVersion: z.string().optional(),
  description: z.string().optional(),
  zoneId: z.string().optional(),
}).passthrough();

export const PodSpecPatchSchema = z.object({
  metadata: z.object({
    name: z.string().optional(),
    labels: z.record(z.string(), z.string()).optional(),
    annotations: z.record(z.string(), z.string()).optional(),
  }).optional(),
  spec: z.object({
    containers: z.array(ContainerSpecSchema).readonly().optional(),
    restartPolicy: z.enum(['Always', 'OnFailure', 'Never']).optional(),
  }).optional(),
  providerOverrides: z.record(z.string(), z.unknown()).optional(),
});

export const PodNetworkSchema = z.object({
  privateIp: z.string().optional(),
  publicIp: z.string().optional(),
  vpcId: z.string().optional(),
  subnetId: z.string().optional(),
  securityGroupId: z.string().optional(),
});

export const ConditionStatusSchema = z.enum(['True', 'False', 'Unknown']);

export const ContainerStateSchema = z.discriminatedUnion('state', [
  z.object({
    state: z.literal('Waiting'),
    reason: z.string().optional(),
  }),
  z.object({
    state: z.literal('Running'),
    startedAt: z.string(),
  }),
  z.object({
    state: z.literal('Terminated'),
    exitCode: z.number(),
    reason: z.string().optional(),
    signal: z.number().optional(),
    startedAt: z.string().optional(),
    finishedAt: z.string().optional(),
  }),
]);

export const PodConditionSchema = z.object({
  type: z.enum(['PodScheduled', 'Initialized', 'ContainersReady', 'Ready', 'DisruptionTarget']),
  status: ConditionStatusSchema,
  reason: z.string().optional(),
  message: z.string().optional(),
  lastTransitionTime: z.number(),
});

export const ContainerRuntimeSchema = z.object({
  name: z.string(),
  image: z.string(),
  state: ContainerStateSchema,
  env: z.record(z.string(), z.string()),
  ports: z.array(z.object({
    containerPort: z.number(),
    hostPort: z.number().optional(),
    protocol: z.string().optional(),
  })).readonly().optional(),
  resources: z.object({
    cpu: z.number(),
    memory: z.number(),
    gpu: z.number().optional(),
  }).optional(),
  labels: z.record(z.string(), z.string()),
  annotations: z.record(z.string(), z.string()),
  mounts: z.array(z.object({
    source: z.string(),
    destination: z.string(),
    type: z.string().optional(),
  })).readonly(),
});

export const PodEventSchema = z.object({
  reason: z.string(),
  message: z.string(),
  type: z.string(),
  count: z.number(),
});
