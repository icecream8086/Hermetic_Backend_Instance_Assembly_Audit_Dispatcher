/// <reference types="@cloudflare/workers-types" />

/**
 * LogStreamDO — 容器日志 WebSocket 流。
 *
 * 双模式:
 *   snapshot — app.ts 预取日志内容传入，DO 一次推送后关闭
 *   stream   — 连 Podman Docker API 实时流式推送（follow=1）
 *
 * 标准日志参数:
 *   content       — 预取日志内容（snapshot 模式）
 *   containerName — 容器名称（snapshot 模式）
 *   endpoint      — Docker API endpoint（stream 模式）
 *   providerId    — 容器/容器组 ID
 *   provider      — 平台类型
 *   tail, since   — 日志过滤参数
 *
 * Podman: HTTP streaming, 流结束时 inspect 容器状态
 * 其他 (Alibaba/AWS/GCP): app.ts 预取 → snapshot
 */

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

export class LogStreamDO implements DurableObject {
  readonly #sessions = new Set<WebSocket>();
  #abortController: AbortController | null = null;

  constructor(readonly ctx: DurableObjectState, readonly _env: unknown) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const providerId = url.searchParams.get('providerId');
    const endpoint = url.searchParams.get('endpoint');
    const provider = url.searchParams.get('provider') ?? 'podman';
    const content = url.searchParams.get('content');
    const containerName = url.searchParams.get('containerName') ?? '';
    const tail = parseInt(url.searchParams.get('tail') ?? '0', 10) || undefined;
    const since = parseInt(url.searchParams.get('since') ?? '0', 10) || undefined;

    if (!providerId) {
      return new Response('Missing providerId', { status: 400 });
    }

    // WebSocket upgrade
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

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
      if (content !== null) {
        this.#snapshot(content, containerName);
      } else {
        this.#start(provider, endpoint, providerId, tail, since);
      }
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  #start(provider: string, endpoint: string | null, containerId: string, tail?: number, since?: number): void {
    if (provider === 'podman' && endpoint) {
      this.#streamFromPodman(endpoint, containerId, tail, since);
    } else {
      this.#broadcast(JSON.stringify({ event: 'error', message: `Unsupported provider: ${provider}` }));
      this.#stop();
    }
  }

  /** Snapshot mode: push pre-fetched content once, then close. */
  #snapshot(content: string, containerName: string): void {
    this.#abortController = new AbortController();
    this.#broadcast(JSON.stringify({ content, containerName, event: 'container_logs' }));
    this.#broadcast(JSON.stringify({ event: 'container_stopped' }));
    this.#stop();
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
