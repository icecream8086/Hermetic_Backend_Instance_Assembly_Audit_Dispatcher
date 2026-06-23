/**
 * Hot-path microbenchmark — measures the CPU bottlenecks identified in static analysis.
 * Imports createApp directly (no HTTP overhead) to isolate middleware/service costs.
 *
 * Usage: npx tsx scripts/bench-hotpaths.ts
 */
import { performance } from 'node:perf_hooks';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileKVAtomicStore } from '../src/core/store/adapters/file-kv.ts';
import { ConsoleLogger } from '../src/core/logger/console-logger.ts';
import { PermissionService } from '../src/features/permission/service.ts';
import { RouteAclManager } from '../src/features/permission/route-acl-manager.ts';
import { SandboxService } from '../src/features/sandbox/sandbox.service.ts';
import { StubContainerProvider } from '../src/providers/stub/container.ts';
import { rateLimit } from '../src/core/middleware/rate-limit.ts';
import { SandboxStore } from '../src/features/sandbox/sandbox-store.ts';

function atomic() { return new FileKVAtomicStore(join(tmpdir(), 'hbi-bench-' + crypto.randomUUID().slice(0, 8))); }

interface BenchResult { name: string; ops: number; totalMs: number; avgUs: number; opsPerSec: number }

async function bench(name: string, fn: () => Promise<void> | void, iterations = 100): Promise<BenchResult> {
  // Warmup
  for (let i = 0; i < 5; i++) await fn();
  const start = performance.now();
  for (let i = 0; i < iterations; i++) await fn();
  const totalMs = performance.now() - start;
  const avgUs = (totalMs / iterations) * 1000;
  return { name, ops: iterations, totalMs, avgUs, opsPerSec: Math.round(iterations / (totalMs / 1000)) };
}

async function main() {
  const results: BenchResult[] = [];

  // ── 1. Rate limit middleware (hot: every request) ──
  const rl = rateLimit({ windowMs: 60_000, maxRequests: 10_000, enabled: true });
  const fakeCtx = { req: { header: (_n: string) => `ip-${Math.random()}` } } as any;
  results.push(await bench('rateLimit middleware (bypass off)', () => rl(fakeCtx, async () => {}), 500));

  const rlBypass = rateLimit({ windowMs: 60_000, maxRequests: 100, enabled: true, bypassIps: ['127.0.0.1'] });
  const bypassCtx = { req: { header: () => '127.0.0.1' } } as any;
  results.push(await bench('rateLimit middleware (bypass IP)', () => rlBypass(bypassCtx, async () => {}), 500));

  const rlOff = rateLimit({ windowMs: 60_000, maxRequests: 100, enabled: false });
  results.push(await bench('rateLimit middleware (kill switch)', () => rlOff(fakeCtx, async () => {}), 500));

  // ── 2. Route ACL checkAccess (hot: every authenticated request) ──
  const storeAcl = atomic();
  const aclMgr = new RouteAclManager(storeAcl, new ConsoleLogger());
  // Seed 20 ACLs (typical production size)
  for (let i = 0; i < 20; i++) {
    await aclMgr.create({
      method: i % 3 === 0 ? '*' : 'GET',
      pathPrefix: i % 2 === 0 ? `/api/endpoint-${i}` : `/api/admin-${i}`,
      matchType: i % 2 === 0 ? 'prefix' : 'exact',
      effect: i < 5 ? 'deny' : 'allow',
      priority: 1000 - i * 10,
    });
  }
  // First call populates cache
  await aclMgr.checkAccess('GET', '/api/endpoint-0', 'user1', []);
  results.push(await bench('RouteAclManager.checkAccess (cached)', () =>
    aclMgr.checkAccess('GET', '/api/endpoint-5', 'user1', ['group1']), 200));

  // ── 3. PermissionChecker.check (hot: every authorized request) ──
  const storePerm = atomic();
  const permService = new PermissionService(storePerm, new ConsoleLogger());
  // Seed a user and some groups
  await storePerm.set('user:user1', { id: 'user1', name: 'Test User' }, null);
  // First call populates caches
  await permService.check({ userId: 'user1', action: 'read', resource: 'sandbox' });
  results.push(await bench('PermissionService.check (cached)', () =>
    permService.check({ userId: 'user1', action: 'read', resource: 'sandbox' }), 100));

  // ── 4. Sandbox CRUD (hot: sandbox lifecycle) ──
  const storeSbx = atomic();
  const sandboxStore = new SandboxStore(storeSbx);
  // Seed a sandbox
  const seedSbx = {
    id: 'sb_bench' as any, name: 'bench', status: 'Running' as any,
    createdAt: Date.now(), updatedAt: Date.now(), version: 'v1' as any,
    config: { region: 'local', network: {} } as any,
    network: {} as any, containers: [], events: [], tags: [], providerId: 'stub-bench',
  };
  await storeSbx.set('sandbox:sb_bench', seedSbx, null);
  await storeSbx.set('sandbox:ids', ['sb_bench'], null);

  results.push(await bench('SandboxStore.getById', () => sandboxStore.getById('sb_bench' as any), 500));
  results.push(await bench('SandboxStore.list (5 items)', () => sandboxStore.list(undefined, 5), 100));

  // ── 5. CIDR matching (hot: every request with bypass) ──
  // Lazy import from rate-limit module — we inline the function
  function ipv4ToNumber(ip: string): number | null {
    const parts = ip.split('.');
    if (parts.length !== 4) return null;
    let n = 0;
    for (let i = 0; i < 4; i++) { n = (n << 8) | (parseInt(parts[i]!, 10) || 0); }
    return n >>> 0;
  }
  function ipv4InCidr(ip: string, base: string, bits: number): boolean {
    const ipN = ipv4ToNumber(ip); const baseN = ipv4ToNumber(base);
    if (ipN === null || baseN === null) return false;
    const mask = bits === 0 ? 0 : (~0 >>> 0) << (32 - bits);
    return (ipN & mask) === (baseN & mask);
  }
  results.push(await bench('IPv4 CIDR match (10.0.0.5 in 10.0.0.0/8)', () =>
    ipv4InCidr('10.0.0.5', '10.0.0.0', 8), 2000));

  // ── Report ──
  console.log('');
  console.log('╔══════════════════════════════════════════════════════════════════════════════════╗');
  console.log('║                        Hot-Path Microbenchmark Results                          ║');
  console.log('╠══════════════════════════════════════════════════════════════════════════════════╣');
  console.log('║ Benchmark                          │   Ops │ Total(ms) │  Avg(μs) │   ops/s   ║');
  console.log('╟────────────────────────────────────┼───────┼───────────┼──────────┼───────────╢');
  for (const r of results) {
    const name = r.name.padEnd(36);
    const ops = String(r.ops).padStart(5);
    const total = String(r.totalMs.toFixed(1)).padStart(9);
    const avg = String(Math.round(r.avgUs)).padStart(8);
    const rate = String(r.opsPerSec).padStart(9);
    console.log(`║ ${name} │ ${ops} │ ${total}ms │ ${avg}μs │ ${rate} ║`);
  }
  console.log('╚══════════════════════════════════════════════════════════════════════════════════╝');
}

main().catch(e => { console.error(e); process.exit(1); });
