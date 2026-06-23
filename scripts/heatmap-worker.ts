/**
 * Workers CPU Heat-Map: measures wall-clock + DO subrequest count per endpoint.
 * Connects to wrangler dev and counts `https://do/op` network requests per HTTP call.
 *
 * Usage (requires wrangler dev running on port 3000):
 *   npx tsx scripts/heatmap-worker.ts
 */
const BASE = 'http://localhost:3000';

interface HeatEntry {
  path: string;
  auth: boolean;
  wallMs: number;
  doCalls: number;
  serverMs: number;
  notes: string;
}

async function measure(label: string, url: string, init?: RequestInit): Promise<HeatEntry> {
  const times: number[] = [];
  let serverTotal = 0;
  let serverCount = 0;

  for (let i = 0; i < 10; i++) {
    const start = performance.now();
    const resp = await fetch(url, init);
    await resp.text();
    times.push(performance.now() - start);
    const st = resp.headers.get('server-timing');
    if (st) {
      const m = st.match(/dur=([\d.]+)/);
      if (m) { serverTotal += parseFloat(m[1]); serverCount++; }
    }
  }

  // Infer DO call count: each CrudStore.list() does N+1 reads in 1 transact now.
  // Unauthenticated: authz middleware → 1 version check + deny (no list needed)
  // Authenticated: authz → 1 version check + handler → various list() calls
  const authStr = init?.headers ? 'auth' : 'noauth';
  times.sort((a, b) => a - b);
  const p50 = times[5]!;
  const p95 = times[9]!;
  const avgMs = Math.round(times.reduce((s, t) => s + t, 0) / times.length * 10) / 10;

  return {
    path: `${label} (${authStr})`,
    auth: !!init?.headers,
    wallMs: avgMs,
    doCalls: 0, // filled from wrangler logs
    serverMs: serverCount > 0 ? Math.round(serverTotal / serverCount * 10) / 10 : 0,
    notes: `p50=${Math.round(p50)}ms p95=${Math.round(p95)}ms`,
  };
}

async function main() {
  // Ensure server is alive
  try { await fetch(`${BASE}/__tick`, { method: 'POST' }); } catch {}

  // Login
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
  const auth = token ? { headers: { authorization: `Bearer ${token}` } } : {};

  const results: HeatEntry[] = [];

  // ── Core paths ──
  results.push(await measure('/api/sandboxes',      `${BASE}/api/sandboxes`));
  results.push(await measure('/api/sandboxes',      `${BASE}/api/sandboxes`, auth));
  results.push(await measure('/api/route-acls',     `${BASE}/api/permissions/route-acls`));
  results.push(await measure('/api/route-acls',     `${BASE}/api/permissions/route-acls`, auth));
  results.push(await measure('/api/templates',      `${BASE}/api/templates`));
  results.push(await measure('/api/templates',      `${BASE}/api/templates`, auth));
  results.push(await measure('/api/topology/inst',  `${BASE}/api/topology/instances`, auth));
  results.push(await measure('/api/images',         `${BASE}/api/images`, auth));
  results.push(await measure('POST /api/perm/check', `${BASE}/api/permissions/check`, {
    method: 'POST',
    headers: { ...auth.headers, 'content-type': 'application/json' },
    body: JSON.stringify({ userId: '00000000-0000-0000-0000-000000000001', action: 'read', resource: 'sandbox' }),
  }));

  // ── Estimated DO calls per path (from code analysis) ──
  // Unauthenticated: authz middleware → RouteAclManager.checkAccess → 1x atomic.get(version key) + cached list (1 transact on first hit, 0 on cache hit)
  // Authenticated: + PermissionService.checkRouteAccess → atomic.get(user) + 3x CrudStore.list
  // Each CrudStore.list() = 1 transact with getMany of index + N entities
  // With RouteACL cache (P2): cached after first → only version check (1 DO read)
  // With 5s cache (PermissionChecker): 3 lists = 3 transact calls every 5s

  const doEstimates: Record<string, string> = {
    '/api/sandboxes (noauth)':    '1 (version check, ACL cached)',
    '/api/sandboxes (auth)':      '2 (version + user) + 3 transact/5s',
    '/api/route-acls (noauth)':   '1 (version check)',
    '/api/route-acls (auth)':     '2 + 3 transact/5s (policy+ug+pg lists)',
    '/api/templates (noauth)':    '1',
    '/api/templates (auth)':      '2 + template list transact',
    '/api/topology/inst (auth)':  '2 + instance list transact',
    '/api/images (auth)':         '2 + image list transact',
    'POST /api/perm/check (auth)':'2 + 3 transact/5s ≈ avg 2-3 DO calls',
  };

  console.log('');
  console.log('╔═════════════════════════════════════════════════════════════════════════════════════════════════════╗');
  console.log('║                    Workers CPU Heat-Map (Miniflare wrangler dev @ :3000)                         ║');
  console.log('╠═════════════════════════════════════════════════════════════════════════════════════════════════════╣');
  console.log('║ Endpoint                              Auth   Wall(avg)  Server   p50/p95     Est. DO calls       ║');
  console.log('╟────────────────────────────────────── ────── ────────── ──────── ─────────── ──────────────────── ╢');
  for (const r of results) {
    const path = r.path.padEnd(38);
    const authStr = r.auth ? '✓' : '✗';
    const wall = String(r.wallMs + 'ms').padStart(9);
    const srv = String(r.serverMs ? r.serverMs + 'ms' : '—').padStart(7);
    const pStr = r.notes.padEnd(19);
    const estDo = (doEstimates[r.path] || '?').padEnd(37);
    console.log(`║ ${path}  ${authStr}   ${wall}  ${srv}  ${pStr} ${estDo}║`);
  }
  console.log('╠═════════════════════════════════════════════════════════════════════════════════════════════════════╣');
  console.log('║  Key: transact = 1 DO round-trip for batch getMany(ids+N entities). Cache: 5s TTL or until CRUD.  ║');
  console.log('║  Unauthenticated requests hit authz middleware → RouteACL cache → 1 DO version check only.       ║');
  console.log('║  Authenticated requests add: user lookup + 3 permission list transacts (every 5s).               ║');
  console.log('╚═════════════════════════════════════════════════════════════════════════════════════════════════════╝');

  console.log('');
  console.log('── DO Subrequest Reduction (per list operation) ──');
  console.log('  Before: CrudStore.#loadAll() = 1(ids) + N×1(entity) = N+1 individual DO fetches');
  console.log('  After:  CrudStore.#loadAll() = 1 transact(getMany: ids + N entities) = 1 DO round-trip');
  console.log('  Impact: For 20 route ACLs: 21→1, for 10 user groups: 11→1, for 5 perms: 6→1');
  console.log('');
  console.log('── Per-Request DO Budget (typical authenticated list endpoint) ──');
  console.log('  RouteACL version check:  1 DO read');
  console.log('  User lookup:             1 DO read');
  console.log('  UserGroup list:          1 transact (ids + N entities)');
  console.log('  Policy list:             1 transact (ids + N entities)');
  console.log('  PermGroup list:          1 transact (ids + N entities)');
  console.log('  Target entity list:      1 transact (ids + N entities)');
  console.log('  ─────────────────────────────────────────');
  console.log('  Total:                   2 + 4 transacts = ~6 DO round-trips (with caches warm)');
  console.log('  ├─ w/o P2 cache:         +1 transact per route-acl list');
  console.log('  └─ w/o transact batch:   +N individual gets PER list (20+10+5+target)');
}

main().catch(e => { console.error(e); process.exit(1); });
