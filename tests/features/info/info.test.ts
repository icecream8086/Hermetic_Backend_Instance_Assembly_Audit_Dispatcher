import { describe, it, expect } from 'vitest';
import { createInfoHandler } from '../../../src/features/info/info.handler.ts';

describe('GET /info', () => {
  const app = createInfoHandler();

  it('returns 200 with server info', async () => {
    const res = await app.request('/info');
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body).toMatchObject({
      name: 'HBI-AAD',
      version: '4.0.0',
      platform: 'cloudflare-workers',
      features: {
        sandbox: true,
        assembly: true,
        audit: true,
      },
    });
    expect(body).toHaveProperty('description');
    expect(body).toHaveProperty('uptime');
    expect(typeof body.uptime).toBe('number');
  });

  it('returns 404 for unknown routes', async () => {
    const res = await app.request('/info/nope');
    expect(res.status).toBe(404);
  });
});
