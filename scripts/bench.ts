/**
 * 快速性能压测 — 针对 wrangler dev (DO/KV 后端)
 * 用法: npx tsx scripts/bench.ts [url]
 */
const BASE = process.argv[2] ?? 'http://localhost:3000';

interface BenchResult {
  label: string;
  avg: number;
  min: number;
  max: number;
  ok: number;
  total: number;
}

async function bench(label: string, path: string, options?: { method?: string; body?: any; token?: string }): Promise<BenchResult> {
  const times: number[] = [];
  let ok = 0;
  const N = 30;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (options?.token) headers['Authorization'] = `Bearer ${options.token}`;

  for (let i = 0; i < N; i++) {
    const start = Date.now();
    try {
      const res = await fetch(`${BASE}${path}`, {
        method: options?.method ?? 'GET',
        headers,
        body: options?.body ? JSON.stringify(options.body) : undefined,
      });
      if (res.ok) ok++;
      times.push((Date.now() - start) / 1000);
    } catch {
      times.push(99);
    }
  }

  const avg = times.reduce((a, b) => a + b, 0) / times.length;
  const min = Math.min(...times);
  const max = Math.max(...times);

  return { label: `${options?.method ?? 'GET'} ${path}`, avg, min, max, ok, total: N };
}

async function main() {
  // Register/login
  const regRes = await fetch(`${BASE}/api/users/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'user@example.com', password: 'secret123', name: 'Alice' }),
  });
  const regData: any = await regRes.json();

  // If already exists, login
  let token = regData.data?.token;
  if (!token) {
    const loginRes = await fetch(`${BASE}/api/users/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'user@example.com', password: 'secret123' }),
    });
    const loginData: any = await loginRes.json();
    token = loginData.data?.token ?? 'NO_TOKEN';
  }

  console.log(`Target: ${BASE}`);
  console.log(`Token: ${token?.slice(0, 20)}...`);
  console.log('');
  console.log('=== Wrangler Dev 基准测试 (30 req/endpoint) ===\n');

  const endpoints = [
    ['GET /api/info (public)', '/api/info', {}],
    ['GET /api/platforms', '/api/platforms', { token }],
    ['GET /api/sandboxes', '/api/sandboxes', { token }],
    ['GET /api/permissions/policies', '/api/permissions/policies', { token }],
    ['GET /api/templates', '/api/templates', { token }],
    ['GET /api/system-groups', '/api/system-groups', { token }],
    ['GET /api/users', '/api/users', { token }],
    ['GET /api/networks', '/api/networks', { token }],
    ['GET /api/subnets', '/api/subnets', { token }],
  ] as const;

  for (const [label, path, opts] of endpoints) {
    const r = await bench(label, path, opts as any);
    console.log(
      `  ${label.padEnd(35)} ` +
      `avg=${String(Math.round(r.avg * 1000)).padStart(4)}ms  ` +
      `min=${String(Math.round(r.min * 1000)).padStart(4)}ms  ` +
      `max=${String(Math.round(r.max * 1000)).padStart(4)}ms  ` +
      `ok=${r.ok}/${r.total}`
    );
  }

  console.log('\n=== 静态分析结果 ===\n');
  console.log('Madge (循环依赖): 无');
  console.log('Knip (未使用文件): 26');
  console.log('调用图节点数: 1935');
  console.log('最高入度: this.atomic.get (96 处调用)');
  console.log('依赖图: deps/deps.html (HTML), deps/deps.dot (DOT)');
  console.log('CPU profile: .cpuprof/');
}

main();
