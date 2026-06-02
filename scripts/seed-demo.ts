// Demo template seeder — run with: npx tsx scripts/seed-demo.mjs
import { serve } from '@hono/node-server';
import { loadConfig } from '../src/config/env.ts';
import { createApp } from '../src/core/app.ts';

const config = loadConfig({
  storage: { stateBackend: 'file', queryBackend: 'none', blobBackend: 'file', connections: { filePath: '.data' } },
  scheduler: { backend: 'worker', intervalMs: 60000, batchSize: 0 },
  authz: { enabled: false },
});

const app = await createApp(config);
const fetch = (req) => app.app.fetch(req);

async function api(method, path, body) {
  const res = await fetch(new Request(`http://localhost${path}`, {
    method, headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  }));
  const data = await res.json();
  if (!data.success) { console.error(`FAIL ${method} ${path}:`, data.error?.code, data.error?.message); process.exit(1); }
  return data.data;
}

// Register + become wheel
const reg = await api('POST', '/api/users/register', { email: 'admin@demo.test', password: 'test123456', name: 'DemoAdmin' });
const uid = reg.user.id;
console.log('Root user:', uid);

await api('POST', '/__become-wheel', { userId: uid });
console.log('→ wheel');

// Layer 0: base-network
const l0 = await api('POST', '/api/templates/', {
  name: 'base-network', spec: {
    provider: 'alibaba', region: 'cn-hangzhou',
    network: { securityGroupId: 'sg-bp1axxx', subnetIds: ['vsw-bp1xxx'], allocatePublicIp: false },
    restartPolicy: 'Always',
    providerOverrides: { alibaba: { instanceType: 'ecs.g7.xlarge' } },
  },
});
console.log('Layer 0 base-network:', l0.id.slice(0, 20));

// Layer 0b: redis-cache
const l0b = await api('POST', '/api/templates/', {
  name: 'redis-cache', spec: {
    provider: 'alibaba', region: 'cn-hangzhou',
    containers: [{
      name: 'redis', image: 'docker.io/library/redis:7-alpine',
      command: ['redis-server', '--save', '', '--appendonly', 'no'],
      resources: { limits: { cpu: 0.5, memory: 512 } },
      livenessProbe: { tcpSocket: { port: 6379 }, periodSeconds: 10, initialDelaySeconds: 5 },
      ports: [{ containerPort: 6379, protocol: 'TCP' }],
    }],
    network: { allocatePublicIp: false }, restartPolicy: 'Always',
  },
});
console.log('Layer 0 redis-cache:', l0b.id.slice(0, 20));

// Layer 1: web-service (depends on base-network)
const l1 = await api('POST', '/api/templates/', {
  name: 'web-service', dependsOn: [l0.id], spec: {
    containers: [{
      name: 'nginx', image: 'docker.io/library/nginx:alpine',
      ports: [{ containerPort: 80, protocol: 'TCP' }, { containerPort: 443, protocol: 'TCP' }],
      resources: { limits: { cpu: 1, memory: 256 } },
      livenessProbe: { httpGet: { port: 80, path: '/health' }, periodSeconds: 15, initialDelaySeconds: 10 },
      readinessProbe: { httpGet: { port: 80, path: '/health' }, periodSeconds: 5 },
      providerOverrides: { eipBandwidth: 50 },
    }],
    network: { allocatePublicIp: true, publicIpBandwidth: 50 },
    providerOverrides: { alibaba: { spotStrategy: 'SpotAsPriceGo' } },
  },
});
console.log('Layer 1 web-service:', l1.id.slice(0, 20));

// Layer 1b: api-service (depends on base-network)
const l1b = await api('POST', '/api/templates/', {
  name: 'api-service', dependsOn: [l0.id], spec: {
    containers: [{
      name: 'api', image: 'docker.io/library/node:20-alpine',
      command: ['node', 'server.js'],
      env: [{ name: 'PORT', value: '3000' }, { name: 'NODE_ENV', value: 'production' }],
      ports: [{ containerPort: 3000, protocol: 'TCP' }],
      resources: { limits: { cpu: 2, memory: 1024 } },
      livenessProbe: { httpGet: { port: 3000, path: '/health' }, periodSeconds: 10 },
      providerOverrides: { enableLogMonitor: true },
    }],
  },
});
console.log('Layer 1 api-service:', l1b.id.slice(0, 20));

// Layer 2: prod-stack (merges web + api + redis)
const l2 = await api('POST', '/api/templates/', {
  name: 'prod-stack', dependsOn: [l1.id, l1b.id, l0b.id], spec: {
    containers: [
      { name: 'nginx', env: [{ name: 'UPSTREAM_API', value: 'api:3000' }] },
      { name: 'api', env: [{ name: 'REDIS_URL', value: 'redis://redis:6379' }, { name: 'DB_URL', value: 'placeholder://replace-me' }] },
      { name: 'redis' },
    ],
    extensions: { healthMaxRetries: 3 },
    providerOverrides: { alibaba: { resourceGroupId: 'rg-prod', deletionProtection: true } },
  },
});
console.log('Layer 2 prod-stack:', l2.id.slice(0, 20));

// Show resolved
console.log('\n═══ Resolved prod-stack ═══');
const resolved = await api('GET', `/api/templates/${l2.id}/resolved`);
for (const c of resolved.spec.containers) {
  console.log(`\n── ${c.name} (image: ${c.image || '(inherited)'})`);
  if (c.command) console.log('   Cmd:', JSON.stringify(c.command));
  if (c.env) console.log('   Env:', JSON.stringify(c.env));
  if (c.ports) console.log('   Ports:', JSON.stringify(c.ports));
  if (c.resources) console.log('   Resources:', JSON.stringify(c.resources));
  if (c.livenessProbe) console.log('   Liveness:', JSON.stringify(c.livenessProbe));
  if (c.readinessProbe) console.log('   Readiness:', JSON.stringify(c.readinessProbe));
  if (c.providerOverrides) console.log('   ProviderOverrides:', JSON.stringify(c.providerOverrides));
}
console.log('\nNetwork:', JSON.stringify(resolved.spec.network));
console.log('Provider:', resolved.spec.provider, '| Region:', resolved.spec.region);
console.log('RestartPolicy:', resolved.spec.restartPolicy);
console.log('ProviderOverrides:', JSON.stringify(resolved.spec.providerOverrides));
console.log('Extensions:', JSON.stringify(resolved.spec.extensions));

await app.dispose();
