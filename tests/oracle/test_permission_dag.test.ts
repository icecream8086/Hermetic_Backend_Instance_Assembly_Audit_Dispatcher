/**
 * Oracle-aligned deny-overrides DAG evaluation tests.
 *
 * NRI (Naive Reference Implementation) ported from
 * .oracle/tests/nri_permission_dag.py — independent deny-overrides evaluation
 * algorithm with DFS-based topological sort (structurally different from TS
 * PermissionDag which uses Kahn's BFS-based topological sort).
 *
 * Security-critical: deny-overrides is the core authorization path.
 * A bug here = privilege escalation or false denial.
 *
 * Run: npx vitest run tests/oracle/test_permission_dag.test.ts
 */
import { describe, it, expect } from 'vitest';
import { PermissionDag } from '../../src/core/permission/permission-dag.ts';
import { PermissionEffect } from '../../src/core/permission/types.ts';
import type {
  PermissionCheck,
  PolicyId,
} from '../../src/core/permission/types.ts';

// ═══════════════════════════════════════════════════════════════════════════
// NRI — Naive Reference Implementation (ports nri_permission_dag.py)
//
// Structural differences from TS PermissionDag:
//   1. DFS-based topological sort (post-order) v. Kahn's algorithm (BFS)
//   2. Flat rule list with inline dependency edges v. Dag base class
//   3. Substring-based matching v. generic match() callback
//   4. Explicit adjacency building v. outgoing/incoming maps
// ═══════════════════════════════════════════════════════════════════════════

interface NRIRule {
  ruleId: string;
  effect: 'allow' | 'deny';
  matchField: 'actor' | 'resource' | 'action';
  matchPattern: string;
  dependsOn: string[];
}

interface NRIOutcome {
  allowed: boolean;
  reason: string;
  matchedRule?: string;
}

function nriRuleMatches(rule: NRIRule, check: PermissionCheck): boolean {
  const value: Record<string, string> = {
    actor: check.actor,
    resource: check.resource,
    action: check.action,
    resourceId: check.resourceId,
  };
  const fieldVal = value[rule.matchField];
  if (fieldVal === undefined) return false;
  return fieldVal.includes(rule.matchPattern);
}

function nriBuildAdjacency(
  rules: NRIRule[],
): Map<string, string[]> {
  const adj = new Map<string, string[]>();
  for (const r of rules) {
    adj.set(r.ruleId, [...r.dependsOn]);
  }
  return adj;
}

/**
 * DFS-based topological sort (post-order traversal).
 * Different from TS PermissionDag.topologicalSort() which uses Kahn's algorithm.
 * Returns [sorted, error?].
 */
function nriTopoSort(
  rules: NRIRule[],
): [NRIRule[], string | undefined] {
  const adj = nriBuildAdjacency(rules);
  const visited = new Set<string>();
  const path = new Set<string>();
  const order: NRIRule[] = [];
  const ruleMap = new Map(rules.map(r => [r.ruleId, r]));

  function visit(nid: string): string | undefined {
    if (path.has(nid)) return `Cycle detected at rule: ${nid}`;
    if (visited.has(nid)) return undefined;
    path.add(nid);
    visited.add(nid);
    for (const dep of adj.get(nid) ?? []) {
      const err = visit(dep);
      if (err !== undefined) return err;
    }
    path.delete(nid);
    const node = ruleMap.get(nid);
    if (node !== undefined) order.push(node);
    return undefined;
  }

  for (const r of rules) {
    if (!visited.has(r.ruleId)) {
      const err = visit(r.ruleId);
      if (err !== undefined) return [[], err];
    }
  }

  return [order, undefined];
}

/**
 * NRI evaluation: deny-overrides with DFS-based topological sort.
 * Semantically equivalent to TS PermissionDag.evaluate().
 */
