/**
 * 缓存命中率抽象层 — 底层兼容 Cloudflare KV、Durable Object、文件存储等。
 *
 * IServerMetrics 作为占位符抽象层，底层可对接 Cloudflare API、
 * 或其他平台的监控接口，用于统计 KV / DO / 文件存储的命中率。
 */

/** 缓存命中率快照 — 平台无关的抽象结构。 */
export interface ServerCacheStats {
  gets: number;
  hits: number;
  misses: number;
  sets: number;
  /** 命中率 (0~1)，无请求时为 0 */
  hitRate: number;
}

/** 服务端缓存指标抽象接口 — 底层实现可对接 Cloudflare 或其他平台. */
export interface IServerMetrics {
  /** 返回当前缓存命中率统计快照 */
  snapshot(): ServerCacheStats;
}

/**
 * 内存计数器实现 — 不依赖任何平台 API，适用于所有后端类型。
 *
 * 后续可替换为 Cloudflare API 实现，直接从平台查询真实 KV 命中率。
 */
export class AtomicStoreMetrics implements IServerMetrics {
  #gets = 0;
  #hits = 0;
  #misses = 0;
  #sets = 0;

  public recordGet(): void { this.#gets++; }
  public recordHit(): void { this.#hits++; }
  public recordMiss(): void { this.#misses++; }
  public recordSet(): void { this.#sets++; }

  public snapshot(): ServerCacheStats {
    const gets = this.#gets;
    const hits = this.#hits;
    const misses = this.#misses;
    const total = hits + misses;
    return { gets, hits, misses, sets: this.#sets, hitRate: total > 0 ? hits / total : 0 };
  }
}
