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
        spec: {
          metadata: { name: 'base-nginx' },
          spec: {
            containers: [
              { name: 'nginx', image: 'nginx:latest', ports: [{ containerPort: 80 }] },
              { name: 'sidecar', image: 'busybox', command: ['sleep', '3600'] },
            ],
            restartPolicy: 'Always',
          },
        },
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
        spec: {
          metadata: { name: 'custom-nginx' },
          spec: {
            containers: [
              { name: 'nginx', image: 'nginx:alpine', resources: { limits: { cpu: 2, memory: 1024 } } },
              { name: 'logger', image: 'fluentd', env: [{ name: 'FLUENTD_CONF', value: 'custom.conf' }] },
            ],
            restartPolicy: 'Always',
          },
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

        const spec = data.spec?.spec;
        if (!spec) throw new Error('No spec block');

        const containers = spec.containers;
        if (!containers || containers.length !== 3) throw new Error(`Expected 3 containers, got ${containers?.length}`);

        const nginx = containers.find((c: any) => c.name === 'nginx');
        if (!nginx) throw new Error('nginx container missing');
        if (nginx.image !== 'nginx:alpine') throw new Error('nginx image should be overridden to alpine');
        if (nginx.resources?.limits?.cpu !== 2) throw new Error('nginx resources from child missing');

        const sidecar = containers.find((c: any) => c.name === 'sidecar');
        if (!sidecar) throw new Error('sidecar container missing (should inherit from parent)');
        if (sidecar.image !== 'busybox') throw new Error('sidecar image should be inherited');

        const logger = containers.find((c: any) => c.name === 'logger');
        if (!logger) throw new Error('logger container missing (from child)');
        if (logger.env?.[0]?.value !== 'custom.conf') throw new Error('logger env should be from child');

        if (spec.restartPolicy !== 'Always') throw new Error('restartPolicy should be inherited');
      });
  });

  it('resolve non-existent template returns 404', async () => {
    await spec()
      .get('/api/templates/nonexistent/resolved')
      .expectStatus(404);
  });
});

