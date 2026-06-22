/// <reference types="@cloudflare/workers-types" />

import { EventBus } from './bus.ts';

/**
 * Bridge 层：将 EventBus 内部事件投射到 NotificationDO 进行 WebSocket 广播。
 *
 * 初始化时注册一组 EventBus handler，每个 handler 通过 fetch 调用
 * NotificationDO 的 /broadcast 端点将事件推送给所有在线 WebSocket 客户端。
 *
 * 现有代码完全不感知此桥接的存在——EventBus 的 on() 是标准 pub/sub 接口。
 */
export class DoBridge {
  constructor(
    bus: EventBus,
    private readonly notifDO: DurableObjectNamespace,
  ) {
    bus.on('sandbox.provisioned', this.#forward('sandbox.provisioned'));
    bus.on('sandbox.status', this.#forward('sandbox.status'));
    // Action system events
    bus.on('workflow:completed', this.#forward('workflow:completed'));
    bus.on('workflow:job:status', this.#forward('workflow:job:status'));
  }

  /** Create a handler that forwards an event to NotificationDO for broadcast. */
  #forward(eventType: string) {
    return async (event: { type: string; payload?: unknown }): Promise<void> => {
      try {
        const stub = this.notifDO.get(this.notifDO.idFromName('notif:global'));
        await stub.fetch('https://do/broadcast', {
          method: 'POST',
          body: JSON.stringify({ type: eventType, data: event.payload }),
        });
      } catch (err) {
        console.error(`[DoBridge] Failed to broadcast ${eventType}:`, err);
      }
    };
  }
}
