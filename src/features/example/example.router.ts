import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import type { AppContext } from '../../core/app.ts';
import { ExampleHandler } from './example.handler.ts';
import { ExampleService } from './example.service.ts';
import { CreateOrderSchema } from './example.schema.ts';

export function createExampleRouter(handler: ExampleHandler) {
  const router = new Hono<{ Variables: AppContext }>();

  router.post('/', zValidator('json', CreateOrderSchema), (c) => {
    const input = c.req.valid('json');
    return c.json(handler.create(input), 201);
  });

  router.get('/:id', (c) => {
    const id = c.req.param('id') ?? '';
    return c.json(handler.getById(id));
  });

  return router;
}

export type { ExampleService, ExampleHandler };
