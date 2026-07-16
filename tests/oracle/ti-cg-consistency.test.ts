/**
 * NRI + PBT for TI↔CG consistency invariants C4/C5 (SPEC §4.6).
 *
 * 1:1 port of .oracle/tla/models/CrossConsistency.tla C4/C5 dimension:
 *   C4 — TI.RUNNING ⇒ CG.state ∈ active_states
 *   C5 — TI.{SUCCESS,FAILED} ⇒ CG.state ∈ terminal_states
 *
 * Uses fast-check for PBT over all valid TI + CG state combinations.
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import type { TaskInstanceState, ContainerGroupState } from '../../src/core/dag/types.ts';
import { isCgConsistentWithTi, isCgTerminal } from '../../src/core/dag/types.ts';

const ALL_TI_STATES: readonly TaskInstanceState[] = [
  'NONE', 'SCHEDULED', 'QUEUED', 'RUNNING',
  'SUCCESS', 'FAILED', 'UP_FOR_RETRY', 'SKIPPED',
  'UPSTREAM_FAILED', 'DEFERRED', 'RESTARTING', 'REMOVED',
];

const ALL_CG_STATES: readonly ContainerGroupState[] = [
  'Scheduling', 'ScheduleFailed', 'Pending', 'Running',
  'Succeeded', 'Failed', 'Restarting', 'Updating',
  'Terminating', 'Expired', 'Deleted',
];

const ACTIVE_CG = ALL_CG_STATES.filter(s => !isCgTerminal(s));
const TERMINAL_CG = ALL_CG_STATES.filter(s => isCgTerminal(s));

// ═══════════════════════════════════════════════════════════════
// NRI — Naive Reference Implementation
// (ported from CrossConsistency.tla C4/C5 concept)
// ═══════════════════════════════════════════════════════════════

function nriC4(ti: TaskInstanceState, cg: ContainerGroupState): boolean {
  // C4: TI.RUNNING ⇒ CG.state ∈ active_states (not terminal)
  if (ti === 'RUNNING') return !isCgTerminal(cg);
  return true;
}

function nriC5(ti: TaskInstanceState, cg: ContainerGroupState): boolean {
  // C5: TI.{SUCCESS,FAILED} ⇒ CG.state ∈ terminal_states
  if (ti === 'SUCCESS' || ti === 'FAILED') return isCgTerminal(cg);
  return true;
}

// ═══════════════════════════════════════════════════════════════
// Buggy variants (for invariant sensitivity)
// ═══════════════════════════════════════════════════════════════

/** Violates C4: allows terminal CG when TI is RUNNING. */
function buggyC4_alwaysTrue(_ti: TaskInstanceState, _cg: ContainerGroupState): boolean {
  return true;
}

/** Violates C5: allows non-terminal CG when TI is SUCCESS. */
function buggyC5_alwaysTrue(_ti: TaskInstanceState, _cg: ContainerGroupState): boolean {
  return true;
}

// ═══════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════

describe('TI↔CG consistency (C4/C5)', () => {

  // ─── C4: Exhaustive ───

  describe('C4 — TI.RUNNING ⇒ CG.state ∈ active_states', () => {
    it('every terminal CG state violates C4 when TI=RUNNING', () => {
      for (const cg of TERMINAL_CG) {
        expect(nriC4('RUNNING', cg)).toBe(false);
        expect(isCgConsistentWithTi('RUNNING', cg)).toBe(false);
      }
    });

    it('every active CG state satisfies C4 when TI=RUNNING', () => {
      for (const cg of ACTIVE_CG) {
        expect(nriC4('RUNNING', cg)).toBe(true);
        expect(isCgConsistentWithTi('RUNNING', cg)).toBe(true);
      }
    });

    it('non-RUNNING TI states are always C4-satisfied', () => {
      for (const ti of ALL_TI_STATES) {
        if (ti === 'RUNNING') continue;
        for (const cg of ALL_CG_STATES) {
          expect(nriC4(ti, cg)).toBe(true);
        }
      }
    });
  });

  // ─── C5: Exhaustive ───

  describe('C5 — TI.{SUCCESS,FAILED} ⇒ CG.state ∈ terminal_states', () => {
    it('every terminal CG state satisfies C5 when TI=SUCCESS', () => {
      for (const cg of TERMINAL_CG) {
        expect(nriC5('SUCCESS', cg)).toBe(true);
        expect(isCgConsistentWithTi('SUCCESS', cg)).toBe(true);
      }
    });

    it('every active CG state violates C5 when TI=SUCCESS', () => {
      for (const cg of ACTIVE_CG) {
        expect(nriC5('SUCCESS', cg)).toBe(false);
        expect(isCgConsistentWithTi('SUCCESS', cg)).toBe(false);
      }
    });

    it('every terminal CG state satisfies C5 when TI=FAILED', () => {
      for (const cg of TERMINAL_CG) {
        expect(nriC5('FAILED', cg)).toBe(true);
        expect(isCgConsistentWithTi('FAILED', cg)).toBe(true);
      }
    });

    it('every active CG state violates C5 when TI=FAILED', () => {
      for (const cg of ACTIVE_CG) {
        expect(nriC5('FAILED', cg)).toBe(false);
        expect(isCgConsistentWithTi('FAILED', cg)).toBe(false);
      }
    });

    it('non-SUCCESS/FAILED TI states are always C5-satisfied', () => {
      const relevant = ALL_TI_STATES.filter(s => s !== 'SUCCESS' && s !== 'FAILED');
      for (const ti of relevant) {
        for (const cg of ALL_CG_STATES) {
          expect(nriC5(ti, cg)).toBe(true);
        }
      }
    });
  });

  // ─── PBT: 1:1 fast-check model over all combos ───

  describe('PBT — random TI×CG pairs', () => {
    it('NRI and TS agree on all C4/C5 checks', () => {
      fc.assert(
        fc.property(
          fc.constantFrom(...ALL_TI_STATES),
          fc.constantFrom(...ALL_CG_STATES),
          (ti, cg) => {
            expect(isCgConsistentWithTi(ti, cg)).toBe(nriC4(ti, cg) && nriC5(ti, cg));
          },
        ),
        { numRuns: 500 },
      );
    });
  });

  // ─── Bug detection ───

  describe('invariant sensitivity', () => {
    it('C4 invariant detects buggyC4_alwaysTrue', () => {
      fc.assert(
        fc.property(
          fc.constantFrom(...ALL_TI_STATES),
          fc.constantFrom(...ALL_CG_STATES),
          (ti, cg) => {
            // For RUNNING+terminal pairs, NRI returns false but buggy returns true
            if (ti === 'RUNNING' && isCgTerminal(cg)) {
              expect(nriC4(ti, cg)).toBe(false);
              expect(buggyC4_alwaysTrue(ti, cg)).toBe(true);
              // C4 must detect the divergence
              expect(isCgConsistentWithTi(ti, cg)).toBe(false);
            }
          },
        ),
      );
    });

    it('C5 invariant detects buggyC5_alwaysTrue', () => {
      fc.assert(
        fc.property(
          fc.constantFrom(...ALL_TI_STATES),
          fc.constantFrom(...ALL_CG_STATES),
          (ti, cg) => {
            if ((ti === 'SUCCESS' || ti === 'FAILED') && !isCgTerminal(cg)) {
              expect(nriC5(ti, cg)).toBe(false);
              expect(buggyC5_alwaysTrue(ti, cg)).toBe(true);
              expect(isCgConsistentWithTi(ti, cg)).toBe(false);
            }
          },
        ),
      );
    });
  });
});
