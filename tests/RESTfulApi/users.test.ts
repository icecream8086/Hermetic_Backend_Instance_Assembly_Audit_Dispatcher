/// <reference types="pactum" />

import { describe, it, beforeAll, afterAll } from 'vitest';
import { spec, request } from 'pactum';
import { startTestServer } from './helper.ts';

let baseUrl: string;
let dispose: () => Promise<void>;

beforeAll(async () => {
  const server = await startTestServer();
  baseUrl = server.baseUrl;
  dispose = server.dispose;
  request.setBaseUrl(baseUrl);
});

afterAll(async () => {
  await dispose();
});

// ─── Register once for all sub-tests ───

const EMAIL = 'users-test@integration.test';
const PASSWORD = 'secret123';

beforeAll(async () => {
  await spec()
    .post('/api/users/register')
    .withJson({ email: EMAIL, password: PASSWORD, name: 'UsersTest', role: 'Viewer' })
    .expectStatus(201)
    .stores('userId', 'data.user.id');
});

// ─── Helpers ───

/** Generate a valid Ed25519 key pair and return { pubB64, privB64 } */
async function generateEd25519Key(): Promise<{ pubB64: string; privB64: string }> {
  const keyPair = await crypto.subtle.generateKey(
    { name: 'Ed25519' },
    true,
    ['sign', 'verify'],
  );
  const pubRaw = new Uint8Array(await crypto.subtle.exportKey('raw', keyPair.publicKey));
  const privRaw = new Uint8Array(await crypto.subtle.exportKey('pkcs8', keyPair.privateKey));
  return {
    pubB64: btoa(String.fromCharCode(...pubRaw)),
    privB64: btoa(String.fromCharCode(...privRaw)),
  };
}

