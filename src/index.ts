import { createApp, type AppInstance } from './core/app.ts';
import { loadConfig } from './config/env.ts';

// DO classes must be exported at module scope for wrangler to discover them
export { AtomicStoreDO } from './core/store/adapters/durable-object.ts';
export { AlarmTimerDO } from './core/scheduler/alarm-timer-do.ts';

const config = loadConfig();

let _appPromise: Promise<AppInstance> | null = null;

function getApp(platformBindings: Record<string, unknown>): Promise<AppInstance> {
  if (!_appPromise) {
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
