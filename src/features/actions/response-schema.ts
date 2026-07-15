import { z } from 'zod';

// ─── Trigger config ───

export const TriggerConfigResponseSchema = z.object({
  push: z.object({ branches: z.array(z.string()).readonly().optional() }).optional(),
  cron: z.string().optional(),
  manual: z.boolean().optional(),
  http: z.object({ signatureSecret: z.string().optional() }).optional(),
});

// ─── Container config ───

export const ActionContainerConfigResponseSchema = z.object({
  image: z.string(),
  command: z.array(z.string()).readonly().optional(),
  args: z.array(z.string()).readonly().optional(),
  env: z.record(z.string(), z.string()).optional(),
  ports: z.array(z.object({
    containerPort: z.number(),
    hostPort: z.number().optional(),
    protocol: z.enum(['tcp', 'udp']).optional(),
  })).readonly().optional(),
  resources: z.object({ cpu: z.number().optional(), memory: z.number().optional() }).optional(),
  workingDir: z.string().optional(),
  livenessProbe: z.object({
    httpGet: z.object({ port: z.number(), path: z.string().optional() }).optional(),
    initialDelaySeconds: z.number().optional(),
    periodSeconds: z.number().optional(),
  }).optional(),
});

// ─── Step definition ───

export const StepDefResponseSchema = z.object({
  name: z.string().optional(),
  id: z.string().optional(),
  run: z.string().optional(),
  uses: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
  timeout: z.number().optional(),
  continueOnError: z.boolean().optional(),
  shell: z.string().optional(),
  with: z.record(z.string(), z.string()).optional(),
  dns: z.object({
    action: z.enum(['upsert', 'delete']),
    type: z.enum(['A', 'CNAME', 'TXT']),
    name: z.string(),
    value: z.string(),
    ttl: z.number().optional(),
    proxied: z.boolean().optional(),
    zoneId: z.string(),
  }).optional(),
  _type: z.string().optional(),
});

// ─── Job definition ───

export const JobDefResponseSchema = z.object({
  name: z.string(),
  runsOn: z.string().optional(),
  needs: z.array(z.string()).readonly().optional(),
  steps: z.array(StepDefResponseSchema).readonly(),
  env: z.record(z.string(), z.string()).optional(),
  timeout: z.number().optional(),
  if: z.string().optional(),
  container: ActionContainerConfigResponseSchema.optional(),
  containers: z.array(ActionContainerConfigResponseSchema.extend({ name: z.string() })).readonly().optional(),
  instanceId: z.string().optional(),
  region: z.string().optional(),
  approval: z.object({
    approvers: z.array(z.string()).readonly(),
    message: z.string().optional(),
  }).optional(),
  cache: z.object({
    key: z.string(),
    paths: z.array(z.string()).readonly(),
    scope: z.enum(['branch', 'job', 'os']).optional(),
  }).optional(),
});

// ─── Workflow definition (response) ───

export const WorkflowDefResponseSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  on: TriggerConfigResponseSchema,
  env: z.record(z.string(), z.string()).optional(),
  jobs: z.record(z.string(), JobDefResponseSchema),
  orgId: z.string().optional(),
  projectId: z.string().optional(),
  ownerId: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  annotations: z.record(z.string(), z.string()).optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
  version: z.string(),
}).openapi({ ref: 'WorkflowDef' });

// ─── Step run (inside JobRun) ───

export const StepRunResponseSchema = z.object({
  name: z.string(),
  status: z.enum(['Queued', 'Running', 'Success', 'Failure', 'Skipped', 'Cancelled']),
  startedAt: z.number().optional(),
  completedAt: z.number().optional(),
  exitCode: z.number().optional(),
  output: z.string().optional(),
  error: z.string().optional(),
});

// ─── Workflow run (response) ───

export const WorkflowRunResponseSchema = z.object({
  id: z.string(),
  workflowId: z.string(),
  status: z.enum(['Pending', 'Running', 'Success', 'Failure', 'Cancelled', 'TimedOut']),
  trigger: z.enum(['manual', 'cron', 'http', 'webhook', 'shared_link']),
  triggerPayload: z.unknown().optional(),
  env: z.record(z.string(), z.string()),
  jobRunRefs: z.array(z.object({ jobName: z.string(), jobRunId: z.string() })).readonly(),
  ownerId: z.string().optional(),
  startedAt: z.number(),
  completedAt: z.number().optional(),
  error: z.string().optional(),
  version: z.string(),
}).openapi({ ref: 'WorkflowRun' });

