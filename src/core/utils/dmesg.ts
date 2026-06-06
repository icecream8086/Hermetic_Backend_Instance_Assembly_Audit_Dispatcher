/**
 * 共享的 dmesg 风格日志格式化。
 * 给 ConsoleLogger、formatAuditLine、LocalAuditLogger 共用。
 *
 * 用 performance.now() 而不是 process.uptime()，因为 workerd 运行时
 * 没有 process.uptime()（返回 0），而 performance 在 Node.js 和 Workers 都可用。
 */
export function formatDmesgLine(message: string, actorId?: string | null): string {
  const ms = performance.now();
  const secs = Math.floor(ms / 1000);
  const usecs = Math.floor((ms - secs * 1000) * 1000);
  const ts = `[${String(secs).padStart(7)}.${String(usecs).padStart(6, '0')}]`;
  return actorId ? `${ts} ${actorId}: ${message}` : `${ts} ${message}`;
}
