/// <reference types="@cloudflare/workers-types" />

import type { IMessageQueue } from './interfaces.ts';
import { CfQueueProducer } from './cf-queue.ts';
import { NoopMessageQueue } from './noop-queue.ts';

/**
 * Create the appropriate message queue producer for the current environment.
 *
 * - TASK_QUEUE binding present → CfQueueProducer (Cloudflare Queues)
 * - binding absent               → NoopMessageQueue  (dev without wrangler)
 */
export function createMessageQueue(binding?: Queue<any>): IMessageQueue {
  if (binding) return new CfQueueProducer(binding);
  return new NoopMessageQueue();
}

// ─── Backward-compatible re-export ───
// Existing code that imports QueueProducer can keep working during migration.
export { CfQueueProducer as QueueProducer } from './cf-queue.ts';
