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

let parentId: string;
let childId: string;

describe('Template DAG inheritance', () => {
  it('create parent template with base container spec', async () => {
    await spec()
      .post('/api/templates/')
      .withJson({
        name: 'base-nginx',
        container: {
          region: 'cn-hangzhou',
          containers: [
            { name: 'nginx', image: 'nginx:latest', ports: [{ containerPort: 80 }] },
            { name: 'sidecar', image: 'busybox', command: ['sleep', '3600'] },
          ],
          restartPolicy: 'Always',
        },
        network: { publicIp: { allocate: true } },
      })
      .expectStatus(201)
      .expect((ctx) => { parentId = ctx.res.body?.data?.id; });
  });

  it('create child template inheriting from parent with overrides', async () => {
    await spec()
      .post('/api/templates/')
      .withJson({
        name: 'custom-nginx',
        dependsOn: [parentId],
        container: {
          region: 'us-west-1',
          containers: [
            { name: 'nginx', image: 'nginx:alpine', resources: { limits: { cpu: 2, memory: 1024 } } },
            { name: 'logger', image: 'fluentd', env: [{ name: 'FLUENTD_CONF', value: 'custom.conf' }] },
          ],
        },
      })
      .expectStatus(201)
      .expect((ctx) => { childId = ctx.res.body?.data?.id; });
  });

  it('resolved template merges inherited containers by name', async () => {
    await spec()
      .get(`/api/templates/${childId}/resolved`)
      .expectStatus(200)
      .expect((ctx) => {
        const data = ctx.res.body?.data;
        if (!data) throw new Error('No data');

        const container = data.container;
        if (!container) throw new Error('No container block');

        // Child overrides region
        if (container.region !== 'us-west-1') throw new Error(`Expected us-west-1, got ${container.region}`);

        // restartPolicy inherited from parent
        if (container.restartPolicy !== 'Always') throw new Error('restartPolicy should be inherited');

        // Containers merged by name: nginx from child, sidecar from parent
        const containers = container.containers;
        if (!containers || containers.length !== 3) throw new Error(`Expected 3 containers, got ${containers?.length}`);

        const nginx = containers.find((c: any) => c.name === 'nginx');
        if (!nginx) throw new Error('nginx container missing');
        if (nginx.image !== 'nginx:alpine') throw new Error(`nginx image should be overridden to alpine, got ${nginx.image}`);
        if (nginx.resources?.limits?.cpu !== 2) throw new Error('nginx resources from child missing');

        const sidecar = containers.find((c: any) => c.name === 'sidecar');
        if (!sidecar) throw new Error('sidecar container missing (should inherit from parent)');
        if (sidecar.image !== 'busybox') throw new Error('sidecar image should be inherited');

        const logger = containers.find((c: any) => c.name === 'logger');
        if (!logger) throw new Error('logger container missing (from child)');
        if (logger.env?.[0]?.value !== 'custom.conf') throw new Error('logger env should be from child');

        // network inherited from parent
        if (!data.network?.publicIp?.allocate) throw new Error('network.publicIp.allocate should be inherited from parent');
      });
  });

  it('resolve non-existent template returns 404', async () => {
    await spec()
      .get('/api/templates/nonexistent/resolved')
      .expectStatus(404);
  });
});

describe('deepMerge by-name container merging', () => {
  it('create grandchild that further overrides', async () => {
    let grandchildId: string;
    await spec()
      .post('/api/templates/')
      .withJson({
        name: 'grandchild',
        dependsOn: [childId],
        container: {
          containers: [
            { name: 'nginx', env: [{ name: 'NGINX_HOST', value: 'example.com' }] },
          ],
        },
      })
      .expectStatus(201)
      .expect((ctx) => { grandchildId = ctx.res.body?.data?.id; });

    // Resolve grandchild — should have 3 containers, nginx has env from grandchild + image from child + ports from parent
    await spec()
      .get(`/api/templates/${grandchildId}/resolved`)
      .expectStatus(200)
      .expect((ctx) => {
        const data = ctx.res.body?.data;
        if (!data) throw new Error('No data');

        const container = data.container;
        if (!container) throw new Error('No container block');

        const containers = container.containers;
        if (!containers || containers.length !== 3) throw new Error(`Expected 3 containers, got ${containers?.length}`);

        const nginx = containers.find((c: any) => c.name === 'nginx');
        if (!nginx) throw new Error('nginx missing');
        if (nginx.image !== 'nginx:alpine') throw new Error('image should be from child');
        const env = nginx.env?.find?.((e: any) => e.name === 'NGINX_HOST');
        if (!env || env.value !== 'example.com') throw new Error('env should be from grandchild');
        if (!nginx.ports?.length) throw new Error('ports should be from grandparent');
      });
  });
});
