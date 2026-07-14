/**
 * PARKED / disabled — fast-check model-based oracle for task-instance.
 *
 * Why parked: transitionState() is already verified by the .oracle Python
 * differential (.oracle/tests/test_task_instance.py, 144-cell matrix + TS
 * differential). This in-repo modelRun is a second copy of the same check
 * (its extra value is sequence testing + shrinking); judged low marginal
 * value vs its upkeep for now, so it's kept off. See ISSUE-00058.
 *
 * To re-enable: uncomment the body below and remove the describe.skip stub.
 * (fast-check ^4.8 is already a devDependency.)
 *
 * The stub below keeps vitest happy — a fully-commented file errors with
 * "No test suite found".
 */
import { describe, it } from 'vitest';
describe.skip('task-instance NRI model — PARKED (see file header)', () => {
  it('parked', () => {});
});

// import { describe, it, expect } from 'vitest';
// import fc from 'fast-check';
// import { transitionState } from '../../src/core/scheduler/task-instance.ts';
// import { isTaskTerminal, TASK_VALID_TRANSITIONS } from '../../src/core/dag/types.ts';
// import type { TaskInstance, TaskInstanceState } from '../../src/core/dag/types.ts';

// // ═══════════════════════════════════════════════════════════════
// // NRI — Naive Reference Implementation
// // (ported from .oracle/tests/nri_task_instance.py)
// //
// // Structural differences from TS (transitionState):
// //   1. Returns null for rejected transitions (TS throws)
// //   2. Self-transition is always identity (TS throws for non-terminal)
// //   3. Terminal absorbing via explicit guard (TS same, both return self)
// // ═══════════════════════════════════════════════════════════════

// const ALL_STATES: readonly TaskInstanceState[] = [
//   'NONE', 'SCHEDULED', 'QUEUED', 'RUNNING',
//   'SUCCESS', 'FAILED', 'UP_FOR_RETRY', 'SKIPPED',
//   'UPSTREAM_FAILED', 'DEFERRED', 'RESTARTING', 'REMOVED',
// ];

// function nriTransitionState(
//   from: TaskInstanceState,
//   to: TaskInstanceState,
// ): TaskInstanceState | null {
//   // P2: Self-transition is always identity
//   if (from === to) return from;
//   // Valid transition
//   if (TASK_VALID_TRANSITIONS[from].includes(to)) return to;
//   // P1: Terminal states are absorbing
//   if (isTaskTerminal(from)) return from;
//   // Invalid transition from non-terminal — rejected
//   return null;
// }

// // ═══════════════════════════════════════════════════════════════
// // Invariant checks (from Python)
// // ═══════════════════════════════════════════════════════════════

// function checkP1_terminalAbsorbing(
//   from: TaskInstanceState, to: TaskInstanceState,
//   result: TaskInstanceState | null,
// ): boolean {
//   if (isTaskTerminal(from) && from !== to) return result === from;
//   return true;
// }

// function checkP2_selfIdentity(
//   from: TaskInstanceState, to: TaskInstanceState,
//   result: TaskInstanceState | null,
// ): boolean {
//   if (from === to) return result === from;
//   return true;
// }

// function checkP4_invalidRejected(
//   from: TaskInstanceState, to: TaskInstanceState,
//   result: TaskInstanceState | null,
// ): boolean {
//   if (!isTaskTerminal(from) && from !== to) {
//     if (!TASK_VALID_TRANSITIONS[from].includes(to)) return result === null;
//   }
//   return true;
// }

// // ═══════════════════════════════════════════════════════════════
// // Buggy NRI variants (for invariant sensitivity / shrinking)
// // ═══════════════════════════════════════════════════════════════

// /** Violates P1: terminal states accept transitions away. */
// function buggy_terminalNotAbsorbing(
//   from: TaskInstanceState, to: TaskInstanceState,
// ): TaskInstanceState | null {
//   if (from === to) return from;
//   if (TASK_VALID_TRANSITIONS[from].includes(to)) return to;
//   return to; // BUG: accepts invalid
// }

// /** Violates P2: self-transition returns null. */
// function buggy_selfNotIdentity(
//   from: TaskInstanceState, to: TaskInstanceState,
// ): TaskInstanceState | null {
//   if (from === to) return null; // BUG
//   return TASK_VALID_TRANSITIONS[from].includes(to)
//     ? to
//     : (isTaskTerminal(from) ? from : null);
// }

