import { createApp, type AppInstance } from './core/app.ts';
import { loadConfig } from './config/env.ts';

// DO classes must be exported at module scope for wrangler to discover them
export { AtomicStoreDO } from './core/store/adapters/durable-object.ts';
export { AlarmTimerDO } from './core/scheduler/alarm-timer-do.ts';
export { NotificationDO } from './core/notification/do.ts';

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
    _appPromise = createApp(config, platformBindings) as Promise<AppInstance>;
  }
  return _appPromise;
}

export default {
  async fetch(request: Request, env: Record<string, unknown>) {
    const instance = await getApp(env);
    return instance.app.fetch(request, env);
  },
};
