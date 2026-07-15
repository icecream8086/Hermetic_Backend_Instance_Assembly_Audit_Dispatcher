import { describe, it, expect } from 'vitest';
import { createInfoHandler } from '../../../src/features/info/info.handler.ts';
import { AtomicStoreMetrics } from '../../../src/core/store/metrics.ts';

describe('GET /info', () => {
  const mockStores = { metrics: new AtomicStoreMetrics() } as any;
  const app = createInfoHandler(mockStores);

  it('returns 200 with server info', async () => {
    const res = await app.request('/info');
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body).toMatchObject({
      success: true,
      data: {
        name: 'HBI-AAD',
        version: '4.0.0',
        platform: 'cloudflare-workers',
        features: { pod: true, assembly: true, audit: true },
      },
      error: null,
    });
    expect(body.data).toHaveProperty('description');
    expect(body.data).toHaveProperty('uptime');
    expect(typeof body.data.uptime).toBe('number');
  });

  it('returns 404 for unknown routes', async () => {
    const res = await app.request('/info/nope');
    expect(res.status).toBe(404);
  });
});