function nriEvaluate(
  rules: NRIRule[],
  check: PermissionCheck,
): NRIOutcome {
  if (rules.length === 0) {
    return { allowed: false, reason: 'No matching policy' };
  }

  const [sorted, cycleErr] = nriTopoSort(rules);
  if (cycleErr !== undefined) {
    return { allowed: false, reason: `Cycle: ${cycleErr}` };
  }

  let candidate: NRIRule | undefined;

  for (const rule of sorted) {
    if (!nriRuleMatches(rule, check)) continue;

    if (rule.effect === 'deny') {
      return {
        allowed: false,
        reason: `Denied by policy: ${rule.ruleId}`,
        matchedRule: rule.ruleId,
      };
    }

    if (candidate === undefined) {
      candidate = rule;
    }
  }

  if (candidate !== undefined) {
    return {
      allowed: true,
      reason: `Allowed by policy: ${candidate.ruleId}`,
      matchedRule: candidate.ruleId,
    };
  }

  return { allowed: false, reason: 'No matching policy' };
}

// ═══════════════════════════════════════════════════════════════════════════
// Helpers — convert between NRI rules and TS PermissionDag
// ═══════════════════════════════════════════════════════════════════════════

function pid(id: string): PolicyId {
  return id as unknown as PolicyId;
}

/**
 * Build a TS PermissionDag equivalent to the NRI rule list.
 *
 * IMPORTANT dependency direction:
 *   NRI: rule.dependsOn = [X]  means "X must be evaluated before this rule"
 *   TS:  addDependency(from, to)  means "from is evaluated before to"
 *
 * So rule.dependsOn = [X] maps to addDependency(X, rule) — NOT addDependency(rule, X).
 */
function buildTSDag(
  rules: NRIRule[],
): PermissionDag {
  const dag = new PermissionDag();
  for (const rule of rules) {
    const effect =
      rule.effect === 'allow'
        ? PermissionEffect.ALLOW
        : PermissionEffect.DENY;
    dag.addPolicy({
      id: pid(rule.ruleId),
      effect,
      description: `${rule.effect} if ${rule.matchField} contains '${rule.matchPattern}'`,
      match: (p: PermissionCheck) => {
        const value: Record<string, string> = {
          actor: p.actor,
          resource: p.resource,
          action: p.action,
          resourceId: p.resourceId,
        };
        const fieldVal = value[rule.matchField];
        if (fieldVal === undefined) return false;
        return fieldVal.includes(rule.matchPattern);
      },
    });
  }
  // Add dependency edges: dep → rule  (dep evaluated before rule)
  for (const rule of rules) {
    for (const dep of rule.dependsOn) {
      dag.addDependency(pid(dep), pid(rule.ruleId));
    }
  }
  return dag;
}

