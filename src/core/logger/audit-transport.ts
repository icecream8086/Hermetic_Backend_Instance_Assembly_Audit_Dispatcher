import type { ILogWriter } from './interfaces.ts';
import type { LogInput } from './types.ts';
import type { IAuditWriter } from '../audit/types.ts';
import { KernLevel } from '../audit/kern-level.ts';

/**
 * Decorator that wraps an ILogWriter and optionally bridges log entries
 * to an IAuditWriter when the log level meets a configurable threshold.
 *
 * Logger 和 Audit 的关系:
 *   LogRouter -> ConsoleLogger（开发）
 *   LogRouter -> AuditTransport(ConsoleLogger, audit?)（生产，可选）
 *
 * 不改动现有 ILogWriter / IAuditWriter 接口，只在组装层做。
 */
export class AuditTransport implements ILogWriter {
  constructor(
    private readonly inner: ILogWriter,
    private readonly audit?: IAuditWriter,
    private readonly auditThreshold: KernLevel = KernLevel.WARNING,
  ) {}

  async logSync(input: LogInput): Promise<any> {
    const id = await this.inner.logSync(input);
    this.#maybeAudit(input);
    return id;
  }

  async logAsync(input: LogInput): Promise<void> {
    await this.inner.logAsync(input);
    this.#maybeAudit(input);
  }

  #shouldAudit(input: LogInput): boolean {
    if (!this.audit) return false;
    // Map LogInput level string to KernLevel for comparison
    const level = logLevelToKern(input.level);
    return level <= this.auditThreshold;
  }

  #maybeAudit(input: LogInput): void {
    if (!this.#shouldAudit(input)) return;
    this.audit?.write({
      level: logLevelToKern(input.level),
      facility: input.facility,
      message: input.message,
      ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
    });
  }
}

/** Map log level string to KernLevel for threshold comparison. */
function logLevelToKern(level: string): KernLevel {
  switch (level.toLowerCase()) {
    case 'fatal': return KernLevel.EMERG;
    case 'error': return KernLevel.ERR;
    case 'warn':
    case 'warning': return KernLevel.WARNING;
    case 'notice': return KernLevel.NOTICE;
    case 'info': return KernLevel.INFO;
    case 'debug': return KernLevel.DEBUG;
    default: return KernLevel.INFO;
  }
}
