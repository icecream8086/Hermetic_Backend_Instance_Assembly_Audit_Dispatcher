import { describe, it, expect } from 'vitest';
import { authorizeAccess } from '../../../src/core/security/jwt.ts';
import { signToken, verifyToken } from '../../../src/core/security/jwt.ts';
import type { S3AccessTokenClaims } from '../../../src/core/security/types.ts';

function c(grants: S3AccessTokenClaims['grants']): S3AccessTokenClaims {
  return { jti: 't', iss: 'hbi-aad', sub: 's', iat: 0, exp: 1e10, grants };
}

const G = {
  read: { bucket: 'b1', prefix: 'data/', permissions: ['read'] as const },
  write: { bucket: 'b1', prefix: 'data/', permissions: ['write'] as const },
  rw: { bucket: 'b1', prefix: 'data/', permissions: ['read', 'write'] as const },
  list: { bucket: 'b1', prefix: '', permissions: ['list'] as const },
  full: { bucket: 'b1', prefix: '', permissions: ['read', 'write', 'list'] as const },
};

// ─── 授权矩阵穷举 ───
// 维度: bucket 匹配否 / 前缀命中否 / perm 请求 vs 授予 / key 状态
// 每个用例 = (描述, grants, bucket, key, perm, 期望) 覆盖一格

type MatrixCase = [string, typeof G.rw[], string, string | null, 'read' | 'write' | 'list', boolean];

const MATRIX: MatrixCase[] = [
  // ── Bucket 匹配 + 前缀命中 + perm 授予 → ALLOW ──
  ['bucket匹配+前缀精确+read授予', [G.rw], 'b1', 'data/f', 'read', true],
  ['bucket匹配+前缀精确+write授予', [G.rw], 'b1', 'data/f', 'write', true],
  ['bucket匹配+前缀精确+list授予', [G.list], 'b1', null, 'list', true],
  ['bucket匹配+子路径+read授予', [G.rw], 'b1', 'data/sub/f', 'read', true],
  ['bucket匹配+空前缀+read授予', [G.full], 'b1', 'any/key', 'read', true],
  ['bucket匹配+空前缀+write授予', [G.full], 'b1', 'any/key', 'write', true],
  ['bucket匹配+空前缀+list授予', [G.full], 'b1', null, 'list', true],

  // ── Bucket 匹配 + 前缀命中 + perm 未授予 → DENY ──
  ['bucket匹配+前缀精确+read未授予', [G.write], 'b1', 'data/f', 'read', false],
  ['bucket匹配+前缀精确+write未授予', [G.read], 'b1', 'data/f', 'write', false],
  ['bucket匹配+前缀精确+list未授予', [G.rw], 'b1', null, 'list', false],

  // ── Bucket 匹配 + 前缀未命中 → DENY ──
  ['bucket匹配+前缀未命中(兄弟路径)+read授予', [G.rw], 'b1', 'other/f', 'read', false],
  ['bucket匹配+前缀未命中(兄弟路径)+write授予', [G.rw], 'b1', 'other/f', 'write', false],

  // ── Bucket 匹配 + key=null 对 read/write → DENY —────────────────
  ['bucket匹配+key=null+read請求', [G.rw], 'b1', null, 'read', false],
  ['bucket匹配+key=null+write請求', [G.rw], 'b1', null, 'write', false],

  // ── Bucket 不匹配 → DENY ─────────────────
  ['bucket不匹配+任意+read', [G.rw], 'other-b', 'data/f', 'read', false],
  ['bucket不匹配+任意+write', [G.rw], 'other-b', 'data/f', 'write', false],
  ['bucket不匹配+任意+list', [G.list], 'other-b', null, 'list', false],

  // ── 空 grants → DENY ─────────────────
  ['空grants+any', [], 'b1', 'data/f', 'read', false],
];

describe('授权矩阵穷举 — authorizeAccess 决策表', () => {
  it.each(MATRIX)('%s', (_desc, grants, bucket, key, perm, expected) => {
    expect(authorizeAccess(c(grants), bucket, key, perm).allowed).toBe(expected);
  });
});

