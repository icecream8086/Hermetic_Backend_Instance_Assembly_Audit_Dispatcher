import { describe, it, expect } from 'vitest';
import {
  SandboxStatus, isValidTransition, isTerminal, TERMINAL_STATES,
  createSandboxId, createVolumeId, createMetricSnapshotId, ContainerStatus,
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

describe('SandboxStatus state machine (ECI 11-state)', () => {
  describe('valid transitions', () => {
    it('Scheduling → Pending (schedule success)', () => {
      expect(isValidTransition(SandboxStatus.Scheduling, SandboxStatus.Pending)).toBe(true);
    });

    it('Scheduling → ScheduleFailed (schedule failure)', () => {
      expect(isValidTransition(SandboxStatus.Scheduling, SandboxStatus.ScheduleFailed)).toBe(true);
    });

    it('Pending → Running (init success)', () => {
      expect(isValidTransition(SandboxStatus.Pending, SandboxStatus.Running)).toBe(true);
    });

    it('Pending → Failed (init failure)', () => {
      expect(isValidTransition(SandboxStatus.Pending, SandboxStatus.Failed)).toBe(true);
    });

    it('Pending → Terminating (delete during init)', () => {
      expect(isValidTransition(SandboxStatus.Pending, SandboxStatus.Terminating)).toBe(true);
    });

    it('Running → Succeeded (all containers exit 0)', () => {
      expect(isValidTransition(SandboxStatus.Running, SandboxStatus.Succeeded)).toBe(true);
    });

    it('Running → Failed (containers failed)', () => {
      expect(isValidTransition(SandboxStatus.Running, SandboxStatus.Failed)).toBe(true);
    });

    it('Running → Restarting (RestartContainerGroup)', () => {
      expect(isValidTransition(SandboxStatus.Running, SandboxStatus.Restarting)).toBe(true);
    });

    it('Running → Updating (UpdateContainerGroup)', () => {
      expect(isValidTransition(SandboxStatus.Running, SandboxStatus.Updating)).toBe(true);
    });

    it('Running → Terminating (DeleteContainerGroup)', () => {
      expect(isValidTransition(SandboxStatus.Running, SandboxStatus.Terminating)).toBe(true);
    });

    it('Running → Expired (spot reclaimed)', () => {
      expect(isValidTransition(SandboxStatus.Running, SandboxStatus.Expired)).toBe(true);
    });

    it('Restarting → Pending (restart ok)', () => {
      expect(isValidTransition(SandboxStatus.Restarting, SandboxStatus.Pending)).toBe(true);
    });

    it('Updating → Running (update ok)', () => {
      expect(isValidTransition(SandboxStatus.Updating, SandboxStatus.Running)).toBe(true);
    });

    it('Terminating → Deleted (cleanup done)', () => {
      expect(isValidTransition(SandboxStatus.Terminating, SandboxStatus.Deleted)).toBe(true);
    });
  });

  describe('invalid transitions', () => {
    it('hard terminal states (ScheduleFailed, Expired, Deleted) can only transition to Deleted', () => {
      for (const state of TERMINAL_STATES) {
        for (const target of Object.values(SandboxStatus)) {
          if (target === SandboxStatus.Deleted) continue; // cleanup allowed
          expect(isValidTransition(state, target)).toBe(false);
        }
      }
    });

    it('rejects Running → Pending (no reverse)', () => {
      expect(isValidTransition(SandboxStatus.Running, SandboxStatus.Pending)).toBe(false);
    });

    it('allows Failed → Running (GHA RerunFailedJobs)', () => {
      expect(isValidTransition(SandboxStatus.Failed, SandboxStatus.Running)).toBe(true);
    });

    it('allows Succeeded → Running (GHA RerunRun)', () => {
      expect(isValidTransition(SandboxStatus.Succeeded, SandboxStatus.Running)).toBe(true);
    });

    it('rejects Expired → Running (hard terminal)', () => {
      expect(isValidTransition(SandboxStatus.Expired, SandboxStatus.Running)).toBe(false);
    });

    it('rejects ScheduleFailed → Pending (hard terminal)', () => {
      expect(isValidTransition(SandboxStatus.ScheduleFailed, SandboxStatus.Pending)).toBe(false);
    });
  });

  describe('terminal state detection', () => {
    it('isTerminal returns true for 3 hard terminal states (GHA/K8s Job design)', () => {
      expect(isTerminal(SandboxStatus.ScheduleFailed)).toBe(true);
      expect(isTerminal(SandboxStatus.Expired)).toBe(true);
      expect(isTerminal(SandboxStatus.Deleted)).toBe(true);
    });

    it('isTerminal returns false for soft-terminal and non-terminal states', () => {
      expect(isTerminal(SandboxStatus.Succeeded)).toBe(false); // soft terminal — GHA RerunRun
      expect(isTerminal(SandboxStatus.Failed)).toBe(false); // soft terminal — GHA RerunFailedJobs
      expect(isTerminal(SandboxStatus.Scheduling)).toBe(false);
      expect(isTerminal(SandboxStatus.Pending)).toBe(false);
      expect(isTerminal(SandboxStatus.Running)).toBe(false);
      expect(isTerminal(SandboxStatus.Restarting)).toBe(false);
      expect(isTerminal(SandboxStatus.Updating)).toBe(false);
      expect(isTerminal(SandboxStatus.Terminating)).toBe(false);
    });
  });

  describe('ContainerStatus enum', () => {
    it('has three values', () => {
      expect(ContainerStatus.Waiting).toBe('Waiting');
      expect(ContainerStatus.Running).toBe('Running');
      expect(ContainerStatus.Terminated).toBe('Terminated');
    });
  });
});