// // ═══════════════════════════════════════════════════════════════
// // modelRun — fast-check model-based testing
// // ═══════════════════════════════════════════════════════════════

// interface M {
//   state: TaskInstanceState;
// }

// class R {
//   ti: TaskInstance;
//   constructor(s: TaskInstanceState) {
//     this.ti = {
//       id: 'oracle-id' as TaskInstance['id'],
//       taskId: 'oracle-tk' as TaskInstance['taskId'],
//       dagRunId: 'oracle-dr' as TaskInstance['dagRunId'],
//       state: s,
//       tryNumber: 0,
//       version: 'oracle-v1' as TaskInstance['version'],
//     };
//   }
// }

// /**
//  * Command: transition to a random state.
//  *
//  * Applies transitionState to the real system and nriTransitionState to the
//  * model, then checks that both agree on the resulting state.
//  *
//  * The known self-transition divergence (NRI identity vs TS throw) is handled
//  * transparently: both leave the state unchanged, so they remain consistent.
//  */
// class TrCmd implements fc.Command<M, R> {
//   constructor(readonly to: TaskInstanceState) {}

//   check(_m: Readonly<M>): boolean {
//     return true; // all transitions are valid test cases
//   }

//   run(m: M, r: R): void {
//     const from = m.state;
//     const nri = nriTransitionState(from, this.to);

//     try {
//       const ts = transitionState(r.ti, this.to);
//       // TS succeeded — NRI must also have returned a state
//       expect(nri).not.toBeNull();
//       // Both agree on final state
//       expect(ts.state).toBe(nri);
//       // Update model and real for next command
//       m.state = ts.state;
//       r.ti = ts;
//     } catch {
//       // TS threw. NRI should also have rejected (null for invalid or identity
//       // for self-transition). In both cases the state is unchanged, so model
//       // and real remain consistent without updating m.state / r.ti.
//       //
//       // The only divergence to guard against: NRI accepts but TS rejects for
//       // a NON-self transition — which would be a real implementation mismatch.
//       if (nri !== null && from !== this.to) {
//         throw new Error(
//           `DIVERGENCE: TS rejected ${from}→${this.to} but NRI accepted (→${nri})`,
//         );
//       }
//       // else: known cases where state is unchanged by both:
//       //   - nri === null && from !== to: both reject
//       //   - nri !== null && from === to: NRI identity, TS throw (known divergence)
//       //   - nri === null && from === to: impossible (NRI never rejects self)
//     }
//   }
// }

// /** Arbitrary that generates a single random transition command. */
// const trCmdArb: fc.Arbitrary<fc.Command<M, R>> =
//   fc.constantFrom(...ALL_STATES).map(to => new TrCmd(to));

// // ═══════════════════════════════════════════════════════════════
// // Tests
// // ═══════════════════════════════════════════════════════════════

// describe('TaskInstance NRI model vs TS', () => {
//   // ─── NRI 12×12 matrix ───

//   describe('NRI 12×12 transition matrix', () => {
//     it('all 144 cells produce correct outcome', () => {
//       let validCount = 0;
//       let selfCount = 0;
//       let terminalAbsorbCount = 0;
//       let rejectCount = 0;

//       for (const from of ALL_STATES) {
//         for (const to of ALL_STATES) {
//           const result = nriTransitionState(from, to);

//           if (from === to) {
//             // P2: self-transition identity
//             selfCount++;
//             expect(result).toBe(from);
//           } else if (TASK_VALID_TRANSITIONS[from].includes(to)) {
//             // Valid transition
//             validCount++;
//             expect(result).toBe(to);
//           } else if (isTaskTerminal(from)) {
//             // P1: terminal absorbing
//             terminalAbsorbCount++;
//             expect(result).toBe(from);
//           } else {
//             // P4: invalid rejected
//             rejectCount++;
//             expect(result).toBeNull();
//           }
//         }
//       }

//       // Sanity: sum of all VALID_TRANSITIONS entries
//       const expectedValid = Object.values(TASK_VALID_TRANSITIONS)
//         .reduce((s, arr) => s + arr.length, 0);
//       expect(validCount).toBe(expectedValid);
//       expect(selfCount).toBe(12);
//       expect(selfCount + validCount + terminalAbsorbCount + rejectCount).toBe(144);
//     });
//   });

