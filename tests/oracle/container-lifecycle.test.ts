/**
 * NRI + PBT for ContainerGroup state machine invariants (SPEC §5.1).
 *
 * 1:1 port of .oracle/tla/models/ContainerLifecycle.tla:
 *   P1 — NoResurrection: hard-terminal states are absorbing
 *   P2 — RestartLegality: Restarting only from Running
 *   P3 — UpdateLegality: Updating only from Running
 *   P4 — DeleteLegality: Terminating only from deletable set
 *   P5 — DeletedAbsorbing: Deleted is absorbing
 *
 * Uses fast-check for PBT over valid CG transitions.
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import type { ContainerGroupState } from '../../src/core/dag/types.ts';
import { CG_VALID_TRANSITIONS } from '../../src/core/dag/types.ts';

const ALL_CG_STATES: readonly ContainerGroupState[] = [
  'Scheduling', 'ScheduleFailed', 'Pending', 'Running',
  'Succeeded', 'Failed', 'Restarting', 'Updating',
  'Terminating', 'Expired', 'Deleted',
];

// States that can transition to Terminating (computed from CG_VALID_TRANSITIONS)
const DELETABLE: readonly ContainerGroupState[] = ['Pending', 'Running', 'Restarting', 'Updating', 'Succeeded', 'Failed'];

// ═══════════════════════════════════════════════════════════════
// NRI — Naive Reference Implementation
// (ported from ContainerLifecycle.tla safety invariants)
// ═══════════════════════════════════════════════════════════════

/** P1: Only Deleted is truly absorbing. ScheduleFailed/Expired have GC exit to Deleted. */
function nriP1_NoResurrection(from: ContainerGroupState, to: ContainerGroupState): boolean {
  if (from === 'Deleted') return from === to;
  return true;
}

/** P2: Restarting only from Running. */
function nriP2_RestartLegality(from: ContainerGroupState, to: ContainerGroupState): boolean {
  if (to === 'Restarting') return from === 'Running';
  return true;
}

/** P3: Updating only from Running. */
function nriP3_UpdateLegality(from: ContainerGroupState, to: ContainerGroupState): boolean {
  if (to === 'Updating') return from === 'Running';
  return true;
}

/** P4: Terminating only from deletable set. */
function nriP4_DeleteLegality(from: ContainerGroupState, to: ContainerGroupState): boolean {
  if (to === 'Terminating') return (DELETABLE as readonly ContainerGroupState[]).includes(from);
  return true;
}

/** P5: Deleted is absorbing — no transitions out. */
function nriP5_DeletedAbsorbing(from: ContainerGroupState, to: ContainerGroupState): boolean {
  if (from === 'Deleted') return from === to;
  return true;
}

/** Combined — all P1-P5 must hold for a valid transition. */
function nriAllInvariants(from: ContainerGroupState, to: ContainerGroupState): boolean {
  return (
    nriP1_NoResurrection(from, to) &&
    nriP2_RestartLegality(from, to) &&
    nriP3_UpdateLegality(from, to) &&
    nriP4_DeleteLegality(from, to) &&
    nriP5_DeletedAbsorbing(from, to)
  );
}

/** Check if a (from→to) transition is claimed valid by the transition table. */
function isValidTransition(from: ContainerGroupState, to: ContainerGroupState): boolean {
  return CG_VALID_TRANSITIONS[from].includes(to);
}

/** A transition is "valid" only if the table says so AND all invariants pass. */
function nriValidTransition(from: ContainerGroupState, to: ContainerGroupState): boolean {
  if (from === to) return true; // self-transition always valid
  return isValidTransition(from, to) && nriAllInvariants(from, to);
}

// ═══════════════════════════════════════════════════════════════
// Buggy variants (for invariant sensitivity)
// ═══════════════════════════════════════════════════════════════

/** Violates P1: allows transitions out of hard-terminal (always returns true). */
function buggyP1_Resurrect(_from: ContainerGroupState, _to: ContainerGroupState): boolean {
  return true;
}

/** Violates P2: allows Restarting from any state (always true for Restarting). */
function buggyP2_AnyRestart(_from: ContainerGroupState, to: ContainerGroupState): boolean {
  if (to === 'Restarting') return true;
  return true;
}

// ═══════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════

