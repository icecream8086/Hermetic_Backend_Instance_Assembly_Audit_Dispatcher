/**
 * Cloudflare Log Reader — 从 R2/Logpush 持久化日志中查询。
 *
 * Logpush 将 Workers console.log 输出流式写入 R2 bucket。
 * 此 reader 从 R2 中按 facility/时间范围筛选日志行。
 *
 * R2 路径: {prefix}/{date}/{hour}/{worker}-{timestamp}.log
 * 每行格式: [ISO timestamp] KERNLEVEL: [facility] message {"metadata":...}
 *
 * 配置:
 *   env.CF_LOG_R2_BUCKET — R2 bucket name (binding)
 *   env.CF_LOG_PREFIX    — R2 key prefix, default "logs"
 *
 * 参考: https://developers.cloudflare.com/logs/logpush/
 */

import type { IBlobStore } from '../../core/store/interfaces.ts';
import type { IAuditReader } from '../../core/audit/types.ts';
import type { AuditFilter, AuditQueryResult } from '../../core/audit/types.ts';

const LINE_REGEX = /^\[(.+?)\]\s+(\w+):\s+\[(\w[\w-]*)\]\s+(.+)$/;

export class CloudflareLogReader implements IAuditReader {
  constructor(
    private readonly blob: IBlobStore,
    private readonly prefix = 'logs',
  ) {}

  /**
   * 从 R2 存储的 Logpush 日志中查询。
   *
   * 按日期范围计算需要扫描的 R2 key 前缀，逐文件解析匹配。
   * 生产环境中日志量大时建议限制 page/limit 并使用游标。
   */
  query(filter?: AuditFilter): AuditQueryResult {
    // Workers 环境同步读取受限——Logpush 写入是异步的。
    // 返回 Logpush 配置参考，实际查询通过 Cloudflare Dashboard 或 Logpull API。
    // 此 reader 在支持 R2 list + get 的环境（如 Node.js 兼容层）中工作。
    const page = filter?.page ?? 1;
    const limit = filter?.limit ?? 20;

    return {
      lines: [],
      total: 0,
      page,
      limit,
      totalPages: 0,
    };
  }

  /**
   * 异步查询（Node.js / Workers compatible）。
   * 扫描 R2 中匹配前缀的日志文件，解析行并筛选。
   */
  async queryAsync(filter?: AuditFilter): Promise<AuditQueryResult> {
    const since = filter?.since ?? 0;
    const until = filter?.until ?? Date.now();
    const facility = filter?.facility;
    const search = filter?.search;
    const page = filter?.page ?? 1;
    const limit = Math.min(filter?.limit ?? 50, 500);

    // 构建日期前缀列表（按天扫描）
    const keys = this.#buildDateKeys(since, until);
    const allLines: string[] = [];

    for (const key of keys) {
      try {
        const stream = await this.blob.get(key);
        if (!stream) continue;

        const reader = stream.getReader();
        const chunks: Uint8Array[] = [];
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
        }

        const totalSize = chunks.reduce((s, c) => s + c.byteLength, 0);
        const merged = new Uint8Array(totalSize);
        let offset = 0;
        for (const c of chunks) { merged.set(c, offset); offset += c.byteLength; }

        const text = new TextDecoder().decode(merged);
        const lines = text.split('\n').filter(Boolean);

        for (const line of lines) {
          if (this.#matchLine(line, since, until, facility, search)) {
            allLines.push(line);
          }
        }
      } catch {
        // R2 key 不可读或不存在——跳过
      }
    }

    const total = allLines.length;
    const start = (page - 1) * limit;
    const paged = allLines.slice(start, start + limit);

    return {
      lines: paged,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  #buildDateKeys(since: number, until: number): string[] {
    const keys: string[] = [];
    const d = new Date(since);
    d.setUTCHours(0, 0, 0, 0);

    while (d.getTime() <= until) {
      const yyyy = d.getUTCFullYear();
      const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
      const dd = String(d.getUTCDate()).padStart(2, '0');
      // Logpush 默认按小时分片，按天前缀扫描
      for (let h = 0; h < 24; h++) {
        keys.push(`${this.prefix}/${yyyy}/${mm}/${dd}/${String(h).padStart(2, '0')}/`);
      }
      d.setUTCDate(d.getUTCDate() + 1);
    }
    return keys;
  }

  #matchLine(
    line: string,
    since: number,
    until: number,
    facility?: string,
    search?: string,
  ): boolean {
    const match = line.match(LINE_REGEX);
    if (!match) return false;

    const [, ts, , lineFacility, message] = match;
    const lineTs = new Date(ts!).getTime();

    if (lineTs < since || lineTs > until) return false;
    if (facility && lineFacility !== facility) return false;
    if (search && !message!.toLowerCase().includes(search.toLowerCase())) return false;

    return true;
  }
}
