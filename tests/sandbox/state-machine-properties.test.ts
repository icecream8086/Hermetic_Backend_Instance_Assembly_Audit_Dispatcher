import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  SandboxStatus,
  isValidTransition,
  VALID_TRANSITIONS,
} from '../../src/features/sandbox/types.ts';

// ─── Arbitraries ───

const sandboxStatus = fc.constantFrom(...Object.values(SandboxStatus));

/**
 * For generating valid transition pairs from the actual table,
 * pick a source status and then pick a target from its valid list.
 */
/**
 * For non-terminal states, pick a valid target from the transition table.
 * Excludes Deleted (which has no valid targets) from being a source.
 */
const nonTerminalStatus = fc.constantFrom(
  SandboxStatus.Pending,
  SandboxStatus.Scheduling,
  SandboxStatus.Running,
  SandboxStatus.Stopped,
  SandboxStatus.Terminated,
  SandboxStatus.Failed,
);

const validTransitionPair = nonTerminalStatus.chain(from =>
  fc.tuple(
    fc.constant(from),
    fc.constantFrom(...VALID_TRANSITIONS[from]),
  ),
);

describe('SandboxStatus state machine (property-based)', () => {
  describe('transition table consistency', () => {
    it('isValidTransition matches VALID_TRANSITIONS for all states', () => {
      // For any pair of states, isValidTransition(s, t) iff t ∈ VALID_TRANSITIONS[s]
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
    /**
     * BFS to check if `from` can reach `to` within the transition graph.
     */
    function canReach(from: SandboxStatus, target: SandboxStatus): boolean {
      const visited = new Set<SandboxStatus>();
      const queue: SandboxStatus[] = [from];
      visited.add(from);
      while (queue.length > 0) {
        const current = queue.shift()!;
        if (current === target) return true;
        for (const next of VALID_TRANSITIONS[current] ?? []) {
          if (!visited.has(next)) {
            visited.add(next);
            queue.push(next);
          }
        }
      }
      return false;
    }

    it('all non-Deleted states can reach Deleted', () => {
      for (const state of Object.values(SandboxStatus)) {
        if (state === SandboxStatus.Deleted) continue;
        expect(canReach(state, SandboxStatus.Deleted)).toBe(true);
      }
    });
  });

  describe('terminal state invariants', () => {
    it('Deleted has no outgoing edges', () => {
      expect(VALID_TRANSITIONS[SandboxStatus.Deleted]).toHaveLength(0);
      for (const target of Object.values(SandboxStatus)) {
        expect(isValidTransition(SandboxStatus.Deleted, target)).toBe(false);
      }
    });

    it('Deleted cannot be reached by any other transition than those listed', () => {
      // Every transition to Deleted must be listed in VALID_TRANSITIONS
      for (const from of Object.values(SandboxStatus)) {
        if (from === SandboxStatus.Deleted) continue;
        // If there's a path to Deleted, it must appear in the table
        // (this is implicit in the table, but we verify the graph)
        const listed = (VALID_TRANSITIONS[from] as readonly string[] | undefined)?.includes(SandboxStatus.Deleted) ?? false;
        expect(listed).toBe(true);
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
    it('Running ↔ Stopped is the only bidirectional edge', () => {
      // Count bidirectional edges
      let bidirectional = 0;
      const pairs: Array<[SandboxStatus, SandboxStatus]> = [];
      for (const a of Object.values(SandboxStatus)) {
        for (const b of Object.values(SandboxStatus)) {
          if (a >= b) continue; // each pair once
          const aToB = (VALID_TRANSITIONS[a] as readonly string[] | undefined)?.includes(b) ?? false;
          const bToA = (VALID_TRANSITIONS[b] as readonly string[] | undefined)?.includes(a) ?? false;
          if (aToB && bToA) {
            bidirectional++;
            pairs.push([a, b]);
          }
        }
      }
      expect(bidirectional).toBe(1);
      expect(pairs).toContainEqual([SandboxStatus.Running, SandboxStatus.Stopped]);
    });

    it('transition graph is acyclic (ignoring Running↔Stopped back-edge)', () => {
      // Removing Stopped→Running should make the graph a DAG
      const adjacency = new Map<SandboxStatus, Set<SandboxStatus>>();
      for (const from of Object.values(SandboxStatus)) {
        adjacency.set(from, new Set());
        for (const to of (VALID_TRANSITIONS[from] ?? [])) {
          // Skip the back-edge that creates the only cycle
          if (from === SandboxStatus.Stopped && to === SandboxStatus.Running) continue;
          adjacency.get(from)!.add(to);
        }
      }

      // Kahn's algorithm
      const inDegree = new Map<SandboxStatus, number>();
      for (const s of Object.values(SandboxStatus)) inDegree.set(s, 0);
      for (const [, targets] of adjacency) {
        for (const t of targets) {
          inDegree.set(t, (inDegree.get(t) ?? 0) + 1);
        }
      }

      const queue = [...inDegree.entries()].filter(([, d]) => d === 0).map(([s]) => s);
      const sorted: SandboxStatus[] = [];
      while (queue.length > 0) {
        const s = queue.shift()!;
        sorted.push(s);
        for (const t of adjacency.get(s) ?? []) {
          const d = (inDegree.get(t) ?? 1) - 1;
          inDegree.set(t, d);
          if (d === 0) queue.push(t);
        }
      }

      expect(sorted.length).toBe(Object.values(SandboxStatus).length);
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

    it('random transition sequences that are valid per the table stay valid', () => {
      // Generate a walk through the state machine
      fc.assert(
        fc.property(
          sandboxStatus,
          fc.integer({ min: 0, max: 8 }),
          (start, steps) => {
            let current = start;
            const walked: SandboxStatus[] = [current];
            for (let i = 0; i < steps; i++) {
              const validTargets = VALID_TRANSITIONS[current] ?? [];
              // If we're at a terminal state with no exits, stop
              if (validTargets.length === 0) break;
              // Deterministic pick: use (i % validTargets.length)
              const next = validTargets[i % validTargets.length]!;
              expect(isValidTransition(current, next)).toBe(true);
              current = next;
              walked.push(current);
            }
            // Every adjacent pair in the walk must be a valid transition
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
