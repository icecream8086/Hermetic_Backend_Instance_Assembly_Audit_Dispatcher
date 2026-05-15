import { describe, it, expect } from 'vitest';
import {
  SandboxStatus,
  isValidTransition,
  createSandboxId,
  createVolumeId,
  createMetricSnapshotId,
} from '../../src/features/sandbox/types.ts';
import { createDnsRecordId } from '../../src/features/dns/types.ts';

describe('brand types', () => {
  it('createSandboxId accepts non-empty string', () => {
    const id = createSandboxId('sandbox-001');
    expect(id).toBe('sandbox-001');
  });

  it('createSandboxId throws on empty string', () => {
    expect(() => createSandboxId('')).toThrow('SandboxId must not be empty');
  });

  it('createVolumeId throws on empty string', () => {
    expect(() => createVolumeId('')).toThrow('VolumeId must not be empty');
  });

  it('createDnsRecordId throws on empty string', () => {
    expect(() => createDnsRecordId('')).toThrow('DnsRecordId must not be empty');
  });

  it('createMetricSnapshotId throws on empty string', () => {
    expect(() => createMetricSnapshotId('')).toThrow('MetricSnapshotId must not be empty');
  });
});

describe('SandboxStatus state machine', () => {
  describe('valid transitions', () => {
    it('allows Pending → Scheduling', () => {
      expect(isValidTransition(SandboxStatus.Pending, SandboxStatus.Scheduling)).toBe(true);
    });

    it('allows Pending → Running', () => {
      expect(isValidTransition(SandboxStatus.Pending, SandboxStatus.Running)).toBe(true);
    });

    it('allows Pending → Failed', () => {
      expect(isValidTransition(SandboxStatus.Pending, SandboxStatus.Failed)).toBe(true);
    });

    it('allows Scheduling → Running', () => {
      expect(isValidTransition(SandboxStatus.Scheduling, SandboxStatus.Running)).toBe(true);
    });

    it('allows Running → Stopped', () => {
      expect(isValidTransition(SandboxStatus.Running, SandboxStatus.Stopped)).toBe(true);
    });

    it('allows Running → Terminated', () => {
      expect(isValidTransition(SandboxStatus.Running, SandboxStatus.Terminated)).toBe(true);
    });

    it('allows Running → Deleted', () => {
      expect(isValidTransition(SandboxStatus.Running, SandboxStatus.Deleted)).toBe(true);
    });

    it('allows Stopped → Running', () => {
      expect(isValidTransition(SandboxStatus.Stopped, SandboxStatus.Running)).toBe(true);
    });

    it('allows Stopped → Deleted', () => {
      expect(isValidTransition(SandboxStatus.Stopped, SandboxStatus.Deleted)).toBe(true);
    });

    it('allows Terminated → Deleted', () => {
      expect(isValidTransition(SandboxStatus.Terminated, SandboxStatus.Deleted)).toBe(true);
    });

    it('allows Failed → Deleted', () => {
      expect(isValidTransition(SandboxStatus.Failed, SandboxStatus.Deleted)).toBe(true);
    });
  });

  describe('invalid transitions', () => {
    it('rejects Deleted → anything', () => {
      for (const target of Object.values(SandboxStatus)) {
        expect(isValidTransition(SandboxStatus.Deleted, target)).toBe(false);
      }
    });

    it('rejects Pending → Deleted (must go through intermediate status)', () => {
      expect(isValidTransition(SandboxStatus.Pending, SandboxStatus.Deleted)).toBe(false);
    });

    it('rejects Running → Pending (cannot go backwards)', () => {
      expect(isValidTransition(SandboxStatus.Running, SandboxStatus.Pending)).toBe(false);
    });

    it('rejects Stopped → Pending', () => {
      expect(isValidTransition(SandboxStatus.Stopped, SandboxStatus.Pending)).toBe(false);
    });

    it('rejects Terminated → Running', () => {
      expect(isValidTransition(SandboxStatus.Terminated, SandboxStatus.Running)).toBe(false);
    });

    it('rejects Failed → Running (must reprovision)', () => {
      expect(isValidTransition(SandboxStatus.Failed, SandboxStatus.Running)).toBe(false);
    });

    it('rejects Scheduling → Pending', () => {
      expect(isValidTransition(SandboxStatus.Scheduling, SandboxStatus.Pending)).toBe(false);
    });
  });

  describe('terminal states', () => {
    it('Deleted has no outgoing transitions', () => {
      const transitions = Object.values(SandboxStatus).filter(t =>
        isValidTransition(SandboxStatus.Deleted, t),
      );
      expect(transitions).toHaveLength(0);
    });
  });
});
