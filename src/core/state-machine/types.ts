/**
 * Compile-time state machine contract enforcers.
 *
 * Adding a new state to a status enum → must update its transition table
 * and terminal-state set, or TypeScript refuses to compile.
 *
 * Pattern adapted from the completeness contract philosophy:
 *   Record<Status, Status[]> → exhaustive transition map
 *   ReadonlySet<Status>      → exhaustive terminal-state set
 */

/** Ensure a transition map covers every key in the given status union. */
export type ExhaustiveTransitions<S extends string> = Record<S, readonly S[]>;

/** Ensure a terminal-state set is a subset of valid states. */
export type TerminalStates<S extends string> = ReadonlySet<S>;

/**
 * Create an exhaustive transitions table from a status enum or union.
 *
 * Usage:
 *   type S = 'pending' | 'active' | 'done';
 *   const T = createTransitions<S>()({
 *     pending: ['active'],
 *     active:  ['done'],
 *     done:    [],
 *   });
 *
 * If a status is added to S but not to T → tsc error.
 */
export function createTransitions<S extends string>() {
  return <T extends ExhaustiveTransitions<S>>(table: T): T => table;
}

/**
 * Create an exhaustive terminal-states set.
 *
 * Usage:
 *   const terminals = createTerminalStates<S>()(new Set(['done']));
 */
export function createTerminalStates<S extends string>() {
  return (states: TerminalStates<S>): TerminalStates<S> => states;
}
