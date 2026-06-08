/**
 * Seed data manager — lazy background initialization for first-run setups.
 *
 * Seeding is deferred to run via ctx.waitUntil() in Worker mode, so the
 * first request is not blocked by ~100+ sequential atomic.set() calls.
 *
 * MAC rules are the exception: they must be available before the auth
 * middleware processes requests, so they are loaded (read-only) during
 * app assembly and only created if absent.
 */

import type { IAtomicStore } from './store/interfaces.ts';

async function seedPolicyLibrary(atomic: IAtomicStore): Promise<void> {
  const KEY = '_init:policy-lib';
  const entry = await atomic.get<any>(KEY);
  if (entry !== null) return; // already seeded

  const now = Date.now();
  let count = 0;

  // System groups (global, no user binding, evaluated first)
  const sysGroups = [
    { name: 'perm.sysadmin', desc: 'Full system access', rules: [{ effect: 'allow' as const, actions: ['*'], resource: '*', priority: 100 }] },
    { name: 'perm.operator', desc: 'Operational CRUD', rules: [{ effect: 'allow' as const, actions: ['create', 'read', 'update', 'delete'], priority: 80 }, { effect: 'deny' as const, actions: ['admin'], priority: 90 }] },
    { name: 'perm.viewer', desc: 'Read-only', rules: [{ effect: 'allow' as const, actions: ['read'], priority: 70 }] },
    { name: 'perm.auth', desc: 'Authentication only', rules: [{ effect: 'allow' as const, actions: ['login'], resource: 'session', priority: 60 }, { effect: 'deny' as const, actions: ['*'], resource: '*', priority: 50 }] },
  ];
  const sysGroupIds: Record<string, string> = {};
  for (const g of sysGroups) {
    const id = `sysgrp_${crypto.randomUUID()}`;
    sysGroupIds[g.name] = id;
    await atomic.set('sysgroup:' + id, { id, name: g.name, description: g.desc, rules: g.rules, priority: g.rules[0]!.priority, dependsOn: [], createdAt: now, updatedAt: now }, null);
    const shardIdx = Math.abs(Array.from(id).reduce((h, c) => ((h << 5) + h) + c.charCodeAt(0), 5381)) % 4;
    const sk = 'sysgroup:idx:' + shardIdx;
    const idx = await atomic.get<string[]>(sk);
    await atomic.set(sk, [...(idx?.value ?? []), id], idx?.version ?? null);
    const cEntry = await atomic.get<number>('sysgroup:count');
    await atomic.set('sysgroup:count', (cEntry?.value ?? 0) + 1, cEntry?.version ?? null);
    count++;
  }

  // User groups
  const userGroupDefs = [
    { name: 'wheel', desc: 'Full sudo-level access' },
    { name: 'root', desc: 'System administrators' },
    { name: 'daemon', desc: 'Service accounts (key-only auth)' },
    { name: 'users', desc: 'Regular users (password auth)' },
  ];
  const userGroupIds: Record<string, string> = {};
  for (const g of userGroupDefs) {
    const id = `usergrp_${crypto.randomUUID()}`;
    userGroupIds[g.name] = id;
    await atomic.set('usergroup:' + id, { id, name: g.name, description: g.desc, memberIds: [], dependsOn: [], createdAt: now, updatedAt: now }, null);
    const ugIdx = await atomic.get<string[]>('usergroup:ids');
    await atomic.set('usergroup:ids', [...(ugIdx?.value ?? []), id], ugIdx?.version ?? null);
    count++;
  }

  // Link user groups → system group rules via permission groups
  const permGroupBindings: Array<{ userGroupName: string; sysGroupName: string }> = [
    { userGroupName: 'wheel', sysGroupName: 'perm.sysadmin' },
    { userGroupName: 'root', sysGroupName: 'perm.operator' },
    { userGroupName: 'users', sysGroupName: 'perm.viewer' },
    { userGroupName: 'daemon', sysGroupName: 'perm.operator' },
  ];
  for (const b of permGroupBindings) {
    const sgEntry = await atomic.get<any>('sysgroup:' + sysGroupIds[b.sysGroupName]);
    if (!sgEntry) continue;
    const ugId = userGroupIds[b.userGroupName];
    if (!ugId) continue;
    const pgId = `permgrp_${crypto.randomUUID()}`;
    await atomic.set('permgroup:' + pgId, {
      id: pgId, name: b.sysGroupName,
      rules: sgEntry.value.rules, userGroupIds: [ugId],
      userIds: [], dependsOn: [],
      createdAt: now, updatedAt: now,
    }, null);
    const pgIdx = await atomic.get<string[]>('permgroup:ids');
    await atomic.set('permgroup:ids', [...(pgIdx?.value ?? []), pgId], pgIdx?.version ?? null);
    count++;
  }

  // Owner permission group
  const usersUgId = userGroupIds['users'];
  if (usersUgId) {
    const pgId = `permgrp_${crypto.randomUUID()}`;
    await atomic.set('permgroup:' + pgId, {
      id: pgId, name: 'perm.owner',
      rules: [
        { effect: 'allow' as const, actions: ['create', 'read', 'update', 'delete'], resource: 'sandbox:$self', priority: 90 },
        { effect: 'allow' as const, actions: ['create', 'read', 'update', 'delete'], resource: 'template:$self', priority: 90 },
      ],
      userGroupIds: [usersUgId], userIds: [], dependsOn: [],
      createdAt: now, updatedAt: now,
    }, null);
    const pgIdx = await atomic.get<string[]>('permgroup:ids');
    await atomic.set('permgroup:ids', [...(pgIdx?.value ?? []), pgId], pgIdx?.version ?? null);
    count++;
  }

  // Route ACLs
  type RouteAclDef = { method: string; pathPrefix: string; priority: number };
  const groupAcls: Record<string, RouteAclDef[]> = {
    wheel: [{ method: '*', pathPrefix: '/', priority: 1000 }],
    root: [
      { method: '*', pathPrefix: '/api/networks', priority: 100 },
      { method: '*', pathPrefix: '/api/sandboxes', priority: 100 },
      { method: '*', pathPrefix: '/api/templates', priority: 100 },
      { method: '*', pathPrefix: '/api/topology', priority: 100 },
      { method: 'GET', pathPrefix: '/api/audit', priority: 100 },
      { method: 'GET', pathPrefix: '/api/platforms', priority: 100 },
      { method: 'GET', pathPrefix: '/api/users', priority: 10 },
      { method: 'PUT', pathPrefix: '/api/users', priority: 10 },
      { method: 'DELETE', pathPrefix: '/api/users', priority: 10 },
    ],
    users: [
      { method: 'GET', pathPrefix: '/api/networks', priority: 50 },
      { method: 'GET', pathPrefix: '/api/templates', priority: 50 },
      { method: 'POST', pathPrefix: '/api/templates', priority: 50 },
      { method: 'GET', pathPrefix: '/api/sandboxes', priority: 50 },
      { method: 'POST', pathPrefix: '/api/sandboxes', priority: 50 },
      { method: 'PUT', pathPrefix: '/api/sandboxes', priority: 50 },
      { method: 'GET', pathPrefix: '/api/platforms', priority: 50 },
      { method: 'GET', pathPrefix: '/api/users', priority: 10 },
      { method: 'PUT', pathPrefix: '/api/users', priority: 10 },
      { method: 'DELETE', pathPrefix: '/api/users', priority: 10 },
      { method: 'GET', pathPrefix: '/api/topology', priority: 50 },
      { method: 'POST', pathPrefix: '/api/topology', priority: 50 },
      { method: 'PUT', pathPrefix: '/api/topology', priority: 50 },
      { method: 'DELETE', pathPrefix: '/api/topology', priority: 50 },
    ],
    daemon: [
      { method: 'GET', pathPrefix: '/api/users', priority: 10 },
    ],
  };
  for (const [grpName, acls] of Object.entries(groupAcls)) {
    const grpId = userGroupIds[grpName];
    if (!grpId) continue;
    for (const def of acls) {
      const aclId = `routeacl_${crypto.randomUUID()}`;
      await atomic.set('routeacl:' + aclId, {
        id: aclId, method: def.method, pathPrefix: def.pathPrefix,
        matchType: 'prefix', effect: 'allow', userGroupId: grpId,
        priority: def.priority, createdAt: now, updatedAt: now,
      }, null);
      const raIdx = await atomic.get<string[]>('routeacl:ids');
      await atomic.set('routeacl:ids', [...(raIdx?.value ?? []), aclId], raIdx?.version ?? null);
      count++;
    }
  }

  await atomic.set(KEY, { seededAt: now }, null);
  console.log(`[${new Date().toISOString()}] INFO: [seed] Policy library seeded: ${count} items`);
}