// ─── 多 Grant 同 bucket → some() 语义 ───

const MULTI_GRANT: MatrixCase[] = [
  ['多grant同bucket-第二grant前缀匹配', [
    { bucket: 'b1', prefix: 'data/', permissions: ['read'] as const },
    { bucket: 'b1', prefix: 'logs/', permissions: ['read'] as const },
  ], 'b1', 'logs/x', 'read', true],
  ['多grant同bucket-第二grant perm匹配', [
    { bucket: 'b1', prefix: 'data/', permissions: ['read'] as const },
    { bucket: 'b1', prefix: 'data/', permissions: ['write'] as const },
  ], 'b1', 'data/x', 'write', true],
  ['多grant同bucket-皆不匹配', [
    { bucket: 'b1', prefix: 'data/', permissions: ['read'] as const },
    { bucket: 'b1', prefix: 'logs/', permissions: ['read'] as const },
  ], 'b1', 'other/f', 'read', false],
  ['多grant异bucket-第二grant匹配', [
    { bucket: 'other', prefix: '', permissions: ['read'] as const },
    G.rw,
  ], 'b1', 'data/f', 'read', true],
];

describe('授权矩阵穷举 — 多 grant some() 语义', () => {
  it.each(MULTI_GRANT)('%s', (_desc, grants, bucket, key, perm, expected) => {
    expect(authorizeAccess(c(grants), bucket, key, perm).allowed).toBe(expected);
  });
});

// ─── deny reason 非空 ───

describe('授权矩阵穷举 — deny reason', () => {
  it('返回言之有物的 reason', () => {
    const r = authorizeAccess(c([G.rw]), 'no-such-b', 'data/f', 'read');
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect(r.reason).toContain('no-such-b');
  });
});

// ─── JWT 层攻击向量（过期/篡改/畸形 经 sign→verify→authorize 链） ───

const SECRET = crypto.getRandomValues(new Uint8Array(32));

function validClaims(grants?: S3AccessTokenClaims['grants']): S3AccessTokenClaims {
  return {
    jti: crypto.randomUUID(), iss: 'hbi-aad', sub: 'sandbox',
    iat: Math.floor(Date.now() / 1000) - 10,
    exp: Math.floor(Date.now() / 1000) + 3600,
    grants: grants ?? [G.rw],
  };
}

describe('授权矩阵穷举 — JWT 攻击向量（sign→verify→authorize 链）', () => {
  it('正常 JWT + 合法授权 → ALLOW', async () => {
    const token = await signToken(validClaims(), SECRET);
    const v = await verifyToken(token, SECRET);
    expect(v.valid).toBe(true);
    if (v.valid) {
      expect(authorizeAccess(v.claims, 'b1', 'data/f', 'read').allowed).toBe(true);
    }
  });

  it('过期 JWT → verify 拒绝', async () => {
    const expiredClaims = validClaims();
    expiredClaims.exp = Math.floor(Date.now() / 1000) - 60;
    const token = await signToken(expiredClaims, SECRET);
    const v = await verifyToken(token, SECRET);
    expect(v.valid).toBe(false);
  });

  it('篡改 payload → verify 拒绝', async () => {
    const token = await signToken(validClaims(), SECRET);
    const parts = token.split('.');
    const badPayload = btoa(JSON.stringify({ ...validClaims(), sub: 'hacker' }))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const tampered = [parts[0], badPayload, parts[2]].join('.');
    const v = await verifyToken(tampered, SECRET);
    expect(v.valid).toBe(false);
  });

  it('畸形 token → verify 拒绝', async () => {
    const v = await verifyToken('not-a-jwt', SECRET);
    expect(v.valid).toBe(false);
  });

  it('异密钥签名 → verify 拒绝', async () => {
    const other = crypto.getRandomValues(new Uint8Array(32));
    const token = await signToken(validClaims(), other);
    const v = await verifyToken(token, SECRET);
    expect(v.valid).toBe(false);
  });
});
