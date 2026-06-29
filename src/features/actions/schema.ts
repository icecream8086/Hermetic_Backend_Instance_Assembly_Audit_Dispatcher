import { z } from 'zod';

// ─── Container ───

export const ActionContainerConfigSchema = z.object({
  image: z.string().min(1),
  command: z.array(z.string()).optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  ports: z.array(z.object({
    containerPort: z.number().int().min(1).max(65535),
    hostPort: z.number().int().min(1).max(65535).optional(),
    protocol: z.enum(['tcp', 'udp']).optional(),
  })).optional(),
  resources: z.object({
    cpu: z.number().min(0.1).optional(),
    memory: z.number().int().min(64).optional(),
  }).optional(),
  workingDir: z.string().optional(),
  livenessProbe: z.object({
    httpGet: z.object({ port: z.number().int().min(1), path: z.string().optional() }).optional(),
    initialDelaySeconds: z.number().optional(),
    periodSeconds: z.number().optional(),
  }).optional(),
});

// ─── Steps ───

export const RunStepDefSchema = z.object({
  name: z.string().optional(),
  id: z.string().optional(),
  run: z.string().min(1),
  env: z.record(z.string(), z.string()).optional(),
  timeout: z.number().int().min(1).optional(),
  continueOnError: z.boolean().optional(),
  shell: z.string().optional(),
});

export const UsesStepDefSchema = z.object({
  name: z.string().optional(),
  id: z.string().optional(),
  uses: z.string().min(1),
  with: z.record(z.string(), z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  timeout: z.number().int().min(1).optional(),
  continueOnError: z.boolean().optional(),
});

export const DnsStepDefSchema = z.object({
  name: z.string().optional(),
  id: z.string().optional(),
  dns: z.object({
    action: z.enum(['upsert', 'delete']),
    type: z.enum(['A', 'CNAME', 'TXT']),
    name: z.string().min(1),
    value: z.string().min(1),
    ttl: z.number().int().min(1).max(86400).optional(),
    proxied: z.boolean().optional(),
    zoneId: z.string().min(1),
  }),
  timeout: z.number().int().min(1).optional(),
  continueOnError: z.boolean().optional(),
});

export const StepDefSchema = z.discriminatedUnion('_type', [
  RunStepDefSchema.extend({ _type: z.literal('run') }),
  UsesStepDefSchema.extend({ _type: z.literal('uses') }),
  DnsStepDefSchema.extend({ _type: z.literal('dns') }),
]).or(
  // Also accept without _type discriminator — we detect from fields
  z.union([
    RunStepDefSchema,
    UsesStepDefSchema,
    DnsStepDefSchema,
  ]),
);

// ─── Trigger ───

export const TriggerConfigSchema = z.object({
  push: z.object({ branches: z.array(z.string()).optional() }).optional(),
  cron: z.string().optional(),
  manual: z.boolean().optional(),
  http: z.object({ signatureSecret: z.string().optional() }).optional(),
});

// ─── Job ───

export const JobDefSchema = z.object({
  name: z.string().min(1).max(128),
  runsOn: z.string().optional(),
  needs: z.array(z.string()).optional(),
  steps: z.array(StepDefSchema),
  env: z.record(z.string(), z.string()).optional(),
  timeout: z.number().int().min(1).optional(),
  if: z.string().optional(),
  container: ActionContainerConfigSchema.optional(),
  containers: z.array(
    ActionContainerConfigSchema.extend({ name: z.string().min(1) }),
  ).min(1).optional(),
})
  .refine(
    data => data.container !== undefined || data.containers !== undefined,
    { message: 'Job must define either "container" (single) or "containers" (pod)', path: ['container'] },
  );

// ─── Workflow ───

export const CreateWorkflowSchema = z.object({
  name: z.string().min(1).max(256),
  description: z.string().optional(),
  on: TriggerConfigSchema,
  env: z.record(z.string(), z.string()).optional(),
  jobs: z.record(z.string(), JobDefSchema).refine(
    jobs => Object.keys(jobs).length > 0,
    'At least one job is required',
  ),
  orgId: z.string().optional(),
  projectId: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  annotations: z.record(z.string(), z.string()).optional(),
});

export const UpdateWorkflowSchema = z.object({
  name: z.string().min(1).max(256).optional(),
  description: z.string().nullable().optional(),
  on: TriggerConfigSchema.optional(),
  env: z.record(z.string(), z.string()).optional(),
  jobs: z.record(z.string(), JobDefSchema).optional(),
  orgId: z.string().optional(),
  projectId: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  annotations: z.record(z.string(), z.string()).optional(),
});

export const TriggerWorkflowSchema = z.object({
  inputs: z.record(z.string(), z.string()).optional(),
  payload: z.unknown().optional(),
});