async function seedDefaultInstance(atomic: IAtomicStore): Promise<string | undefined> {
  const KEY = '_init:default-instance';
  const entry = await atomic.get<any>(KEY);
  if (entry !== null) return entry.value.instanceId as string;

  try {
    const { InstanceService } = await import('./region/instance.ts');
    const instanceSvc = new InstanceService(atomic);
    const podmanEp = process.env['PODMAN_ENDPOINT'] ?? 'http://127.0.0.1:8080';
    const instance = await instanceSvc.create({
      name: 'default-podman',
      platform: 'podman',
      region: 'local',
      zone: 'local-a',
      endpoint: podmanEp,
      labels: { networkDomain: 'podman-default' },
      capabilities: { container: true, image: true, group: true, network: true, s3: true, metrics: false, dns: false },
    });
    const instanceId = instance.id as string;
    await atomic.set(KEY, { instanceId, seededAt: Date.now() }, null);
    console.log(`[${new Date().toISOString()}] INFO: [seed] Default instance seeded: ${instanceId}`);
    return instanceId;
  } catch (e: unknown) {
    console.error(`[${new Date().toISOString()}] ERROR: [seed] Failed to seed default instance: ${e instanceof Error ? e.message : e}`);
    return undefined;
  }
}

async function seedSandboxTemplates(atomic: IAtomicStore, defaultInstanceId?: string): Promise<void> {
  const KEY = '_init:sandbox-tpls';
  const entry = await atomic.get<any>(KEY);
  if (entry !== null) return;

  const now = Date.now();
  const ids: Record<string, string> = {};
  const cid = defaultInstanceId;

  // Layer 0: base templates
  const baseAlpineId = `tpl_${crypto.randomUUID()}`; ids.base_alpine = baseAlpineId;
  const nginxId = `tpl_${crypto.randomUUID()}`; ids.nginx = nginxId;
  const fedoraId = `tpl_${crypto.randomUUID()}`; ids.fedora = fedoraId;
  const minioId = `tpl_${crypto.randomUUID()}`; ids.minio = minioId;

  // Layer 1: inherits from base-alpine
  const customAlpineId = `tpl_${crypto.randomUUID()}`; ids.custom_alpine = customAlpineId;

  // Layer 2: inherits from custom-alpine + nginx
  const fullStackId = `tpl_${crypto.randomUUID()}`; ids.full_stack = fullStackId;

  const nginxArgId = `tpl_${crypto.randomUUID()}`; ids.nginx_arg = nginxArgId;
  const demoPodId = `tpl_${crypto.randomUUID()}`; ids.demo_pod = demoPodId;
  const gpuInferenceId = `tpl_${crypto.randomUUID()}`; ids.gpu_inference = gpuInferenceId;

  const tpls: any[] = [
    {
      id: baseAlpineId, name: 'base-alpine',
      description: 'Base Alpine Linux — minimal OS layer, 256MB RAM, sleep 3600',
      apiVersion: 'hbi-aad/v1', kind: 'Container',
      dependsOn: [],
      container: {
        region: 'local', instanceId: cid,
        containers: [{ name: 'alpine', image: 'docker.io/library/alpine:latest', command: ['sleep', '3600'], resources: { limits: { cpu: 0.25, memory: 256 } } }],
        restartPolicy: 'Never',
      },
      network: { publicIp: { allocate: false } },
      createdAt: now, updatedAt: now,
    },
    {
      id: nginxId, name: 'nginx',
      description: 'Nginx web server — ports 80, readiness check',
      apiVersion: 'hbi-aad/v1', kind: 'Container',
      dependsOn: [], singleton: true,
      container: {
        region: 'local', instanceId: cid,
        containers: [{ name: 'nginx', image: 'docker.io/library/nginx:latest', command: ['nginx'], args: ['-g', 'daemon off;'], ports: [{ containerPort: 80, protocol: 'TCP' }], resources: { limits: { cpu: 0.5, memory: 128 } } }],
        restartPolicy: 'Always',
      },
      healthChecks: [
        { name: 'nginx-alive', target: 'container:nginx', type: 'liveness', probe: { httpGet: { path: '/', port: 80 } }, periodSeconds: 10, initialDelaySeconds: 5 },
        { name: 'nginx-ready', target: 'container:nginx', type: 'readiness', probe: { tcpSocket: { port: 80 } }, periodSeconds: 5, initialDelaySeconds: 2 },
      ],
      network: { publicIp: { allocate: false } },
      createdAt: now, updatedAt: now,
    },
    {
      id: fedoraId, name: 'fedora',
      description: 'Fedora Linux — minimal OS layer, 256MB RAM, sleep 3600',
      apiVersion: 'hbi-aad/v1', kind: 'Container',
      dependsOn: [],
      container: {
        region: 'local', instanceId: cid,
        containers: [{ name: 'fedora', image: 'registry.fedoraproject.org/fedora:latest', command: ['sleep', '3600'], resources: { limits: { cpu: 0.25, memory: 256 } } }],
        restartPolicy: 'Never',
      },
      healthChecks: [{ name: 'fedora-alive', target: 'container:fedora', type: 'liveness', probe: { exec: { command: ['sh', '-c', 'kill -0 1'] } }, periodSeconds: 15, initialDelaySeconds: 5, failureThreshold: 3 }],
      network: { publicIp: { allocate: false } },
      createdAt: now, updatedAt: now,
    },
    {
      id: gpuInferenceId, name: 'gpu-inference',
      description: 'GPU inference server — requires NVIDIA GPU (nvidia.com/gpu)',
      apiVersion: 'hbi-aad/v1', kind: 'Container',
      dependsOn: [],
      container: {
        region: 'local', instanceId: cid,
        containers: [{ name: 'inference', image: 'nvidia/cuda:12.2-runtime', command: ['python', '-m', 'my_inference_server'], resources: { limits: { cpu: 4, memory: 8192, gpu: 1 } }, ports: [{ containerPort: 8080, protocol: 'TCP' }] }],
        restartPolicy: 'Always',
      },
      network: { publicIp: { allocate: true } },
      createdAt: now, updatedAt: now,
    },
    {
      id: minioId, name: 'minio-server',
      description: 'MinIO S3-compatible object storage — ports 9000 (API) / 9001 (console)',
      apiVersion: 'hbi-aad/v1', kind: 'Container',
      dependsOn: [], singleton: true,
      container: {
        region: 'local', instanceId: cid,
        containers: [{ name: 'minio', image: 'quay.io/minio/minio:latest', command: ['server', '/data', '--console-address', ':9001'], ports: [{ containerPort: 9000, protocol: 'TCP' }, { containerPort: 9001, protocol: 'TCP' }], env: [{ name: 'MINIO_ROOT_USER', value: 'minioadmin' }, { name: 'MINIO_ROOT_PASSWORD', value: 'minioadmin' }], resources: { limits: { cpu: 0.5, memory: 512 } } }],
        restartPolicy: 'Always',
      },
      healthChecks: [{ name: 'minio-ready', target: 'container:minio', type: 'readiness', probe: { tcpSocket: { port: 9000 } }, periodSeconds: 5, initialDelaySeconds: 5 }],
      network: { publicIp: { allocate: true } },
      createdAt: now, updatedAt: now,
    },
    { id: customAlpineId, name: 'custom-alpine', description: 'Custom Alpine — inherits base-alpine, adds curl + env vars', apiVersion: 'hbi-aad/v1', kind: 'Container', dependsOn: [baseAlpineId], container: { region: 'local', instanceId: cid, containers: [{ name: 'alpine', command: ['sh', '-c', 'while true; do echo "Hello from DAG"; curl -s http://localhost/health 2>/dev/null || echo "nginx not ready"; sleep 10; done'], env: [{ name: 'APP_ENV', value: 'development' }, { name: 'LOG_LEVEL', value: 'debug' }] }], restartPolicy: 'Never' }, createdAt: now, updatedAt: now },
    { id: fullStackId, name: 'full-stack', description: 'Full stack — merges custom-alpine + nginx with app container', apiVersion: 'hbi-aad/v1', kind: 'Container', dependsOn: [customAlpineId, nginxId], container: { region: 'local', instanceId: cid, containers: [{ name: 'alpine', env: [{ name: 'NGINX_HOST', value: 'localhost' }, { name: 'DB_URL', value: 'sqlite:///data/app.db' }] }] }, network: { publicIp: { allocate: true } }, createdAt: now, updatedAt: now },
    { id: nginxArgId, name: 'nginx-arg', description: 'Nginx with explicit command+args — 验证模板参数穿透到容器', apiVersion: 'hbi-aad/v1', kind: 'Container', dependsOn: [], singleton: true, container: { region: 'local', instanceId: cid, containers: [{ name: 'nginx-arg', image: 'docker.io/library/nginx:latest', command: ['nginx'], args: ['-g', 'daemon off;'], ports: [{ containerPort: 80, protocol: 'TCP' }], resources: { limits: { cpu: 0.5, memory: 128 } } }], restartPolicy: 'Always' }, healthChecks: [{ name: 'nginx-arg-alive', target: 'container:nginx-arg', type: 'liveness', probe: { httpGet: { path: '/', port: 80 } }, periodSeconds: 10, initialDelaySeconds: 5 }], network: { publicIp: { allocate: false } }, createdAt: now, updatedAt: now },
    { id: demoPodId, name: 'demo-pod', description: 'v2 容器组 — nginx + alpine 共享网络 (docker-compose 风格)', apiVersion: 'hbi-aad/v2', kind: 'ContainerGroup', dependsOn: [], podSpec: { name: 'demo-pod', region: 'local', resources: { cpu: '1.0', memory: '512Mi' }, services: { web: { image: 'docker.io/library/nginx:latest', command: ['nginx', '-g', 'daemon off;'], ports: [{ containerPort: 80, protocol: 'TCP' }], resources: { cpu: '0.5', memory: '128Mi' } }, sidecar: { image: 'docker.io/library/alpine:latest', command: ['sh', '-c', 'while true; do echo "sidecar alive"; sleep 30; done'], dependsOn: ['web'], resources: { cpu: '0.25', memory: '64Mi' } } } }, createdAt: now, updatedAt: now },
  ];

  const allIds = [baseAlpineId, nginxId, nginxArgId, customAlpineId, fullStackId, fedoraId, minioId, demoPodId, gpuInferenceId];
  for (const t of tpls) {
    await atomic.set('sandbox-tpl:' + t.id, t, null);
  }
  await atomic.set('sandbox-tpl:ids', allIds, null);
  await atomic.set(KEY, { seededAt: now }, null);
  console.log(`[${new Date().toISOString()}] INFO: [seed] Sandbox templates seeded: ${tpls.length} (${tpls.map((t: any) => t.name).join(', ')})`);
}