// ─── Job run (response) ───

export const JobRunResponseSchema = z.object({
  id: z.string(),
  workflowRunId: z.string(),
  jobName: z.string(),
  status: z.enum(['Queued', 'Running', 'Success', 'Failure', 'Skipped', 'Cancelled']),
  podId: z.string().optional(),
  attempts: z.number(),
  stepRuns: z.array(StepRunResponseSchema).readonly(),
  startedAt: z.number().optional(),
  completedAt: z.number().optional(),
  error: z.string().optional(),
  version: z.string(),
}).openapi({ ref: 'JobRun' });

// ─── DAG visualization response ───

export const DagNodeResponseSchema = z.object({
  id: z.string(),
  label: z.string(),
  status: z.string(),
  startedAt: z.number().optional(),
  completedAt: z.number().optional(),
  stepCount: z.number(),
  completedSteps: z.number(),
});

export const DagEdgeResponseSchema = z.object({
  from: z.string(),
  to: z.string(),
});

export const DagResponseSchema = z.object({
  workflowName: z.string(),
  status: z.string(),
  trigger: z.string(),
  startedAt: z.number(),
  completedAt: z.number().optional(),
  nodes: z.array(DagNodeResponseSchema).readonly(),
  edges: z.array(DagEdgeResponseSchema).readonly(),
});

// ─── Step log result ───

export const StepLogResultSchema = z.object({
  text: z.string(),
  totalBytes: z.number(),
  offset: z.number(),
  limit: z.number(),
});

// ─── Action definition (registry) ───

export const ActionDefResponseSchema = z.object({
  id: z.string(),
  name: z.string(),
  version: z.string(),
  description: z.string().optional(),
  inputs: z.record(z.string(), z.object({
    description: z.string().optional(),
    required: z.boolean().optional(),
    default: z.string().optional(),
  })).optional(),
  outputs: z.record(z.string(), z.object({ description: z.string().optional() })).optional(),
  runs: z.object({
    using: z.enum(['container', 'node']),
    main: z.string().optional(),
    image: z.string().optional(),
  }),
  createdAt: z.number(),
  updatedAt: z.number(),
  versionId: z.string(),
});

// ─── Organization ───

export const OrgResponseSchema = z.object({
  id: z.string(),
  name: z.string(),
  displayName: z.string().optional(),
  ownerId: z.string(),
  memberIds: z.array(z.string()).readonly(),
  adminIds: z.array(z.string()).readonly(),
  projectIds: z.array(z.string()).readonly(),
  quotas: z.object({
    maxWorkflows: z.number(),
    maxRunners: z.number(),
    maxConcurrentRuns: z.number(),
    maxSharedLinks: z.number(),
    maxSecretsPerWorkflow: z.number(),
  }),
  metadata: z.record(z.string(), z.unknown()).optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
  version: z.string(),
});

// ─── Project ───

export const ProjectResponseSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  name: z.string(),
  displayName: z.string().optional(),
  ownerId: z.string(),
  memberIds: z.array(z.string()).readonly(),
  quotas: z.object({
    maxWorkflows: z.number(),
    maxRunners: z.number(),
    maxConcurrentRuns: z.number(),
    maxSharedLinks: z.number(),
    maxSecretsPerWorkflow: z.number(),
  }),
  metadata: z.record(z.string(), z.unknown()).optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
  version: z.string(),
});

// ─── Approval node ───

export const ApprovalNodeResponseSchema = z.object({
  id: z.string(),
  workflowRunId: z.string(),
  jobName: z.string(),
  approvers: z.array(z.string()).readonly(),
  status: z.enum(['pending', 'approved', 'rejected']),
  reason: z.string().optional(),
  requestedAt: z.number(),
  decidedAt: z.number().optional(),
  decidedBy: z.string().optional(),
  version: z.string(),
});

// ─── Workflow secrets ───