//   // ─── modelRun differential ───

//   describe('modelRun differential (NRI vs TS)', () => {
//     it('agrees on all random transition sequences from NONE', () => {
//       fc.assert(
//         fc.property(
//           fc.commands([trCmdArb]),
//           (cmds) => {
//             fc.modelRun(
//               () => ({ model: { state: 'NONE' as TaskInstanceState }, real: new R('NONE') }),
//               cmds,
//             );
//           },
//         ),
//         { numRuns: 2000 },
//       );
//     });

//     it('agrees from QUEUED (retry entry point)', () => {
//       fc.assert(
//         fc.property(
//           fc.commands([trCmdArb]),
//           (cmds) => {
//             fc.modelRun(
//               () => ({ model: { state: 'QUEUED' as TaskInstanceState }, real: new R('QUEUED') }),
//               cmds,
//             );
//           },
//         ),
//         { numRuns: 500 },
//       );
//     });
//   });

//   // ─── Terminal absorption (P1) ───

//   describe('terminal absorption (P1)', () => {
//     it('modelRun from terminal: all transitions leave state unchanged', () => {
//       fc.assert(
//         fc.property(
//           fc.commands([trCmdArb], { maxCommands: 10 }),
//           (cmds) => {
//             fc.modelRun(
//               () => ({ model: { state: 'SUCCESS' as TaskInstanceState }, real: new R('SUCCESS') }),
//               cmds,
//             );
//           },
//         ),
//         { numRuns: 500 },
//       );
//     });

//     it('all terminal states are absorbing (explicit 12×12)', () => {
//       for (const terminal of ['SUCCESS', 'FAILED', 'SKIPPED', 'UPSTREAM_FAILED', 'REMOVED'] as const) {
//         for (const other of ALL_STATES) {
//           if (other === terminal) continue;
//           // NRI
//           expect(nriTransitionState(terminal, other)).toBe(terminal);
//           // TS
//           const ti = new R(terminal).ti;
//           const r = transitionState(ti, other);
//           expect(r).toBe(ti); // returns unchanged (same ref)
//           expect(r.state).toBe(terminal);
//         }
//       }
//     });

//     it('P1 invariant detects buggy terminal_not_absorbing', () => {
//       // Only terminal from-states trigger P1; skip non-terminal to avoid
//       // triggering on invalid-accepted divergence (which P4 catches).
//       for (const from of ALL_STATES) {
//         if (!isTaskTerminal(from)) continue;
//         for (const to of ALL_STATES) {
//           const nri = nriTransitionState(from, to);
//           const buggy = buggy_terminalNotAbsorbing(from, to);
//           if (nri !== buggy) {
//             // Mutation diverged — P1 must detect it
//             expect(checkP1_terminalAbsorbing(from, to, buggy)).toBe(false);
//             return; // found one divergent case
//           }
//         }
//       }
//       expect.unreachable('buggy_terminalNotAbsorbing never diverged from NRI');
//     });

//     it('P2 invariant detects buggy self_not_identity', () => {
//       // P2 only applies to self-transitions (from === to).
//       for (const from of ALL_STATES) {
//         const nri = nriTransitionState(from, from);
//         const buggy = buggy_selfNotIdentity(from, from);
//         if (nri !== buggy) {
//           expect(checkP2_selfIdentity(from, from, buggy)).toBe(false);
//           return;
//         }
//       }
//       expect.unreachable('buggy_selfNotIdentity never diverged from NRI');
//     });
//   });

//   // ─── Known divergence ───

//   describe('known divergence: self-transition', () => {
//     it('NRI returns identity for ALL self-transitions (P2)', () => {
//       for (const s of ALL_STATES) {
//         expect(nriTransitionState(s, s)).toBe(s);
//       }
//     });

//     it('TS throws for non-terminal self-transitions', () => {
//       for (const s of ALL_STATES) {
//         if (isTaskTerminal(s)) continue;
//         const ti = new R(s).ti;
//         expect(() => transitionState(ti, s)).toThrow();
//       }
//     });

//     it('TS returns unchanged for terminal self-transitions', () => {
//       for (const s of ALL_STATES) {
//         if (!isTaskTerminal(s)) continue;
//         const ti = new R(s).ti;
//         const r = transitionState(ti, s);
//         expect(r).toBe(ti); // same reference (absorbing guard)
//         expect(r.state).toBe(s);
//       }
//     });

