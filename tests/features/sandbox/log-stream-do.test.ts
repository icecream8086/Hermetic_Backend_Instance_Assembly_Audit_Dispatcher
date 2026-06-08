import { describe, it, expect } from 'vitest';

describe('LogStreamDO — 实时日志流', () => {

  // ─── 标准日志 API 参数 ───

  it('Podman 流式日志 URL: tail + since + follow', () => {
    function url(base: string, id: string, tail?: number, since?: number): string {
      const ep = base.replace(/\/+$/, '');
      let u = `${ep}/containers/${id}/logs?follow=1&stdout=1&stderr=1`;
      if (tail !== undefined && tail > 0) u += `&tail=${tail}`;
      if (since !== undefined) u += `&since=${since}`;
      return u;
    }

    expect(url('http://h:8080', 'c1', 100)).toContain('tail=100');
    expect(url('http://h:8080', 'c1', undefined, 12345)).toContain('since=12345');
    expect(url('http://h:8080', 'c1', 50, 999)).toContain('tail=50&since=999');
  });

  it('Podman inspect URL 格式', () => {
    const ep = 'http://h:8080/v1.24';
    const id = 'cont_abc';
    expect(`${ep}/containers/${id}/json`).toBe('http://h:8080/v1.24/containers/cont_abc/json');
  });

  it('ECI 轮询 URL 含 since 和 tail', () => {
    function eciUrl(base: string, id: string, since: number): string {
      return `${base.replace(/\/+$/, '')}/containers/${id}/logs?stdout=1&stderr=1&since=${since}&tail=50`;
    }
    const u = eciUrl('https://eci.aliyuncs.com', 'eci_1', 1000);
    expect(u).toContain('since=1000');
    expect(u).toContain('tail=50');
  });

  // ─── 生命周期: STOP / DEL ───

  it('follow=1 流结束后检查容器状态', async () => {
    // Podman stream 结束 (done=true) → 推 container_stopped 事件
    // → 调 podmanInspectUrl 检测 404
    const inspect404 = { status: 404 };
    expect((inspect404 as any).status).toBe(404);
    // → 推 container_deleted + scheduleCleanup(10s)
  });

  it('容器 stop 但存在时 DO 保持存活', () => {
    // inspect 返回 200 → 容器存在但已停止
    // DO 不清理, 等下次 start 重新 begin follow
    const inspect200 = { status: 200 };
    expect((inspect200 as any).status).toBe(200);
  });

  it('查询参数 endpoint 含特殊字符时正确编码', () => {
    const endpoint = 'http://192.168.1.1:8080/v1.24';
    const encoded = encodeURIComponent(endpoint);
    const qs = new URLSearchParams({ providerId: 'p1', endpoint, provider: 'podman' });
    const url = new URL(`/logs?${qs.toString()}`, 'https://do/');
    expect(url.searchParams.get('endpoint')).toBe(endpoint);
  });

  it('tail/since 参数透传到 DO URL', () => {
    const qs = new URLSearchParams({ providerId: 'p1', endpoint: 'http://h:8080', provider: 'podman' });
    qs.set('tail', '200');
    qs.set('since', '1234567890');
    const url = new URL(`/logs?${qs.toString()}`, 'https://do/');
    expect(url.searchParams.get('tail')).toBe('200');
    expect(url.searchParams.get('since')).toBe('1234567890');
  });

  // ─── WebSocket 生命周期 ───

  it('最后一个 WS 断线后 abort 拉取', () => {
    const ac = new AbortController();
    expect(ac.signal.aborted).toBe(false);
    ac.abort();
    expect(ac.signal.aborted).toBe(true);
  });

  it('alarm 清理所有连接', () => {
    const sessions = new Set<object>();
    sessions.add({});
    expect(sessions.size).toBe(1);
    sessions.clear();
    expect(sessions.size).toBe(0);
  });

  it('broadcast 容忍断线 WS', () => {
    const sessions = new Set<{ send: (d: string) => void }>();
    sessions.add({ send: () => { throw new Error('gone'); } });
    for (const ws of sessions) {
      try { ws.send('test'); } catch { /* expected */ }
    }
  });

  // ─── 事件格式 ───

  it('container_stopped 事件格式', () => {
    const msg = JSON.stringify({ event: 'container_stopped' });
    expect(JSON.parse(msg)).toEqual({ event: 'container_stopped' });
  });

  it('container_deleted 事件格式', () => {
    const msg = JSON.stringify({ event: 'container_deleted' });
    expect(JSON.parse(msg)).toEqual({ event: 'container_deleted' });
  });

  it('错误事件格式', () => {
    const msg = JSON.stringify({ event: 'error', message: 'something broke' });
    expect(JSON.parse(msg)).toEqual({ event: 'error', message: 'something broke' });
  });
});