function makeCheck(overrides: Partial<PermissionCheck> = {}): PermissionCheck {
  return {
    actor: 'alice',
    action: 'read',
    resource: 'document',
    resourceId: 'doc-123',
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Test scenarios — exhaustive authorization matrix
//
// Define a finite set of policy configurations and request variants covering:
//   - Single policy: ALLOW, DENY, no match
//   - Two policies: ALLOW+ALLOW, ALLOW+DENY, DENY+ALLOW, DENY+DENY, no match
//   - Chain dependencies: A→B, B→C
//   - Cycle detection
// ═══════════════════════════════════════════════════════════════════════════

interface Scenario {
  name: string;
  rules: NRIRule[];
  checks: Array<{
    check: PermissionCheck;
    expectedAllowed: boolean;
    description: string;
  }>;
}

const SCENARIOS: Scenario[] = [
  {
    name: 'single ALLOW matching',
    rules: [{ ruleId: 'r1', effect: 'allow', matchField: 'actor', matchPattern: 'alice', dependsOn: [] }],
    checks: [
      { check: makeCheck({ actor: 'alice' }), expectedAllowed: true, description: 'alice matches r1 => allow' },
      { check: makeCheck({ actor: 'bob' }), expectedAllowed: false, description: 'bob does not match => deny' },
    ],
  },
  {
    name: 'single DENY matching',
    rules: [{ ruleId: 'r1', effect: 'deny', matchField: 'actor', matchPattern: 'alice', dependsOn: [] }],
    checks: [
      { check: makeCheck({ actor: 'alice' }), expectedAllowed: false, description: 'alice matches deny => deny' },
      { check: makeCheck({ actor: 'bob' }), expectedAllowed: false, description: 'bob no match => deny' },
    ],
  },
  {
    name: 'ALLOW + DENY overlapping',
    rules: [
      { ruleId: 'allow-all', effect: 'allow', matchField: 'actor', matchPattern: 'alice', dependsOn: [] },
      { ruleId: 'deny-secret', effect: 'deny', matchField: 'resourceId', matchPattern: 'secret', dependsOn: [] },
    ],
    checks: [
      { check: makeCheck({ actor: 'alice', resourceId: 'doc-123' }), expectedAllowed: true, description: 'only allow matches => allow' },
      { check: makeCheck({ actor: 'alice', resourceId: 'secret-1' }), expectedAllowed: false, description: 'both match, deny overrides => deny' },
      { check: makeCheck({ actor: 'bob', resourceId: 'doc-123' }), expectedAllowed: false, description: 'neither matches => deny' },
    ],
  },
  {
    name: 'DENY before ALLOW in topo',
    rules: [
      { ruleId: 'deny-first', effect: 'deny', matchField: 'actor', matchPattern: 'alice', dependsOn: [] },
      { ruleId: 'allow-second', effect: 'allow', matchField: 'resource', matchPattern: 'doc', dependsOn: ['deny-first'] },
    ],
    checks: [
      { check: makeCheck({ actor: 'alice', resource: 'document' }), expectedAllowed: false, description: 'deny-first matches first in topo order => deny' },
    ],
  },
  {
    name: 'ALLOW + ALLOW both match',
    rules: [
      { ruleId: 'a1', effect: 'allow', matchField: 'actor', matchPattern: 'alice', dependsOn: [] },
      { ruleId: 'a2', effect: 'allow', matchField: 'resource', matchPattern: 'doc', dependsOn: [] },
    ],
    checks: [
      { check: makeCheck({ actor: 'alice', resource: 'document' }), expectedAllowed: true, description: 'both ALLOW match => allow' },
    ],
  },
  {
    name: 'dependency chain (both ALLOW)',
    rules: [
      { ruleId: 'specific', effect: 'allow', matchField: 'resourceId', matchPattern: 'secret', dependsOn: ['general'] },
      { ruleId: 'general', effect: 'allow', matchField: 'actor', matchPattern: 'alice', dependsOn: [] },
    ],
    checks: [
      { check: makeCheck({ actor: 'alice', resourceId: 'secret-1' }), expectedAllowed: true, description: 'both match => allow (general first in topo, specific second)' },
      { check: makeCheck({ actor: 'bob', resourceId: 'secret-1' }), expectedAllowed: true, description: 'specific matches even if general does not (dep only affects order) => allow' },
      { check: makeCheck({ actor: 'nobody', resourceId: 'public' }), expectedAllowed: false, description: 'neither matches => deny' },
    ],
  },
  {
    name: 'dependency chain with DENY in middle',
    rules: [
      { ruleId: 'top', effect: 'allow', matchField: 'actor', matchPattern: 'alice', dependsOn: ['middle'] },
      { ruleId: 'middle', effect: 'deny', matchField: 'resourceId', matchPattern: 'secret', dependsOn: ['bottom'] },
      { ruleId: 'bottom', effect: 'allow', matchField: 'action', matchPattern: 'read', dependsOn: [] },
    ],
    checks: [
      { check: makeCheck({ actor: 'alice', resourceId: 'secret-1', action: 'read' }), expectedAllowed: false, description: 'middle DENY matches => deny' },
      { check: makeCheck({ actor: 'alice', resourceId: 'open-doc', action: 'read' }), expectedAllowed: true, description: 'only top/bottom match, no DENY => allow' },
    ],
  },
  {
    name: 'no match at all',
    rules: [
      { ruleId: 'only-admin', effect: 'allow', matchField: 'actor', matchPattern: 'admin', dependsOn: [] },
    ],
    checks: [
      { check: makeCheck({ actor: 'nobody' }), expectedAllowed: false, description: 'no rules match => deny' },
    ],
  },
  {
    name: 'multiple DENY, one matches',
    rules: [
      { ruleId: 'deny-x', effect: 'deny', matchField: 'resourceId', matchPattern: 'x-', dependsOn: [] },
      { ruleId: 'deny-y', effect: 'deny', matchField: 'resourceId', matchPattern: 'y-', dependsOn: [] },
      { ruleId: 'allow-all', effect: 'allow', matchField: 'actor', matchPattern: 'alice', dependsOn: [] },
    ],
    checks: [
      { check: makeCheck({ actor: 'alice', resourceId: 'x-file' }), expectedAllowed: false, description: 'deny-x matches => deny' },
      { check: makeCheck({ actor: 'alice', resourceId: 'y-file' }), expectedAllowed: false, description: 'deny-y matches => deny' },
      { check: makeCheck({ actor: 'alice', resourceId: 'z-file' }), expectedAllowed: true, description: 'no DENY matches => allow' },
      { check: makeCheck({ actor: 'bob', resourceId: 'x-file' }), expectedAllowed: false, description: 'deny-x matches, no ALLOW => deny' },
    ],
  },
  {
    name: 'empty rules',
    rules: [],
    checks: [
      { check: makeCheck(), expectedAllowed: false, description: 'no rules at all => deny' },
    ],
  },
  {
    name: 'dependency where insertion order != topo order (reversed insertion)',
    rules: [
      { ruleId: 'specific', effect: 'allow', matchField: 'resourceId', matchPattern: 'secret', dependsOn: ['general'] },
      { ruleId: 'general', effect: 'deny', matchField: 'actor', matchPattern: 'alice', dependsOn: [] },
    ],
    checks: [
      { check: makeCheck({ actor: 'alice', resourceId: 'secret-1' }), expectedAllowed: false, description: 'narrow(allow) depends on general(deny); topo sorts general first => deny' },
    ],
  },
];

// Cycle scenarios (always deny)
const CYCLE_SCENARIOS: Scenario[] = [
  {
    name: 'direct cycle A<->B',
    rules: [
      { ruleId: 'a', effect: 'allow', matchField: 'actor', matchPattern: 'any', dependsOn: ['b'] },
      { ruleId: 'b', effect: 'allow', matchField: 'actor', matchPattern: 'any', dependsOn: ['a'] },
    ],
    checks: [
      { check: makeCheck({ actor: 'any' }), expectedAllowed: false, description: 'cycle => deny' },
    ],
  },
  {
    name: 'self-loop',
    rules: [
      { ruleId: 'self', effect: 'allow', matchField: 'actor', matchPattern: 'any', dependsOn: ['self'] },
    ],
    checks: [
      { check: makeCheck({ actor: 'any' }), expectedAllowed: false, description: 'self-loop => deny' },
    ],
  },
];

// ═══════════════════════════════════════════════════════════════════════════
// Mutation variants — deliberately wrong implementations
// ═══════════════════════════════════════════════════════════════════════════

/**
 * VIOLATES P1: ALLOW short-circuits, ignoring later DENY rules.
 */
function mutateAllowOverrides(
  rules: NRIRule[],
  check: PermissionCheck,
): NRIOutcome {
  const [sorted, cycleErr] = nriTopoSort(rules);
  if (cycleErr !== undefined) {
    return { allowed: false, reason: `Cycle: ${cycleErr}` };
  }
  for (const rule of sorted) {
    if (nriRuleMatches(rule, check) && rule.effect === 'allow') {
      return {
        allowed: true,
        reason: `Allowed by policy: ${rule.ruleId}`,
        matchedRule: rule.ruleId,
      };
    }
  }
  for (const rule of sorted) {
    if (nriRuleMatches(rule, check) && rule.effect === 'deny') {
      return {
        allowed: false,
        reason: `Denied by policy: ${rule.ruleId}`,
        matchedRule: rule.ruleId,
      };
    }
  }
  return { allowed: false, reason: 'No matching policy' };
}

/**
 * VIOLATES P1: last matching rule wins regardless of effect.
 */
function mutateLastMatchWins(
  rules: NRIRule[],
  check: PermissionCheck,
): NRIOutcome {
  const [sorted, cycleErr] = nriTopoSort(rules);
  if (cycleErr !== undefined) {
    return { allowed: false, reason: `Cycle: ${cycleErr}` };
  }
  let last: NRIRule | undefined;
  for (const rule of sorted) {
    if (nriRuleMatches(rule, check)) {
      last = rule;
    }
  }
  if (last !== undefined) {
    const allowed = last.effect === 'allow';
    return {
      allowed,
      reason: `${allowed ? 'Allowed' : 'Denied'} by policy: ${last.ruleId}`,
      matchedRule: last.ruleId,
    };
  }
  return { allowed: false, reason: 'No matching policy' };
}

/**
 * VIOLATES P2: evaluates in insertion order, not topological order.
 */
function mutateNoTopoSort(
  rules: NRIRule[],
  check: PermissionCheck,
): NRIOutcome {
  let candidate: NRIRule | undefined;
  for (const rule of rules) {
    if (!nriRuleMatches(rule, check)) continue;
    if (rule.effect === 'deny') {
      return {
        allowed: false,
        reason: `Denied by policy: ${rule.ruleId}`,
        matchedRule: rule.ruleId,
      };
    }
    if (candidate === undefined) candidate = rule;
  }
  if (candidate !== undefined) {
    return {
      allowed: true,
      reason: `Allowed by policy: ${candidate.ruleId}`,
      matchedRule: candidate.ruleId,
    };
  }
  return { allowed: false, reason: 'No matching policy' };
}

/**
 * VIOLATES P2: evaluates in reverse topological order.
 */
function mutateReverseSort(
  rules: NRIRule[],
  check: PermissionCheck,
): NRIOutcome {
  const [sorted, cycleErr] = nriTopoSort(rules);
  if (cycleErr !== undefined) {
    return { allowed: false, reason: `Cycle: ${cycleErr}` };
  }
  const reversed = [...sorted].reverse();
  let candidate: NRIRule | undefined;
  for (const rule of reversed) {
    if (!nriRuleMatches(rule, check)) continue;
    if (rule.effect === 'deny') {
      return {
        allowed: false,
        reason: `Denied by policy: ${rule.ruleId}`,
        matchedRule: rule.ruleId,
      };
    }
    if (candidate === undefined) candidate = rule;
  }
  if (candidate !== undefined) {
    return {
      allowed: true,
      reason: `Allowed by policy: ${candidate.ruleId}`,
      matchedRule: candidate.ruleId,
    };
  }
  return { allowed: false, reason: 'No matching policy' };
}

/**
 * VIOLATES P4: no match => ALLOW instead of DENY.
 */
function mutateDenyDefaultBecomesAllow(
  rules: NRIRule[],
  check: PermissionCheck,
): NRIOutcome {
  const [sorted, cycleErr] = nriTopoSort(rules);
  if (cycleErr !== undefined) {
    return { allowed: false, reason: `Cycle: ${cycleErr}` };
  }
  let candidate: NRIRule | undefined;
  for (const rule of sorted) {
    if (!nriRuleMatches(rule, check)) continue;
    if (rule.effect === 'deny') {
      return {
        allowed: false,
        reason: `Denied by policy: ${rule.ruleId}`,
        matchedRule: rule.ruleId,
      };
    }
    if (candidate === undefined) candidate = rule;
  }
  if (candidate !== undefined) {
    return {
      allowed: true,
      reason: `Allowed by policy: ${candidate.ruleId}`,
      matchedRule: candidate.ruleId,
    };
  }
  // BUG: no match => allow
  return { allowed: true, reason: 'No matching policy' };
}

/**
 * VIOLATES P1: picks first matching rule regardless of effect (no deny-overrides).
 */
function mutateFirstMatchWins(
  rules: NRIRule[],
  check: PermissionCheck,
): NRIOutcome {
  const [sorted, cycleErr] = nriTopoSort(rules);
  if (cycleErr !== undefined) {
    return { allowed: false, reason: `Cycle: ${cycleErr}` };
  }
  for (const rule of sorted) {
    if (nriRuleMatches(rule, check)) {
      const allowed = rule.effect === 'allow';
      return {
        allowed,
        reason: `${allowed ? 'Allowed' : 'Denied'} by policy: ${rule.ruleId}`,
        matchedRule: rule.ruleId,
      };
    }
  }
  return { allowed: false, reason: 'No matching policy' };
}

// ═══════════════════════════════════════════════════════════════════════════
// Property check functions
//
// Each check validates an invariant for a given *result* (not by re-running
// the evaluation). This lets us verify that a mutation produces a result
// that violates the invariant.
// ═══════════════════════════════════════════════════════════════════════════

function checkP1Result(
  result: NRIOutcome,
  rules: NRIRule[],
  check: PermissionCheck,
): boolean {
  const hasDeny = rules.some(
    r => r.effect === 'deny' && nriRuleMatches(r, check),
  );
  return !(hasDeny && result.allowed);
}

function checkP4Result(
  result: NRIOutcome,
  rules: NRIRule[],
  check: PermissionCheck,
): boolean {
  const anyMatch = rules.some(r => nriRuleMatches(r, check));
  return !(!anyMatch && result.allowed);
}

function checkP5CycleSafety(rules: NRIRule[]): boolean {
  const result = nriEvaluate(rules, makeCheck({ actor: 'any' }));
  if (!result.allowed) {
    return !result.reason.toLowerCase().includes('no matching');
  }
  return false; // cycle should never allow
}

// ═══════════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════════

describe('PermissionDag NRI model vs TS', () => {
  // ─── Exhaustive scenario enumeration ───────────────────────

  describe('exhaustive authorization matrix', () => {
    for (const scenario of [...SCENARIOS, ...CYCLE_SCENARIOS]) {
      describe(scenario.name, () => {
        for (const { check, expectedAllowed, description } of scenario.checks) {
          it(description, () => {
            const nriResult = nriEvaluate(scenario.rules, check);
            expect(nriResult.allowed).toBe(expectedAllowed);

            const dag = buildTSDag(scenario.rules);
            const tsResult = dag.evaluate(check);
            expect(tsResult.allowed).toBe(expectedAllowed);
          });
        }
      });
    }
  });

  // ─── NRI vs TS differential ────────────────────────────────

  describe('NRI vs TS differential agreement', () => {
    for (const scenario of [...SCENARIOS, ...CYCLE_SCENARIOS]) {
      it(`agrees on: ${scenario.name}`, () => {
        const dag = buildTSDag(scenario.rules);
        for (const { check } of scenario.checks) {
          const nriResult = nriEvaluate(scenario.rules, check);
          const tsResult = dag.evaluate(check);
          expect(tsResult.allowed).toBe(nriResult.allowed);
          if (!tsResult.allowed && !nriResult.allowed) {
            const tsCycle = tsResult.reason.includes('Cycle');
            const nriCycle = nriResult.reason.includes('Cycle');
            expect(tsCycle).toBe(nriCycle);
          }
        }
      });
    }
  });

  // ─── Property-based invariant checks ───────────────────────

  describe('NRI property invariants on TS implementation', () => {
    it('P1: DENY overrides ALLOW (TS denies when any DENY matches)', () => {
      for (const scenario of SCENARIOS) {
        const dag = buildTSDag(scenario.rules);
        for (const { check } of scenario.checks) {
          const tsResult = dag.evaluate(check);
          const tsHasDeny = scenario.rules.some(r => {
            const effect = r.effect === 'deny'
              ? PermissionEffect.DENY
              : PermissionEffect.ALLOW;
            const value: Record<string, string> = {
              actor: check.actor,
              resource: check.resource,
              action: check.action,
              resourceId: check.resourceId,
            };
            return (
              effect === PermissionEffect.DENY
              && (value[r.matchField] ?? '').includes(r.matchPattern)
            );
          });
          if (tsHasDeny) {
            expect(tsResult.allowed).toBe(false);
          }
        }
      }
    });

    it('P4: no match => deny (both NRI and TS)', () => {
      for (const scenario of SCENARIOS) {
        const dag = buildTSDag(scenario.rules);
        for (const { check } of scenario.checks) {
          const nriResult = nriEvaluate(scenario.rules, check);
          const tsResult = dag.evaluate(check);
          const anyMatch = scenario.rules.some(r => {
            const value: Record<string, string> = {
              actor: check.actor,
              resource: check.resource,
              action: check.action,
              resourceId: check.resourceId,
            };
            return (value[r.matchField] ?? '').includes(r.matchPattern);
          });
          if (!anyMatch) {
            expect(nriResult.allowed).toBe(false);
            expect(tsResult.allowed).toBe(false);
          }
        }
      }
    });

    it('P5: cycle => denied with Cycle reason', () => {
      for (const scenario of CYCLE_SCENARIOS) {
        expect(checkP5CycleSafety(scenario.rules)).toBe(true);
        const dag = buildTSDag(scenario.rules);
        for (const { check } of scenario.checks) {
          const tsResult = dag.evaluate(check);
          expect(tsResult.allowed).toBe(false);
          expect(tsResult.reason).toContain('Cycle');
        }
      }
    });
  });

  // ─── Mutation variant detection ────────────────────────────

  describe('mutation sensitivity (must detect each variant)', () => {
    // Shared check: ALLOW + DENY both match
    const p1Rules: NRIRule[] = [
      { ruleId: 'allow-all', effect: 'allow', matchField: 'actor', matchPattern: 'alice', dependsOn: [] },
      { ruleId: 'deny-secret', effect: 'deny', matchField: 'resourceId', matchPattern: 'secret', dependsOn: [] },
    ];
    const p1Check = makeCheck({ actor: 'alice', resourceId: 'secret-1' });

    // P1-violating mutations: should return ALLOW despite matching DENY
    const p1Mutations: Array<{ name: string; fn: (r: NRIRule[], c: PermissionCheck) => NRIOutcome; rules: NRIRule[]; check: PermissionCheck }> = [
      { name: 'allow_overrides', fn: mutateAllowOverrides, rules: p1Rules, check: p1Check },
      {
        name: 'last_match_wins',
        fn: mutateLastMatchWins,
        // DENY first in topo order, then ALLOW. Last_match_wins picks ALLOW (wrong).
        rules: [
          { ruleId: 'deny-first', effect: 'deny', matchField: 'actor', matchPattern: 'alice', dependsOn: [] },
          { ruleId: 'allow-second', effect: 'allow', matchField: 'resource', matchPattern: 'doc', dependsOn: ['deny-first'] },
        ],
        check: makeCheck({ actor: 'alice', resource: 'document' }),
      },
      { name: 'first_match_wins', fn: mutateFirstMatchWins, rules: p1Rules, check: p1Check },
    ];

    for (const { name, fn, rules, check } of p1Mutations) {
      it(`${name} violates P1 (deny overrides)`, () => {
        const variantResult = fn(rules, check);
        // Mutation should produce ALLOW (bug) when correct result is DENY
        expect(variantResult.allowed).toBe(true);
        // P1 check on the mutation's result should FAIL
        expect(checkP1Result(variantResult, rules, check)).toBe(false);
      });
    }

    it('no_topo_sort picks wrong candidate (ALLOW rules, insertion order != topo order)', () => {
      // Two ALLOW rules where insertion order != topo order.
      // specific(allow) depends_on general(allow).
      // Topo sort: [general, specific] => general matches first => candidate=general
      // Insertion: [specific, general] => specific matches first => candidate=specific
      // Both return ALLOW, but the matched rule differs.
      const rules: NRIRule[] = [
        { ruleId: 'specific', effect: 'allow', matchField: 'resourceId', matchPattern: 'secret', dependsOn: ['general'] },
        { ruleId: 'general', effect: 'allow', matchField: 'actor', matchPattern: 'alice', dependsOn: [] },
      ];
      const check = makeCheck({ actor: 'alice', resourceId: 'secret-1' });

      const tsDag = buildTSDag(rules);
      const tsResult = tsDag.evaluate(check);
      expect(tsResult.allowed).toBe(true);
      // TS topo sort: [general, specific]. general is first ALLOW match => candidate=general
      expect(tsResult.matchedPolicy?.id).toBe('general');

      const mutResult = mutateNoTopoSort(rules, check);
      expect(mutResult.allowed).toBe(true);
      // Insertion order: [specific, general]. specific is first ALLOW match => candidate=specific
      expect(mutResult.matchedRule).toBe('specific');
    });

    it('reverse_sort picks wrong candidate', () => {
      // Two ALLOW rules in a chain: specific depends_on general.
      // Topo: [general, specific]. First ALLOW match: general. Candidate=general.
      // Reverse: [specific, general]. First ALLOW match: specific. Candidate=specific.
      const rules: NRIRule[] = [
        { ruleId: 'specific', effect: 'allow', matchField: 'resourceId', matchPattern: 'secret', dependsOn: ['general'] },
        { ruleId: 'general', effect: 'allow', matchField: 'actor', matchPattern: 'alice', dependsOn: [] },
      ];
      const check = makeCheck({ actor: 'alice', resourceId: 'secret-1' });

      const tsDag = buildTSDag(rules);
      const tsResult = tsDag.evaluate(check);
      expect(tsResult.allowed).toBe(true);
      expect(tsResult.matchedPolicy?.id).toBe('general');

      const revResult = mutateReverseSort(rules, check);
      expect(revResult.allowed).toBe(true);
      // Reverse: [specific, general]. specific matches first => candidate=specific
      expect(revResult.matchedRule).toBe('specific');
    });

    it('deny_default_becomes_allow violates P4', () => {
      const rules: NRIRule[] = [
        { ruleId: 'admin-only', effect: 'allow', matchField: 'actor', matchPattern: 'admin', dependsOn: [] },
      ];
      const check = makeCheck({ actor: 'alice' }); // no match

      // Correct NRI should deny
      const correctResult = nriEvaluate(rules, check);
      expect(correctResult.allowed).toBe(false);

      // Mutation should wrongly allow
      const mutResult = mutateDenyDefaultBecomesAllow(rules, check);
      expect(mutResult.allowed).toBe(true);
      expect(checkP4Result(mutResult, rules, check)).toBe(false);
    });
  });

  // ─── Edge cases ────────────────────────────────────────────

  describe('edge cases', () => {
    it('DENY that does not match => not blocking', () => {
      const dag = new PermissionDag();
      dag.addPolicy({
        id: pid('deny-admin'),
        effect: PermissionEffect.DENY,
        description: 'Deny admins',
        match: (p: PermissionCheck) => p.actor === 'admin',
      });
      dag.addPolicy({
        id: pid('allow-all'),
        effect: PermissionEffect.ALLOW,
        description: 'Allow all',
        match: () => true,
      });
      const result = dag.evaluate(makeCheck({ actor: 'alice' }));
      expect(result.allowed).toBe(true);
    });

    it('DENY with no ALLOW present', () => {
      const dag = new PermissionDag();
      dag.addPolicy({
        id: pid('deny-all'),
        effect: PermissionEffect.DENY,
        description: 'Deny everything',
        match: () => true,
      });
      const result = dag.evaluate(makeCheck());
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('Denied');
    });

    it('cycle detection via TS', () => {
      const dag = new PermissionDag();
      dag.addPolicy({
        id: pid('a'),
        effect: PermissionEffect.ALLOW,
        match: () => true,
      });
      dag.addPolicy({
        id: pid('b'),
        effect: PermissionEffect.ALLOW,
        match: () => true,
      });
      dag.addDependency(pid('a'), pid('b'));
      dag.addDependency(pid('b'), pid('a'));

      const result = dag.evaluate(makeCheck({ actor: 'any' }));
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('Cycle');
    });
  });
});