/** Seed MAC rules if absent. Returns the rules array for in-memory loading. */
export async function ensureMacRules(atomic: IAtomicStore): Promise<readonly any[]> {
  const KEY = '_init:mac-policy';
  const entry = await atomic.get<any>(KEY);
  if (entry !== null) return entry.value.rules;

  const rules = [
    { effect: 'deny', actions: ['delete'], resource: 'user:root', priority: 9999, description: 'Cannot delete the root user — would break system ownership' },
    { effect: 'deny', actions: ['admin'], resource: 'user:root', priority: 9999, description: 'Cannot change the root user role — root must remain root' },
    { effect: 'deny', actions: ['delete', 'admin'], resource: 'usergroup:wheel', priority: 9999, description: 'Cannot delete or modify wheel group — would break privilege model' },
    { effect: 'deny', actions: ['delete', 'admin'], resource: 'usergroup:daemon', priority: 9999, description: 'Cannot delete or modify daemon group — service accounts would be orphaned' },
    { effect: 'deny', actions: ['delete'], resource: 'usergroup:root', priority: 9999, description: 'Cannot delete the root user group' },
    { effect: 'deny', actions: ['delete'], resource: 'usergroup:users', priority: 9999, description: 'Cannot delete the default users group' },
    { effect: 'deny', actions: ['admin', 'delete', 'create', 'update'], resource: 'sysgroup', priority: 9999, description: 'Cannot create, modify or delete system groups — immutable policy templates' },
    { effect: 'deny', actions: ['delete'], resource: 'permgroup', priority: 9999, description: 'Cannot delete seed permission groups (perm.sysadmin/operator/viewer/auth)' },
    { effect: 'deny', actions: ['admin', 'delete', 'update'], resource: '_init:', priority: 9999, description: 'Cannot modify or delete any _init:* keys — seed data is immutable' },
    { effect: 'deny', actions: ['delete'], resource: '_sys:initialized', priority: 9999, description: 'Cannot delete the initialization flag — would allow re-setup' },
    { effect: 'deny', actions: ['admin', 'update'], resource: '_sys:initialized', priority: 9999, description: 'Cannot set _sys:initialized back to false' },
    { effect: 'deny', actions: ['delete', 'admin', 'update'], resource: '_init:mac-policy', priority: 9999, description: 'Cannot modify or delete MAC policy itself — systemic integrity' },
    { effect: 'deny', actions: ['delete'], resource: 'routeacl:ids', priority: 9999, description: 'Cannot delete the route ACL index — would bypass all access control' },
    { effect: 'deny', actions: ['admin'], resource: 'permgroup', priority: 9998, description: 'Admin actions cannot bypass permission group evaluation' },
  ];
  await atomic.set(KEY, { rules }, null);
  return rules;
}

