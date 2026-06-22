import { join } from 'node:path'; import { tmpdir } from 'node:os';
import { describe, it, expect, beforeEach } from 'vitest';
import { authz, type AuthzConfig, type CurrentUser } from '../../../src/core/middleware/auth.ts';
import { FileKVAtomicStore } from '../../../src/core/store/adapters/file-kv.ts';
import type { IAtomicStore } from '../../../src/core/store/interfaces.ts';

function store() { return new FileKVAtomicStore(join(tmpdir(), 'hbi-test-' + crypto.randomUUID().slice(0, 8))); }

function mockCtx(method: string, path: string, opts?: { token?: string; upgrade?: string; ip?: string }) {
  const reqHeaders: Record<string, string> = {};
  if (opts?.token) reqHeaders['Authorization'] = `Bearer ${opts.token}`;
  if (opts?.upgrade) reqHeaders['Upgrade'] = opts.upgrade;
  if (opts?.ip) reqHeaders['X-Forwarded-For'] = opts.ip;
  const raw = new Request(`http://localhost${path}`, { method, headers: reqHeaders });
  const _var: Record<string, unknown> = { stores: { atomic: undefined }, currentUser: undefined };
  const self: any = {
    req: { method, path, raw, header: (name: string) => raw.headers.get(name) ?? null, query: (name: string) => new URL(raw.url).searchParams.get(name) ?? '' },
    set: (k: string, v: unknown) => { _var[k] = v; },
    var: _var,
    json: (body: any, status?: number) => {
      self.res = new Response(JSON.stringify(body), { status });
      return self.res;
    },
    res: undefined as Response | undefined,
  };
  return self;
}

describe('authz middleware (white-box)', () => {
  let atomicStore: IAtomicStore;

  beforeEach(() => { atomicStore = store(); });

  function makeConfig(overrides?: Partial<AuthzConfig>): AuthzConfig {
    return { store: 'auto', publicPaths: ['/api/public'], ...overrides };
  }

  describe('public path bypass', () => {
    it('skips auth for exact public path match', async () => {
      const mw = authz(makeConfig({ publicPaths: ['/api/health'] }));
      let called = false;
      const c = mockCtx('GET', '/api/health');
      await mw(c, async () => { called = true; });
      expect(called).toBe(true);
    });

    it('skips auth for startsWith public path', async () => {
      const mw = authz(makeConfig({ publicPaths: ['/api/public'] }));
      let called = false;
      const c = mockCtx('GET', '/api/public/resource');
      await mw(c, async () => { called = true; });
      expect(called).toBe(true);
    });

    it('wildcard GET bypass works for avatar paths', async () => {
      const mw = authz(makeConfig({ publicPaths: ['/api/users/*/avatar'] }));
      let called = false;
      const c = mockCtx('GET', '/api/users/user_123/avatar');
      await mw(c, async () => { called = true; });
      expect(called).toBe(true);
    });

    it('wildcard does NOT bypass non-GET requests', async () => {
      const mw = authz(makeConfig({ publicPaths: ['/api/users/*/avatar'] }));
      const c = mockCtx('DELETE', '/api/users/user_123/avatar');
      await mw(c, async () => {});
      expect(c.res?.status || 200).toBe(401);
    });
  });

  describe('token validation', () => {
    it('returns 401 when no Authorization header', async () => {
      const mw = authz(makeConfig());
      const c = mockCtx('GET', '/api/protected');
      await mw(c, async () => {});
      expect(c.res?.status).toBe(401);
    });

    it('returns 401 for empty token', async () => {
      const mw = authz(makeConfig());
      const c = mockCtx('GET', '/api/protected', { token: '' });
      await mw(c, async () => {});
      expect(c.res?.status).toBe(401);
    });

    it('returns 401 for invalid token', async () => {
      const mw = authz({ ...makeConfig(), store: atomicStore });
      const c = mockCtx('GET', '/api/protected', { token: 'invalid-token' });
      await mw(c, async () => {});
      expect(c.res?.status).toBe(401);
    });

    it('returns 401 when session has expired', async () => {
      const mw = authz({ ...makeConfig(), store: atomicStore });
      await atomicStore.set('session:expired-tok', { userId: 'u1', createdAt: Date.now() - 3 * 60 * 60 * 1000 }, null);
      const c = mockCtx('GET', '/api/protected', { token: 'expired-tok' });
      await mw(c, async () => {});
      expect(c.res?.status).toBe(401);
    });
  });

  describe('valid session', () => {
    it('sets currentUser on successful auth', async () => {
      const mw = authz({ ...makeConfig(), store: atomicStore });
      await atomicStore.set('session:valid-tok', { userId: 'u1', createdAt: Date.now() }, null);
      await atomicStore.set('user:u1', { id: 'u1', role: 'root', email: 'test@ex.com' }, null);
      const c = mockCtx('GET', '/api/protected', { token: 'valid-tok' });
      await mw(c, async () => {});
      expect(c.var.currentUser).toBeDefined();
      expect(c.var.currentUser.id).toBe('u1');
      expect(c.var.currentUser.role).toBe('root');
    });

    it('WebSocket falls back to ?token= query param', async () => {
      const mw = authz({ ...makeConfig(), store: atomicStore });
      await atomicStore.set('session:ws-tok', { userId: 'u2', createdAt: Date.now() }, null);
      await atomicStore.set('user:u2', { id: 'u2', role: 'operator', email: 'op@ex.com' }, null);
      const raw = new Request('http://localhost/api/ws?token=ws-tok', { headers: { Upgrade: 'websocket' } });
      const _var: Record<string, unknown> = { stores: { atomic: undefined }, currentUser: undefined };
      const c: any = {
        req: { method: 'GET', path: '/api/ws', raw, header: (name: string) => raw.headers.get(name), query: (name: string) => new URL(raw.url).searchParams.get(name) ?? '' },
        set: (k: string, v: unknown) => { _var[k] = v; },
        var: _var,
        json: (body: any, status?: number) => new Response(JSON.stringify(body), { status }),
      };
      await mw(c, async () => {});
      expect(c.var.currentUser).toBeDefined();
    });
  });

  describe('route ACL check', () => {
    it('passes through when checkRouteAccess returns true', async () => {
      const mw = authz({ ...makeConfig(), store: atomicStore, checkRouteAccess: async () => true });
      await atomicStore.set('session:tok-acl', { userId: 'u3', createdAt: Date.now() }, null);
      await atomicStore.set('user:u3', { id: 'u3', role: 'user', email: 'u@ex.com' }, null);
      let called = false;
      const c = mockCtx('GET', '/api/protected', { token: 'tok-acl' });
      await mw(c, async () => { called = true; });
      expect(called).toBe(true);
    });

    it('returns 403 when checkRouteAccess returns false', async () => {
      const mw = authz({ ...makeConfig(), store: atomicStore, checkRouteAccess: async () => false });
      await atomicStore.set('session:tok-deny', { userId: 'u4', createdAt: Date.now() }, null);
      await atomicStore.set('user:u4', { id: 'u4', role: 'user', email: 'u@ex.com' }, null);
      const c = mockCtx('GET', '/api/protected', { token: 'tok-deny' });
      await mw(c, async () => {});
      expect(c.res?.status).toBe(403);
    });
  });
});
