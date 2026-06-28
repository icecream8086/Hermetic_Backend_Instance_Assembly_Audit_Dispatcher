import { createApp, type AppInstance } from './core/app.ts';
import { loadConfig } from './config/env.ts';
import type { TaskMessage } from './queue/types.ts';

// DO classes must be exported at module scope for wrangler to discover them
export { AtomicStoreDO } from './core/store/adapters/durable-object.ts';
export { AlarmTimerDO } from './core/scheduler/alarm-timer-do.ts';
export { NotificationDO } from './core/notification/do.ts';
export { LogStreamDO } from './features/sandbox/log-stream-do.ts';

let _appPromise: Promise<AppInstance> | null = null;

function getApp(platformBindings: Record<string, unknown>): Promise<AppInstance> {
  if (!_appPromise) {
    // Merge platform env bindings into process.env for env.ts to pick up.
    // In Miniflare, .env vars are injected as Worker bindings (env.XXX), not
    // process.env — so we copy them over before loadConfig() reads them.
    for (const key of Object.keys(platformBindings)) {
      if (typeof platformBindings[key] === 'string' && !(key in process.env)) {
        (process.env as any)[key] = platformBindings[key];
      }
    }
    const config = loadConfig();
    _appPromise = createApp(config, platformBindings);
  }
  return _appPromise;
}

export default {
  async fetch(request: Request, env: Record<string, unknown>, ctx: ExecutionContext) {
    const instance = await getApp(env);
    const response = await instance.app.fetch(request, env);
    // Background seeding: policy lib, default instance, templates.
    // Does NOT block the first response — runs via ctx.waitUntil().
    ctx.waitUntil(instance.seed());
    return response;
  },

  // ─── Queue consumer ───
  // Cloudflare platform invokes this when messages arrive on the TASK_QUEUE.
  // Each message gets its own CPU budget — heavy tasks (image pull, GC) run
  // here so they don't compete with API response latency.
  async queue(batch: MessageBatch<TaskMessage>, env: Record<string, unknown>, ctx: ExecutionContext) {
    const { processTaskBatch } = await import('./queue/consumer.ts');
    await processTaskBatch(batch, () => getApp(env));
    ctx.waitUntil(Promise.resolve()); // acknowledge platform invocation
  },
};