/**
 * Run all deferred seed operations in the background.
 * Call from ctx.waitUntil() in Worker mode to avoid blocking the first request.
 */
async function seedLogPolicy(atomic: IAtomicStore): Promise<void> {
  const KEY = '_sys:log-policy';
  const entry = await atomic.get<any>(KEY);
  if (entry !== null) return;

  const policy = {
    defaultLevel: 'info',
    auditLevel: 'info',
    facilities: [
      { facility: 'sandbox-service', level: 'debug' },
      { facility: 'perm', level: 'debug' },
      { facility: 'authz', level: 'debug' },
      { facility: 'health', level: 'info' },
      { facility: 'secgroup', level: 'info' },
      { facility: 'subnet', level: 'info' },
      { facility: 'topology', level: 'info' },
      { facility: 'template', level: 'info' },
      { facility: 'quota', level: 'info' },
      { facility: 'event-loop', level: 'info' },
    ],
    updatedAt: Date.now(),
  };
  await atomic.set(KEY, policy, null);
  console.log(`[${new Date().toISOString()}] INFO: [seed] Log policy seeded: ${policy.facilities.length} facilities`);
}

async function seedVolumes(atomic: IAtomicStore, defaultInstanceId: string): Promise<void> {
  const KEY = '_init:volumes';
  const entry = await atomic.get<any>(KEY);
  if (entry !== null) return;

  const now = Date.now();
  const volumes: Record<string, unknown>[] = [
    {
      id: crypto.randomUUID(), name: 'seed-nfs', tags: [], createdAt: now, updatedAt: now,
      status: 'Detached', type: 'NFSVolume', instanceId: defaultInstanceId,
      description: 'Seed NFS volume — demo shared storage',
      nfs: { server: '192.168.45.202', path: '/nfsshare', readOnly: false },
    },
    {
      id: crypto.randomUUID(), name: 'seed-tmp', tags: [], createdAt: now, updatedAt: now,
      status: 'Detached', type: 'EmptyDirVolume', instanceId: defaultInstanceId,
      description: 'Seed emptyDir volume — ephemeral scratch space',
    },
  ];

  const ids: string[] = [];
  for (const v of volumes) {
    ids.push(v.id as string);
    await atomic.set('volume:' + v.id, v, null);
  }
  await atomic.set('volume:ids', ids, null);
  await atomic.set(KEY, { seededAt: now }, null);
  console.log(`[${new Date().toISOString()}] INFO: [seed] Demo volumes seeded: ${volumes.length}`);
}

export async function seedIfNeeded(atomic: IAtomicStore): Promise<void> {
  await seedPolicyLibrary(atomic);
  const instanceId = await seedDefaultInstance(atomic);
  await seedSandboxTemplates(atomic, instanceId);
  if (instanceId) await seedVolumes(atomic, instanceId);
  await seedLogPolicy(atomic);
}