describe('deepMerge by-name container merging', () => {
  // ponytail: ports from grandparent needs field-level container merge (ISSUE-00065 step 3), current identity merge loses them.
  it('create grandchild that further overrides', async () => {
    let grandchildId: string;
    await spec()
      .post('/api/templates/')
      .withJson({
        name: 'grandchild',
        dependsOn: [childId],
        spec: {
          metadata: { name: 'grandchild' },
          spec: {
            containers: [
              { name: 'nginx', image: 'nginx:alpine', env: [{ name: 'NGINX_HOST', value: 'example.com' }] },
            ],
            restartPolicy: 'Always',
          },
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

        const spec = data.spec?.spec;
        if (!spec) throw new Error('No spec block');

        const containers = spec.containers;
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

describe('diamond DAG merge', () => {
  let diamondAId: string;
  let diamondBId: string;
  let diamondCId: string;
  let diamondDId: string;

  it('create template A (base — image nginx:1.0, ports [80], env FOO=a)', async () => {
    await spec()
      .post('/api/templates/')
      .withJson({
        name: 'diamond-base',
        spec: {
          metadata: { name: 'diamond-base' },
          spec: {
            containers: [
              {
                name: 'app',
                image: 'nginx:1.0',
                ports: [{ containerPort: 80 }],
                env: [{ name: 'FOO', value: 'a' }],
              },
            ],
            restartPolicy: 'Always',
          },
        },
      })
      .expectStatus(201)
      .expect((ctx) => { diamondAId = ctx.res.body?.data?.id; });
  });

  it('create template B depending on A (overrides image, adds env BAR)', async () => {
    await spec()
      .post('/api/templates/')
      .withJson({
        name: 'diamond-b',
        dependsOn: [diamondAId],
        spec: {
          metadata: { name: 'diamond-b' },
          spec: {
            containers: [
              {
                name: 'app',
                image: 'nginx:2.0',
                env: [{ name: 'BAR', value: 'b' }],
              },
            ],
            restartPolicy: 'Always',
          },
        },
      })
      .expectStatus(201)
      .expect((ctx) => { diamondBId = ctx.res.body?.data?.id; });
  });

  it('create template C depending on A (overrides ports to [8080], adds env BAZ)', async () => {
    await spec()
      .post('/api/templates/')
      .withJson({
        name: 'diamond-c',
        dependsOn: [diamondAId],
        spec: {
          metadata: { name: 'diamond-c' },
          spec: {
            containers: [
              {
                name: 'app',
                image: 'nginx:1.0',
                ports: [{ containerPort: 8080 }],
                env: [{ name: 'BAZ', value: 'c' }],
              },
            ],
            restartPolicy: 'Always',
          },
        },
      })
      .expectStatus(201)
      .expect((ctx) => { diamondCId = ctx.res.body?.data?.id; });
  });

  it('create and resolve D — multi-ancestor field-level merge', async () => {
    let dId: string;
    await spec()
      .post('/api/templates/')
      .withJson({
        name: 'diamond-d',
        dependsOn: [diamondBId, diamondCId],
        spec: {
          metadata: { name: 'diamond-d' },
          spec: {
            containers: [
              {
                name: 'app',
                image: 'nginx:2.0',
                env: [{ name: 'FOO', value: 'a-override' }],
              },
            ],
            restartPolicy: 'Always',
          },
        },
      })
      .expectStatus(201)
      .expect((ctx) => { dId = ctx.res.body?.data?.id; });
    if (!dId) throw new Error('diamondDId not set');

    await spec()
      .get(`/api/templates/${dId}/resolved`)
      .expectStatus(200)
      .expect((ctx) => {
        const data = ctx.res.body?.data;
        if (!data) throw new Error('No data');

        const spec = data.spec?.spec;
        if (!spec) throw new Error('No spec block');

        const containers = spec.containers;
        if (!containers || containers.length !== 1) throw new Error(`Expected 1 container, got ${containers?.length}`);

        const app = containers.find((c: any) => c.name === 'app');
        if (!app) throw new Error('app container missing');

        // image from D (B's image 2.0, propagated to D)
        if (app.image !== 'nginx:2.0') throw new Error(`Expected image nginx:2.0, got ${app.image}`);

        // ports from C (nearest ancestor that sets ports — A's [80] correctly overridden)
        if (!app.ports || app.ports[0]?.containerPort !== 8080) throw new Error(`Expected ports [8080] from C`);

        // env: D's env replaces ancestor env at field level
        const fooEnv = app.env?.find((e: any) => e.name === 'FOO');
        if (!fooEnv || fooEnv.value !== 'a-override') throw new Error(`Expected FOO=a-override from D`);
      });
  });

  it.skip('merge is idempotent and associative', () => {
    // Blocked: needs direct import of mergeContainersByIdentity from core module.
    // See .oracle/tests/test_pod_merge.py for PBT coverage; ISSUE-00016 tracks unit-test migration.
    // Would verify merge(a, merge(b, c)) === merge(merge(a, b), c) for identity resolution.
  });
});

describe('cycle detection regression', () => {
  it('self-dependency X→X returns 400 CYCLE_DETECTED', async () => {
    let xId: string;
    await spec()
      .post('/api/templates/')
      .withJson({
        name: 'self-cycle',
        spec: { metadata: { name: 'self-cycle' }, spec: { containers: [{ name: 'a', image: 'x' }], restartPolicy: 'Always' } },
      })
      .expectStatus(201)
      .expect((ctx) => { xId = ctx.res.body?.data?.id; });
    // Create dependency on itself
    await spec()
      .put('/api/templates/' + xId)
      .withJson({ dependsOn: [xId] })
      .expectStatus(200);
    // Resolving should detect cycle
    await spec()
      .get('/api/templates/' + xId + '/resolved')
      .expectStatus(400)
      .expect((ctx) => {
        if (ctx.res.body?.error?.code !== 'CYCLE_DETECTED') throw new Error('Expected CYCLE_DETECTED');
      });
  });

  it('mutual dependency A↔B returns 400 CYCLE_DETECTED', async () => {
    let aId: string, bId: string;
    await spec()
      .post('/api/templates/')
      .withJson({
        name: 'cycle-a',
        spec: { metadata: { name: 'cycle-a' }, spec: { containers: [{ name: 'a', image: 'x' }], restartPolicy: 'Always' } },
      })
      .expectStatus(201)
      .expect((ctx) => { aId = ctx.res.body?.data?.id; });
    await spec()
      .post('/api/templates/')
      .withJson({
        name: 'cycle-b',
        dependsOn: [aId],
        spec: { metadata: { name: 'cycle-b' }, spec: { containers: [{ name: 'b', image: 'y' }], restartPolicy: 'Always' } },
      })
      .expectStatus(201)
      .expect((ctx) => { bId = ctx.res.body?.data?.id; });
    // Make A depend on B → A↔B cycle
    await spec()
      .put('/api/templates/' + aId)
      .withJson({ dependsOn: [bId] })
      .expectStatus(200);
    // Resolving either should detect cycle
    await spec()
      .get('/api/templates/' + aId + '/resolved')
      .expectStatus(400)
      .expect((ctx) => {
        if (ctx.res.body?.error?.code !== 'CYCLE_DETECTED') throw new Error('Expected CYCLE_DETECTED');
      });
  });

  it('linear chain A→B→C does NOT detect false cycle', async () => {
    let aId: string, bId: string;
    await spec()
      .post('/api/templates/')
      .withJson({ name: 'chain-a', spec: { metadata: { name: 'chain-a' }, spec: { containers: [{ name: 'a', image: 'x' }], restartPolicy: 'Always' } } })
      .expectStatus(201)
      .expect((ctx) => { aId = ctx.res.body?.data?.id; });
    await spec()
      .post('/api/templates/')
      .withJson({ name: 'chain-b', dependsOn: [aId], spec: { metadata: { name: 'chain-b' }, spec: { containers: [{ name: 'b', image: 'y' }], restartPolicy: 'Always' } } })
      .expectStatus(201)
      .expect((ctx) => { bId = ctx.res.body?.data?.id; });

    // Verify linear chain resolves fine (no false cycle)
    await spec()
      .get('/api/templates/' + bId + '/resolved')
      .expectStatus(200);
  });
});