//     it('modelRun handles self-transition divergence transparently', () => {
//       // Even though NRI and TS disagree on self-transition behavior at the
//       // exception level, they agree at the state level: both leave the state
//       // unchanged. modelRun should handle this without error.
//       fc.assert(
//         fc.property(
//           fc.commands([trCmdArb], { maxCommands: 5 }),
//           (cmds) => {
//             fc.modelRun(
//               () => ({ model: { state: 'RUNNING' as TaskInstanceState }, real: new R('RUNNING') }),
//               cmds,
//             );
//           },
//         ),
//         { numRuns: 200 },
//       );
//     });
//   });

//   // ─── Retry cycle ───

//   describe('retry cycle', () => {
//     it('QUEUED→RUNNING→UP_FOR_RETRY→QUEUED is a closed cycle', () => {
//       const ti = new R('QUEUED').ti;
//       const r1 = transitionState(ti, 'RUNNING');
//       expect(r1.state).toBe('RUNNING');
//       const r2 = transitionState(r1, 'UP_FOR_RETRY');
//       expect(r2.state).toBe('UP_FOR_RETRY');
//       const r3 = transitionState(r2, 'QUEUED');
//       expect(r3.state).toBe('QUEUED');
//     });

//     it('UP_FOR_RETRY→FAILED is terminal exit', () => {
//       const ti = new R('UP_FOR_RETRY').ti;
//       const r = transitionState(ti, 'FAILED');
//       expect(r.state).toBe('FAILED');
//       expect(isTaskTerminal(r.state)).toBe(true);
//     });

//     it('modelRun verifies retry cycle across random sequences from QUEUED', () => {
//       // Start from QUEUED and exercise the retry subspace.
//       // This tests that NRI and TS stay consistent through any number of
//       // retry-related transitions (QUEUED↔RUNNING↔UP_FOR_RETRY) and exits.
//       fc.assert(
//         fc.property(
//           fc.commands([trCmdArb], { maxCommands: 8 }),
//           (cmds) => {
//             fc.modelRun(
//               () => ({ model: { state: 'QUEUED' as TaskInstanceState }, real: new R('QUEUED') }),
//               cmds,
//             );
//           },
//         ),
//         { numRuns: 500 },
//       );
//     });
//   });

//   // ─── Bug detection + shrinking ───

//   describe('bug detection and shrinking', () => {
//     it('property-based test detects buggy_terminalNotAbsorbing with shrinking', () => {
//       // Use fc.check (non-throwing) to inspect shrinking metadata.
//       const result = fc.check(
//         fc.property(
//           fc.constantFrom(...ALL_STATES),
//           fc.constantFrom(...ALL_STATES),
//           (from, to) => {
//             const buggy = buggy_terminalNotAbsorbing(from, to);
//             const ti = new R(from).ti;
//             try {
//               const ts = transitionState(ti, to).state;
//               if (ts !== buggy) {
//                 throw new Error(`TS=${ts} buggy=${buggy} from=${from} to=${to}`);
//               }
//             } catch {
//               if (buggy !== null) {
//                 throw new Error(`TS threw buggy→${buggy} from=${from} to=${to}`);
//               }
//             }
//           },
//         ),
//         { numRuns: 200 },
//       );

//       expect(result.failed).toBe(true);
//       expect(result.numShrinks).toBeGreaterThan(0);
//       // The minimal counterexample is a (from, to) pair where a terminal
//       // state absorbs but the buggy NRI doesn't: e.g. (SUCCESS, DEFERRED).
//       expect(result.counterexample).not.toBeNull();
//     });
//   });

//   // ─── Invariant sensitivity (anti-tautology) ───

//   describe('invariant detection power', () => {
//     it('P1 catches terminal_not_absorbing for all terminal states', () => {
//       // Every (from,to) pair where the mutation diverges from NRI and from
//       // is terminal must fail P1. If P1 is a tautology, this test fails.
//       for (const from of ALL_STATES) {
//         if (!isTaskTerminal(from)) continue;
//         for (const to of ALL_STATES) {
//           const nri = nriTransitionState(from, to);
//           const buggy = buggy_terminalNotAbsorbing(from, to);
//           if (nri !== buggy) {
//             expect(checkP1_terminalAbsorbing(from, to, buggy)).toBe(false);
//           }
//         }
//       }
//     });
//   });
// });