/** Base64url encode */
function b64url(buf: Uint8Array): string {
  return btoa(String.fromCharCode(...buf))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Sign a message with a pkcs8 private key (base64) */
async function signEd25519(message: Uint8Array, privB64: string): Promise<Uint8Array> {
  const privRaw = Uint8Array.from(atob(privB64), c => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('pkcs8', privRaw, { name: 'Ed25519' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, key, message));
}

// ═══════════════════════════════════════
// Login Policy
// ═══════════════════════════════════════

describe('Login Policy', () => {
  it('GET returns default when no policy set', async () => {
    await spec()
      .get('/api/users/$S{userId}/login-policy')
      .expectStatus(200)
      .expectJson('data.enabled', true)
      .expectJson('data.timeRanges', [])
      .expectJson('data.allowedCIDRs', []);
  });

  it('PUT sets a basic policy (disabled)', async () => {
    await spec()
      .put('/api/users/$S{userId}/login-policy')
      .withJson({ enabled: false, timeRanges: [], allowedCIDRs: [] })
      .expectStatus(200)
      .expectJson('data.enabled', false);
  });

  it('GET returns the disabled policy', async () => {
    await spec()
      .get('/api/users/$S{userId}/login-policy')
      .expectStatus(200)
      .expectJson('data.enabled', false);
  });

  it('PUT sets policy with time ranges', async () => {
    await spec()
      .put('/api/users/$S{userId}/login-policy')
      .withJson({
        enabled: true,
        timeRanges: [{ start: '09:00', end: '17:00' }],
        allowedCIDRs: [],
      })
      .expectStatus(200)
      .expectJson('data.enabled', true)
      .expectJson('data.timeRanges[0].start', '09:00')
      .expectJson('data.timeRanges[0].end', '17:00');
  });

  it('PUT sets policy with CIDR restrictions', async () => {
    await spec()
      .put('/api/users/$S{userId}/login-policy')
      .withJson({
        enabled: true,
        timeRanges: [],
        allowedCIDRs: ['10.0.0.0/8', '192.168.0.0/16'],
      })
      .expectStatus(200)
      .expectJson('data.allowedCIDRs', ['10.0.0.0/8', '192.168.0.0/16']);
  });

  it('DELETE clears login policy', async () => {
    await spec()
      .delete('/api/users/$S{userId}/login-policy')
      .expectStatus(200);
  });

  it('GET returns default after delete', async () => {
    await spec()
      .get('/api/users/$S{userId}/login-policy')
      .expectStatus(200)
      .expectJson('data.enabled', true)
      .expectJson('data.timeRanges', [])
      .expectJson('data.allowedCIDRs', []);
  });

  it('PUT with invalid time format returns 400', async () => {
    await spec()
      .put('/api/users/$S{userId}/login-policy')
      .withJson({ enabled: true, timeRanges: [{ start: '9:00', end: '25:00' }], allowedCIDRs: [] })
      .expectStatus(400)
      .expectJson('error.code', 'VALIDATION_ERROR');
  });
});

// ═══════════════════════════════════════
// Public Key
// ═══════════════════════════════════════

describe('Public Key', () => {
  let pubB64: string;
  let privB64: string;

  beforeAll(async () => {
    const keys = await generateEd25519Key();
    pubB64 = keys.pubB64;
    privB64 = keys.privB64;
  });

  it('GET returns null when no key set', async () => {
    await spec()
      .get('/api/users/$S{userId}/public-key')
      .expectStatus(200)
      .expectJson('data', null);
  });

  it('PUT sets a valid public key', async () => {
    await spec()
      .put('/api/users/$S{userId}/public-key')
      .withJson({ publicKey: pubB64 })
      .expectStatus(200)
      .expectJson('data', pubB64);
  });

  it('GET returns the key after set', async () => {
    await spec()
      .get('/api/users/$S{userId}/public-key')
      .expectStatus(200)
      .expectJson('data', pubB64);
  });

  it('PUT with invalid key format returns 400', async () => {
    await spec()
      .put('/api/users/$S{userId}/public-key')
      .withJson({ publicKey: 'not-a-valid-base64-key!' })
      .expectStatus(400)
      .expectJson('error.code', 'VALIDATION_ERROR');
  });

  it('PUT with empty key returns 400', async () => {
    await spec()
      .put('/api/users/$S{userId}/public-key')
      .withJson({ publicKey: '' })
      .expectStatus(400);
  });

  it('DELETE clears public key', async () => {
    await spec()
      .delete('/api/users/$S{userId}/public-key')
      .expectStatus(200);
  });

  it('GET returns null after delete', async () => {
    await spec()
      .get('/api/users/$S{userId}/public-key')
      .expectStatus(200)
      .expectJson('data', null);
  });

  it('PUT then re-set different key', async () => {
    const keys2 = await generateEd25519Key();
    await spec()
      .put('/api/users/$S{userId}/public-key')
      .withJson({ publicKey: keys2.pubB64 })
      .expectStatus(200)
      .expectJson('data', keys2.pubB64);
  });
});

// ═══════════════════════════════════════
// No-Password Login
// ═══════════════════════════════════════

describe('No-Password Login', () => {
  let pubB64: string;
  let privB64: string;

  beforeAll(async () => {
    const keys = await generateEd25519Key();
    pubB64 = keys.pubB64;
    privB64 = keys.privB64;
    // Set the public key on the test user
    await spec()
      .put('/api/users/$S{userId}/public-key')
      .withJson({ publicKey: pubB64 })
      .expectStatus(200);
  });

  /** Build a oneTimeKey for the given email, signed with privB64. */
  async function makeOneTimeKey(email: string, privB64: string, ts?: number): Promise<string> {
    const t = ts ?? Math.floor(Date.now() / 1000);
    const tsB64url = btoa(String(t)).replace(/=+$/, '');
    const nonceBytes = crypto.getRandomValues(new Uint8Array(16));
    const nonceB64url = b64url(nonceBytes);

    // Signature is over: `${ts}${email}` + nonceBytes
    const msg = new TextEncoder().encode(`${t}${email}`);
    const payload = new Uint8Array(msg.length + nonceBytes.length);
    payload.set(msg, 0);
    payload.set(nonceBytes, msg.length);
    const sig = await signEd25519(payload, privB64);
    const sigB64url = b64url(sig);

    return `${sigB64url}.${tsB64url}.${nonceB64url}`;
  }

  it('returns 403 when no public key configured', async () => {
    await spec()
      .post('/api/users/register')
      .withJson({ email: 'nopk@integration.test', password: 'testpass123', name: 'NoPK', role: 'Viewer' })
      .expectStatus(201);

    // Use a valid oneTimeKey structure so we pass format checks and reach NO_PUBLIC_KEY
    const ts = Math.floor(Date.now() / 1000);
    const tsB64url = btoa(String(ts)).replace(/=+$/, '');
    await spec()
      .post('/api/users/no-password-login')
      .withJson({ email: 'nopk@integration.test', oneTimeKey: `AAAA.${tsB64url}.AAAA` })
      .expectStatus(403)
      .expectJson('error.code', 'NO_PUBLIC_KEY');
  });

  it('returns 400 for malformed oneTimeKey', async () => {
    await spec()
      .post('/api/users/no-password-login')
      .withJson({ email: EMAIL, oneTimeKey: 'invalid' })
      .expectStatus(400)
      .expectJson('error.code', 'BAD_KEY_FORMAT');
  });

  it('returns 403 for expired oneTimeKey (timestamp too old)', async () => {
    const oldTs = Math.floor(Date.now() / 1000) - 120; // 2 min ago, past 30s window
    const oneTimeKey = await makeOneTimeKey(EMAIL, privB64, oldTs);

    await spec()
      .post('/api/users/no-password-login')
      .withJson({ email: EMAIL, oneTimeKey })
      .expectStatus(403)
      .expectJson('error.code', 'KEY_EXPIRED');
  });

  it('full no-password login flow succeeds', async () => {
    const oneTimeKey = await makeOneTimeKey(EMAIL, privB64);

    await spec()
      .post('/api/users/no-password-login')
      .withJson({ email: EMAIL, oneTimeKey })
      .expectStatus(200)
      .expectJson('data.user.email', EMAIL)
      .expect((ctx) => {
        const token = ctx.res.body?.data?.token;
        if (typeof token !== 'string' || token.length === 0) {
          throw new Error('Expected non-empty token');
        }
      });
  });

  it('rejects replayed nonce', async () => {
    const oneTimeKey = await makeOneTimeKey(EMAIL, privB64);

    // First use succeeds
    await spec()
      .post('/api/users/no-password-login')
      .withJson({ email: EMAIL, oneTimeKey })
      .expectStatus(200);

    // Second use with same nonce → replay detected
    await spec()
      .post('/api/users/no-password-login')
      .withJson({ email: EMAIL, oneTimeKey })
      .expectStatus(403)
      .expectJson('error.code', 'REPLAY_DETECTED');
  });

  it('returns 403 for wrong signature', async () => {
    const wrongKeys = await generateEd25519Key();
    const oneTimeKey = await makeOneTimeKey(EMAIL, wrongKeys.privB64);

    await spec()
      .post('/api/users/no-password-login')
      .withJson({ email: EMAIL, oneTimeKey })
      .expectStatus(403)
      .expectJson('error.code', 'BAD_SIGNATURE');
  });
});