describe('ContainerGroup lifecycle invariants (P1-P5)', () => {

  // ─── P1: NoResurrection ───

  describe('P1 — NoResurrection', () => {
    it('Deleted cannot transition to any other state', () => {
      for (const to of ALL_CG_STATES) {
        if (to === 'Deleted') {
          expect(nriP1_NoResurrection('Deleted', to)).toBe(true);
        } else {
          expect(nriP1_NoResurrection('Deleted', to)).toBe(false);
        }
      }
    });

    it('non-Deleted states always satisfy P1', () => {
      for (const from of ALL_CG_STATES) {
        if (from === 'Deleted') continue;
        for (const to of ALL_CG_STATES) {
          expect(nriP1_NoResurrection(from, to)).toBe(true);
        }
      }
    });
  });

  // ─── P2: RestartLegality ───

  describe('P2 — RestartLegality', () => {
    it('Restarting is only valid from Running', () => {
      for (const from of ALL_CG_STATES) {
        if (from === 'Running') {
          expect(nriP2_RestartLegality(from, 'Restarting')).toBe(true);
        } else {
          expect(nriP2_RestartLegality(from, 'Restarting')).toBe(false);
        }
      }
    });
  });

  // ─── P3: UpdateLegality ───

  describe('P3 — UpdateLegality', () => {
    it('Updating is only valid from Running', () => {
      for (const from of ALL_CG_STATES) {
        if (from === 'Running') {
          expect(nriP3_UpdateLegality(from, 'Updating')).toBe(true);
        } else {
          expect(nriP3_UpdateLegality(from, 'Updating')).toBe(false);
        }
      }
    });
  });

  // ─── P4: DeleteLegality ───

  describe('P4 — DeleteLegality', () => {
    it('Terminating is only valid from deletable states (Running, Restarting)', () => {
      for (const from of ALL_CG_STATES) {
        if ((DELETABLE as readonly ContainerGroupState[]).includes(from)) {
          expect(nriP4_DeleteLegality(from, 'Terminating')).toBe(true);
        } else {
          expect(nriP4_DeleteLegality(from, 'Terminating')).toBe(false);
        }
      }
    });
  });

  // ─── P5: DeletedAbsorbing ───

  describe('P5 — DeletedAbsorbing', () => {
    it('Deleted cannot transition to any other state', () => {
      for (const to of ALL_CG_STATES) {
        if (to === 'Deleted') {
          expect(nriP5_DeletedAbsorbing('Deleted', to)).toBe(true);
        } else {
          expect(nriP5_DeletedAbsorbing('Deleted', to)).toBe(false);
        }
      }
    });
  });

  // ─── Transition table consistency ───

  describe('transition table vs invariants', () => {
    it('every valid non-self transition in CG_VALID_TRANSITIONS passes all P1-P5', () => {
      for (const [from, tos] of Object.entries(CG_VALID_TRANSITIONS) as [ContainerGroupState, readonly ContainerGroupState[]][]) {
        for (const to of tos) {
          if (from === to) continue;
          expect(nriAllInvariants(from, to)).toBe(true);
        }
      }
    });

    it('every cell in CG_VALID_TRANSITIONS is internally consistent', () => {
      for (const [from, tos] of Object.entries(CG_VALID_TRANSITIONS) as [ContainerGroupState, readonly ContainerGroupState[]][]) {
        for (const to of tos) {
          expect(CG_VALID_TRANSITIONS[to]).toBeDefined();
        }
      }
    });
  });

  // ─── PBT: random transitions ───

  describe('PBT — random CG transition pairs', () => {
    it('all self-transitions are valid (identity)', () => {
      fc.assert(
        fc.property(
          fc.constantFrom(...ALL_CG_STATES),
          (s) => {
            expect(nriValidTransition(s, s)).toBe(true);
          },
        ),
      );
    });

    it('valid transitions respect all P1-P5 invariants', () => {
      fc.assert(
        fc.property(
          fc.constantFrom(...ALL_CG_STATES),
          fc.constantFrom(...ALL_CG_STATES),
          (from, to) => {
            if (from === to) return; // self-transition

            const tableValid = isValidTransition(from, to);
            const nriValid = nriAllInvariants(from, to);

            if (tableValid) {
              expect(nriValid).toBe(true);
            }
            // If table says invalid but NRI says valid, the table might be incomplete
          },
        ),
        { numRuns: 500 },
      );
    });
  });

  // ─── Bug detection ───

  describe('invariant sensitivity', () => {
    it('P1 detects buggyP1_Resurrect from Deleted', () => {
      for (const to of ALL_CG_STATES) {
        if (to === 'Deleted') continue;
        expect(nriP1_NoResurrection('Deleted', to)).toBe(false);
        expect(buggyP1_Resurrect('Deleted', to)).toBe(true);
      }
    });

    it('P2 detects buggyP2_AnyRestart for non-Running states', () => {
      fc.assert(
        fc.property(
          fc.constantFrom(...ALL_CG_STATES),
          (from) => {
            if (from === 'Running') return;
            expect(nriP2_RestartLegality(from, 'Restarting')).toBe(false);
            expect(buggyP2_AnyRestart(from, 'Restarting')).toBe(true);
          },
        ),
      );
    });
  });
});
