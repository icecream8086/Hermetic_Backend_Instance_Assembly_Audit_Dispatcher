/// <reference types="@cloudflare/workers-types" />

/**
 * LogStreamDO — 实时容器日志流。
 *
 * 生命周期:
 *   CONTAINER_RUNNING → 流式推送
 *   CONTAINER_STOPPED → WS 保持, 推 container_stopped 事件
 *   CONTAINER_DELETED → DO 自毁 (alarm 清理)
 *   DO 闲置 5 min    → alarm 关闭所有连接
 *
 * 标准日志 API 参数（按 Docker logs 惯例）:
 *   tail=N   — 连接后先推最近 N 行, 再 follow
 *   since=ts — 只推该时间戳之后的日志
 *   follow=1 — 持续推送 (默认)
 *
 * Podman: HTTP streaming (follow=1), 流结束时 inspect 容器状态
 * Alibaba ECI: 2s 轮询 DescribeContainerLog, 检测 404 自毁
 */

const POLL_INTERVAL_MS = 2_000;
const IDLE_ALARM_MS = 300_000; // 5 min

function podmanLogsUrl(base: string, id: string, tail?: number, since?: number): string {
  const ep = base.replace(/\/+$/, '');
  let url = `${ep}/containers/${id}/logs?follow=1&stdout=1&stderr=1`;
  if (tail !== undefined && tail > 0) url += `&tail=${tail}`;
  if (since !== undefined) url += `&since=${since}`;
  return url;
}

function podmanInspectUrl(base: string, id: string): string {
  const ep = base.replace(/\/+$/, '');
  return `${ep}/containers/${id}/json`;
}

function eciLogsUrl(base: string, id: string, since: number): string {
  const ep = base.replace(/\/+$/, '');
  return `${ep}/containers/${id}/logs?stdout=1&stderr=1&since=${since}&tail=50`;
}

export class LogStreamDO implements DurableObject {
  readonly #sessions = new Set<WebSocket>();
  #abortController: AbortController | null = null;

  constructor(readonly ctx: DurableObjectState, readonly _env: unknown) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const providerId = url.searchParams.get('providerId');
    const endpoint = url.searchParams.get('endpoint');
    const provider = url.searchParams.get('provider') ?? 'podman';
    const tail = parseInt(url.searchParams.get('tail') ?? '0', 10) || undefined;
    const since = parseInt(url.searchParams.get('since') ?? '0', 10) || undefined;

    if (!providerId || !endpoint) {
      return new Response('Missing providerId or endpoint', { status: 400 });
    }

    // WebSocket upgrade
    const pair = new WebSocketPair();
    const client = pair[0]!;
    const server = pair[1]!;

    this.#sessions.add(server);
    server.accept();
    server.addEventListener('close', () => {
      this.#sessions.delete(server);
      if (this.#sessions.size === 0) this.#stop();
    });
    server.addEventListener('error', () => {
      this.#sessions.delete(server);
      if (this.#sessions.size === 0) this.#stop();
    });

    // Refresh idle alarm
    this.ctx.storage.setAlarm(Date.now() + IDLE_ALARM_MS).catch(() => {});

    // Start streaming (only on first connection)
    if (!this.#abortController) {
      this.#start(provider, endpoint, providerId, tail, since);
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  #start(provider: string, endpoint: string, containerId: string, tail?: number, since?: number): void {
    if (provider === 'podman') {
      this.#streamFromPodman(endpoint, containerId, tail, since);
    } else {
      this.#pollFromProvider(endpoint, containerId, since);
    }
  }

  async #streamFromPodman(endpoint: string, containerId: string, tail?: number, since?: number): Promise<void> {
    this.#abortController = new AbortController();
    try {
      const url = podmanLogsUrl(endpoint, containerId, tail, since);
      const resp = await fetch(url, { signal: this.#abortController.signal });
      if (!resp.ok || !resp.body) {
        if (resp.status === 404) {
          this.#broadcast(JSON.stringify({ event: 'container_deleted', message: 'Container not found' }));
          this.#scheduleCleanup(10_000);
        } else {
          this.#broadcast(JSON.stringify({ event: 'error', message: `Logs failed: ${resp.status}` }));
        }
        return;
      }

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break; // stream ended → container stopped
        const text = decoder.decode(value, { stream: true });
        if (text) this.#broadcast(text);
      }

      // Stream ended — container stopped. Check if it still exists.
      this.#broadcast(JSON.stringify({ event: 'container_stopped' }));
      await this.#checkContainer(endpoint, containerId);
    } catch (e: unknown) {
      if ((e as Error)?.name === 'AbortError') return;
      this.#broadcast(JSON.stringify({ event: 'error', message: String(e) }));
    }
  }

  async #checkContainer(endpoint: string, containerId: string): Promise<void> {
    try {
      const resp = await fetch(podmanInspectUrl(endpoint, containerId));
      if (resp.status === 404) {
        // Container deleted → schedule DO cleanup
        this.#broadcast(JSON.stringify({ event: 'container_deleted' }));
        this.#scheduleCleanup(10_000);
      }
      // Container exists but stopped → stay alive, wait for restart
    } catch {
      // Network error — stay alive, retry logic could go here
    }
  }

  async #pollFromProvider(endpoint: string, containerId: string, since?: number): Promise<void> {
    this.#abortController = new AbortController();
    let lastFetch = since ?? Math.floor(Date.now() / 1000) - 10;

    while (!this.#abortController.signal.aborted) {
      try {
        const url = eciLogsUrl(endpoint, containerId, lastFetch);
        const resp = await fetch(url, { signal: this.#abortController.signal });
        if (resp.status === 404) {
          this.#broadcast(JSON.stringify({ event: 'container_deleted' }));
          this.#scheduleCleanup(10_000);
          return;
        }
        if (resp.ok) {
          const text = await resp.text();
          if (text) this.#broadcast(text);
        }
        lastFetch = Math.floor(Date.now() / 1000);
      } catch (e: unknown) {
        if ((e as Error)?.name === 'AbortError') return;
      }

      await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
    }
  }

  #broadcast(data: string): void {
    for (const ws of this.#sessions) {
      try { ws.send(data); } catch { /* client gone */ }
    }
  }

  #scheduleCleanup(delayMs: number): void {
    this.ctx.storage.setAlarm(Date.now() + delayMs).catch(() => {});
  }

  #stop(): void {
    this.#abortController?.abort();
    this.#abortController = null;
  }

  async alarm(): Promise<void> {
    this.#stop();
    for (const ws of this.#sessions) {
      try { ws.close(1001, 'DO idle timeout'); } catch { /* already closed */ }
    }
    this.#sessions.clear();
  }
}
