import { describe, it, expect } from 'vitest';
import { NoopAuditLogger } from '../../../src/core/audit/noop-audit-logger.ts';
import { KernLevel } from '../../../src/core/audit/kern-level.ts';

describe('NoopAuditLogger', () => {
  const logger = new NoopAuditLogger();

  it('write does nothing (no throw)', async () => {
    await expect(logger.write({ level: KernLevel.ERR, facility: 'test', message: 'error' })).resolves.toBeUndefined();
  });

  it('query returns empty result', () => {
    const r = logger.query({ facility: 'test' });
    expect(r.lines).toEqual([]);
    expect(r.total).toBe(0);
    expect(r.totalPages).toBe(0);
  });

  it('query without filter returns empty', () => {
    const r = logger.query();
    expect(r.lines).toHaveLength(0);
  });
});