export const WorkflowSecretCreatedResponseSchema = z.object({
  id: z.string(),
  key: z.string(),
  createdAt: z.number(),
});

export const WorkflowSecretListItemSchema = z.object({
  key: z.string(),
  id: z.string(),
});

// ─── Shared link (safe, without passwordHash) ───

export const SharedLinkSafeResponseSchema = z.object({
  id: z.string(),
  ownerId: z.string(),
  workflowId: z.string(),
  name: z.string(),
  expiresAt: z.number(),
  maxUses: z.number(),
  useCount: z.number(),
  concurrentMax: z.number(),
  defaultTtlSeconds: z.number(),
  enabled: z.boolean(),
  createdAt: z.number(),
  updatedAt: z.number(),
  version: z.string(),
});

// ─── Runner registration ───

export const RunnerRegistrationResponseSchema = z.object({
  id: z.string(),
  name: z.string(),
  instanceId: z.string().optional(),
  labels: z.record(z.string(), z.string()),
  capacity: z.object({
    cpu: z.number(),
    memory: z.number(),
    gpu: z.number().optional(),
  }),
  status: z.enum(['online', 'offline', 'draining']),
  version: z.string(),
  lastHeartbeat: z.number(),
  createdAt: z.number(),
  updatedAt: z.number(),
  storeVersion: z.string(),
});

// ─── Dashboard metrics ───

export const DashboardMetricsSchema = z.object({
  totalWorkflows: z.number(),
  totalRuns: z.number(),
  activeRuns: z.number(),
  successRate: z.number(),
  avgDurationMs: z.number(),
  runnersOnline: z.number(),
  byTrigger: z.record(z.string(), z.number()),
  byStatus: z.record(z.string(), z.number()),
  myRuns: z.number().optional(),
  mySuccessRate: z.number().optional(),
  myRecentRuns: z.array(z.object({
    id: z.string(),
    status: z.string(),
    trigger: z.string(),
    startedAt: z.number(),
  })).readonly().optional(),
});

// ─── Workspace response ───

export const WorkspaceMetaResponseSchema = z.object({
  workflowRunId: z.string(),
  jobName: z.string(),
  format: z.string(),
  sizeBytes: z.number(),
  fileCount: z.number(),
  createdAt: z.number(),
});

export const WorkspaceResponseSchema = z.object({
  meta: WorkspaceMetaResponseSchema,
  data: z.string(),
});

// ─── Templates ───

export const TemplateMetaResponseSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  category: z.enum(['ci', 'deploy', 'service', 'maintenance', 'test']),
  tags: z.array(z.string()).readonly(),
});

export const TemplateResponseSchema = TemplateMetaResponseSchema.extend({
  content: z.string(),
});

// ─── Paginated list response shapes ───

export const PaginatedWorkflowDefsSchema = z.object({
  items: z.array(WorkflowDefResponseSchema).readonly(),
  total: z.number(),
  page: z.number(),
  limit: z.number(),
});

export const PaginatedWorkflowRunsSchema = z.object({
  items: z.array(WorkflowRunResponseSchema).readonly(),
  total: z.number(),
  page: z.number(),
  limit: z.number(),
});

export const PaginatedActionDefsSchema = z.object({
  items: z.array(ActionDefResponseSchema).readonly(),
  total: z.number(),
  page: z.number(),
  limit: z.number(),
});

export const TemplateListResponseSchema = z.object({
  items: z.array(TemplateMetaResponseSchema).readonly(),
  total: z.number(),
});

// ─── Simple response shapes ───

export const DeletedResponseSchema = z.object({ deleted: z.boolean() });
export const OkTrueResponseSchema = z.object({ ok: z.boolean() });
export const DrainingResponseSchema = z.object({ draining: z.boolean() });
export const DisabledResponseSchema = z.object({ disabled: z.boolean() });
export const TriggeredWebhookResponseSchema = z.object({ triggered: z.array(z.string()).readonly(), count: z.number() });
export const ScheduleRunResponseSchema = z.object({
  dagRunId: z.string(),
  dagId: z.string(),
  status: z.string(),
  taskCount: z.number(),
});
export const LaunchResponseSchema = z.object({ runId: z.string(), status: z.string() });
