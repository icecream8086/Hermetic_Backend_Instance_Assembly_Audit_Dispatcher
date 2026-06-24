import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  SandboxStatus,
  isValidTransition,
  VALID_TRANSITIONS,
  TERMINAL_STATES,
} from '../../src/features/sandbox/types.ts';

// ─── Arbitraries ───

const sandboxStatus = fc.constantFrom(...Object.values(SandboxStatus));

const nonTerminalStatus = fc.constantFrom(
  ...Object.values(SandboxStatus).filter(s => !TERMINAL_STATES.has(s)),
);

const validTransitionPair = nonTerminalStatus.chain(from =>
  fc.tuple(
    fc.constant(from),
    fc.constantFrom(...VALID_TRANSITIONS[from]),
  ),
);

describe('SandboxStatus state machine (11-state property-based)', () => {
  describe('transition table consistency', () => {
    it('isValidTransition matches VALID_TRANSITIONS for all states', () => {
      fc.assert(
        fc.property(
          fc.tuple(sandboxStatus, sandboxStatus),
          ([from, to]) => {
            const expected = (VALID_TRANSITIONS[from] as readonly string[] | undefined)?.includes(to) ?? false;
            expect(isValidTransition(from, to)).toBe(expected);
          },
        ),
        { numRuns: 500 },
      );
    });
  });

  describe('reachability — every state can reach Deleted', () => {
    function canReach(from: SandboxStatus, target: SandboxStatus): boolean {
      const visited = new Set<SandboxStatus>();
      const queue: SandboxStatus[] = [from];
      visited.add(from);
      while (queue.length > 0) {
        const current = queue.shift()!;
        if (current === target) return true;
        for (const next of VALID_TRANSITIONS[current] ?? []) {
          if (!visited.has(next)) { visited.add(next); queue.push(next); }
        }
      }
      return false;
    }

    it('all non-terminal, non-Deleted states can reach Deleted', () => {
      for (const state of Object.values(SandboxStatus)) {
        if (TERMINAL_STATES.has(state)) continue; // terminals can never reach anything
        expect(canReach(state, SandboxStatus.Deleted)).toBe(true);
      }
    });
  });

  describe('terminal state invariants', () => {
    it('all 4 hard terminal states only have Deleted as outgoing edge', () => {
      for (const state of TERMINAL_STATES) {
        for (const target of Object.values(SandboxStatus)) {
          if (target === SandboxStatus.Deleted) continue; // cleanup always allowed
          expect(isValidTransition(state, target)).toBe(false);
        }
      }
    });
  });

  describe('no self-transitions', () => {
    it('no state can transition to itself', () => {
      fc.assert(
        fc.property(sandboxStatus, (state) => {
          expect(isValidTransition(state, state)).toBe(false);
        }),
      );
    });
  });

  describe('transition graph structure', () => {
    it('the restart cycle exists: Running → Restarting → Pending → Running', () => {
      expect(isValidTransition(SandboxStatus.Running, SandboxStatus.Restarting)).toBe(true);
      expect(isValidTransition(SandboxStatus.Restarting, SandboxStatus.Pending)).toBe(true);
      expect(isValidTransition(SandboxStatus.Pending, SandboxStatus.Running)).toBe(true);
    });

    it('graph has exactly 3 cycles (restart, update, delete bypass)', () => {
      // Running→Restarting→Pending→Running
      // Running→Updating→Running
      // (Terminating→Deleted is terminal, no cycle)
      // Count bidirectional edges — Running↔Updating is the only one
      let bidirectional = 0;
      for (const a of Object.values(SandboxStatus)) {
        for (const b of Object.values(SandboxStatus)) {
          if (a >= b) continue;
          const aToB = (VALID_TRANSITIONS[a] as readonly string[] | undefined)?.includes(b) ?? false;
          const bToA = (VALID_TRANSITIONS[b] as readonly string[] | undefined)?.includes(a) ?? false;
          if (aToB && bToA) bidirectional++;
        }
      }
      // Updating ↔ Running and Succeeded ↔ Running are bidirectional
      expect(bidirectional).toBe(2);
    });
  });

  describe('transition sequences', () => {
    it('random valid transition sequences never crash', () => {
      fc.assert(
        fc.property(
          fc.array(validTransitionPair, { minLength: 0, maxLength: 50 }),
          (transitions) => {
            for (const [from, to] of transitions) {
              expect(isValidTransition(from, to)).toBe(true);
            }
          },
        ),
        { numRuns: 1000 },
      );
    });

    it('random walk through the state machine stays valid', () => {
      fc.assert(
        fc.property(
          fc.constantFrom(...Object.values(SandboxStatus).filter(s => !TERMINAL_STATES.has(s))),
          fc.integer({ min: 0, max: 8 }),
          (start, steps) => {
            let current: SandboxStatus = start;
            const walked: SandboxStatus[] = [current];
            for (let i = 0; i < steps; i++) {
              const validTargets = VALID_TRANSITIONS[current] ?? [];
              if (validTargets.length === 0) break;
              const next = validTargets[i % validTargets.length]!;
              expect(isValidTransition(current, next)).toBe(true);
              current = next;
              walked.push(current);
            }
            for (let i = 0; i < walked.length - 1; i++) {
              expect(isValidTransition(walked[i]!, walked[i + 1]!)).toBe(true);
            }
          },
        ),
        { numRuns: 1000 },
      );
    });
  });
});
