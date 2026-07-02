/// <reference types="@cloudflare/workers-types" />
const { parse: parseJson } = JSON;

/**
 * NotificationDO — 全局 WebSocket 广播频道
 *
 * 职责： 服务器单工推送给所有在线客户端（沙箱创建完成、节点离线、审计告警）。
 *
 * DO name: "notif:global"（单个全局实例）
 *
 * 客户端连接: GET /api/ws/notifications → Upgrade 到 NotificationDO
 * 内部桥接:   POST https://do/broadcast { type, data } → 广播给所有 WS 客户端
 *
 * 安全： /broadcast 端点只接受内部已知事件类型，并有 64KB body 上限。
 */
import { z } from 'zod';

const MAX_BROADCAST_BYTES = 65_536;

const ALLOWED_EVENT_TYPES = new Set([
  'sandbox.provisioned',
  'sandbox.status',
]);

export class NotificationDO implements DurableObject {
  #sessions = new Set<WebSocket>();
  #filters = new Map<WebSocket, Set<string>>();

  public async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade') === 'websocket') {
      return this.#handleUpgrade();
    }

    // Internal bridge: POST /broadcast { type, data }
    const url = new URL(request.url);
    if (url.pathname.endsWith('/broadcast') && request.method === 'POST') {
      // Body size limit — prevent OOM on large payloads
      const contentLength = Number(request.headers.get('content-length') ?? 0);
      if (contentLength > MAX_BROADCAST_BYTES) {
        return new Response('payload too large', { status: 413 });
      }
      const body = z.object({ type: z.string(), data: z.unknown() }).parse(await request.json());
      if (!ALLOWED_EVENT_TYPES.has(body.type)) {
        return new Response('unknown event type', { status: 400 });
      }
      this.#broadcast(body.type, body.data);
      return new Response('ok', { status: 200 });
    }

    return new Response('not found', { status: 404 });
  }

  #handleUpgrade(): Response {
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    server.accept();
    this.#sessions.add(server);

    server.addEventListener('message', (event: MessageEvent) => {
      this.#handleMessage(server, event);
    });

    server.addEventListener('close', () => {
      this.#sessions.delete(server);
      this.#filters.delete(server);
    });

    return new Response(null, { status: 101, webSocket: client });
  }

  #handleMessage(ws: WebSocket, event: MessageEvent): void {
    try {
      const msg = z.custom<{ type: string; channels?: string[] }>().parse(parseJson(z.string().parse(event.data)));
      if (msg.type === 'subscribe' && Array.isArray(msg.channels)) {
        this.#filters.set(ws, new Set(msg.channels));
        ws.send(JSON.stringify({ type: 'subscribed', channels: msg.channels }));
      }
    } catch {
      ws.send(JSON.stringify({ type: 'error', data: { message: 'Invalid message format' } }));
    }
  }

  #broadcast(type: string, data: unknown): void {
    const ts = Date.now();
    for (const [ws, channels] of this.#filters) {
      // Skip if client has active filters and none match this event type
      if (channels.size > 0 && !this.#matches(channels, type)) continue;
      try {
        ws.send(JSON.stringify({ type, data, ts }));
      } catch {
        this.#sessions.delete(ws);
        this.#filters.delete(ws);
      }
    }
  }

  /** Check if event type matches any subscription channel (supports wildcard: "sandbox.*"). */
  #matches(channels: Set<string>, eventType: string): boolean {
    for (const ch of channels) {
      if (ch === '*' || ch === eventType) return true;
      if (ch.endsWith('.*') && eventType.startsWith(ch.slice(0, -1))) return true;
      if (ch.endsWith(':*') && eventType.startsWith(ch.slice(0, -1))) return true;
    }
    return false;
  }
}
