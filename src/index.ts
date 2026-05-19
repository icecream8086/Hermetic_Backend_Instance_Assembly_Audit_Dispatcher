import { createApp } from './core/app.ts';
import { loadConfig } from './config/env.ts';

// DO classes must be exported at module scope for wrangler to discover them
export { AtomicStoreDO } from './core/store/adapters/durable-object.ts';
export { AlarmTimerDO } from './core/scheduler/alarm-timer-do.ts';

const config = loadConfig();

let _app: ReturnType<typeof createApp> | null = null;

function getApp(platformBindings: Record<string, unknown>) {
  if (_app) return _app;
  _app = createApp(config, platformBindings);
  return _app;
}

export default {
  async fetch(request: Request, env: Record<string, unknown>) {
    const { app } = getApp(env);
    return app.fetch(request, env);
  },
};
