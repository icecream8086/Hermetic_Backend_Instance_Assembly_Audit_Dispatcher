/**
 * Workers/Miniflare precision benchmark — uses Node.js fetch (no curl overhead).
 * Measures server-timing header and wall-clock for each hot path.
 *
 * Usage: npx tsx scripts/bench-worker.ts
 */
const BASE = 'http://localhost:3000';

async function bench(name: string, url: string, init?: RequestInit, count = 30): Promise<void> {
  const times: number[] = [];
  let serverTimings: string[] = [];

  for (let i = 0; i < count; i++) {
    const start = performance.now();
    const resp = await fetch(url, init);
    await resp.text(); // consume body
    const elapsed = performance.now() - start;
    times.push(elapsed);
    const st = resp.headers.get('server-timing');
    if (st && i === 0) serverTimings.push(st);
  }

  times.sort((a, b) => a - b);
  const p50 = times[Math.floor(times.length * 0.5)]!;
  const p95 = times[Math.floor(times.length * 0.95)]!;
  const p99 = times[Math.floor(times.length * 0.99)]!;
  const avg = times.reduce((s, t) => s + t, 0) / times.length;

  console.log(`${name.padEnd(42)}  p50=${String(p50.toFixed(1)).padStart(7)}ms  p95=${String(p95.toFixed(1)).padStart(7)}ms  p99=${String(p99.toFixed(1)).padStart(7)}ms  avg=${String(avg.toFixed(1)).padStart(7)}ms`);
  if (serverTimings.length) console.log(`  server-timing: ${serverTimings[0]}`);
}

async function main() {
  // Ensure server is alive
  try { await fetch(`${BASE}/__tick`, { method: 'POST' }); } catch {}

  // Login to get token
  let token = '';
  try {
    const r = await fetch(`${BASE}/api/users/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'user@example.com', password: 'secret123' }),
    });
    const j: any = await r.json();
    token = j.data?.token || '';
  } catch {}

  console.log('');
  console.log('═══════════════════════════════════════════════════════════════════════════════════════════════');
  console.log('  Workers/Miniflare Precision Hot-Path Benchmark');
  console.log(`  Auth: ${token ? '✓ (authenticated)' : '✗ (unauthenticated — all requests go through authz deny path)'}`);
  console.log('═══════════════════════════════════════════════════════════════════════════════════════════════');
  console.log('');

  // ── Cold start ──
  const cs = performance.now();
  await fetch(`${BASE}/api/info`);
  console.log(`Cold start /api/info                              ${String((performance.now() - cs).toFixed(0)).padStart(6)}ms`);
  console.log('');

  // ── Unauthenticated paths (exercises authz fully) ──
  console.log('── Unauthenticated (authz middleware → full deny path) ──');
  await bench('GET /api/sandboxes',      `${BASE}/api/sandboxes`);
  await bench('GET /api/templates',       `${BASE}/api/templates`);
  await bench('GET /api/permissions/route-acls', `${BASE}/api/permissions/route-acls`);
  await bench('GET /api/topology/instances', `${BASE}/api/topology/instances`);
  await bench('GET /api/users',           `${BASE}/api/users`);

  if (token) {
    console.log('');
    console.log('── Authenticated (permission check + handler) ──');
    const auth = { headers: { authorization: `Bearer ${token}` } };
    await bench('GET /api/sandboxes (auth)',  `${BASE}/api/sandboxes`, auth);
    await bench('GET /api/templates (auth)',   `${BASE}/api/templates`, auth);
    await bench('GET /api/route-acls (auth)',  `${BASE}/api/permissions/route-acls`, auth);
    await bench('POST /api/perm/check (auth)', `${BASE}/api/permissions/check`, {
      method: 'POST', headers: { ...auth.headers, 'content-type': 'application/json' },
      body: JSON.stringify({ userId: '00000000-0000-0000-0000-000000000001', action: 'read', resource: 'sandbox' }),
    });
    await bench('GET /api/sandboxes?status=Running', `${BASE}/api/sandboxes?status=Running`, auth);
    await bench('GET /api/platforms (auth)', `${BASE}/api/platforms`, auth);
  }

  // ── Tick cost ──
  console.log('');
  const t0 = performance.now();
  await fetch(`${BASE}/__tick`, { method: 'POST' });
  console.log(`__tick health-check cycle                        ${String((performance.now() - t0).toFixed(0)).padStart(6)}ms`);
}

main().catch(e => { console.error(e); process.exit(1); });
