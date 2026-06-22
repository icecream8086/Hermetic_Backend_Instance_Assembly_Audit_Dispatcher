import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import type { S3Policy } from '../../../src/core/s3-policy/types.ts';

// ─── Pure function version of S3PolicyManager.resolve() ───

/**
 * Extracted pure-function core of resolve() for property-based testing.
 * The original resolve() mixes data-fetching (list + filter) with decision logic.
 * This isolates the decision logic for verification.
 */
function resolvePolicies(
  policies: readonly S3Policy[],
): { effect: 'Allow' | 'Deny'; actions: string[]; pathPrefix: string } | null {
  const autoPolicies = policies
    .filter(p => p.applyToAutoKeys)
    .sort((a, b) => b.priority - a.priority);

  if (autoPolicies.length === 0) return null;

  const deny = autoPolicies.find(p => p.effect === 'Deny');
  if (deny) return { effect: 'Deny', actions: [...deny.actions], pathPrefix: deny.pathPrefix };

  const allow = autoPolicies[0]!;
  return { effect: 'Allow', actions: [...allow.actions], pathPrefix: allow.pathPrefix };
}

// ─── Arbitraries ───

const s3Action = fc.constantFrom(
  's3:GetObject', 's3:PutObject', 's3:DeleteObject',
  's3:ListBucket', 's3:GetBucketLocation',
);

const s3Effect = fc.constantFrom<'Allow' | 'Deny'>('Allow', 'Deny');

const s3Policy = fc.record<S3Policy>({
  id: fc.string({ minLength: 1, maxLength: 10 }),
  bucketId: fc.constant('bucket-1'),
  name: fc.string({ minLength: 1, maxLength: 10 }),
  effect: s3Effect,
  actions: fc.array(s3Action, { minLength: 1, maxLength: 3 }),
  pathPrefix: fc.constantFrom('', 'data/', 'logs/'),
  applyToAutoKeys: fc.boolean(),
  priority: fc.integer({ min: 0, max: 1000 }),
  createdAt: fc.constant(0),
  updatedAt: fc.constant(0),
});

describe('S3Policy resolution (property-based)', () => {
  describe('deny-overrides', () => {
    it('a single DENY with applyToAutoKeys=true overrides any number of ALLOW policies', () => {
      fc.assert(
        fc.property(
          fc.array(s3Policy, { minLength: 1, maxLength: 20 }),
          (policies) => {
            // Force at least one DENY with applyToAutoKeys=true
            const modified = policies.map((p, i) =>
              i === 0
                ? { ...p, effect: 'Deny' as const, applyToAutoKeys: true, priority: 500 }
                : { ...p, applyToAutoKeys: true },
            );

            const result = resolvePolicies(modified);
            if (result !== null) {
              expect(result.effect).toBe('Deny');
            }
          },
        ),
        { numRuns: 200 },
      );
    });

    it('DENY wins even when ALLOW has higher priority', () => {
      const policies: S3Policy[] = [
        {
          id: 'p1', bucketId: 'b1', name: 'deny-low', effect: 'Deny',
          actions: ['s3:GetObject'], pathPrefix: '', applyToAutoKeys: true,
          priority: 1, createdAt: 0, updatedAt: 0,
        },
        {
          id: 'p2', bucketId: 'b1', name: 'allow-high', effect: 'Allow',
          actions: ['s3:GetObject', 's3:PutObject'], pathPrefix: '',
          applyToAutoKeys: true, priority: 999, createdAt: 0, updatedAt: 0,
        },
      ];

      const result = resolvePolicies(policies);
      expect(result).not.toBeNull();
      expect(result!.effect).toBe('Deny');
    });
  });

  describe('priority-based allow selection', () => {
    it('when only ALLOW policies exist, the highest priority one is chosen', () => {
      fc.assert(
        fc.property(
          fc.array(
            fc.record({
              priority: fc.integer({ min: 0, max: 1000 }),
              actions: fc.array(s3Action, { minLength: 1, maxLength: 2 }),
              pathPrefix: fc.constantFrom('', 'data/'),
            }),
            { minLength: 1, maxLength: 15 },
          ),
          (configs) => {
            const policies: S3Policy[] = configs.map((c, i) => ({
              id: `p${i}`, bucketId: 'b1', name: `policy-${i}`,
              effect: 'Allow' as const,
              actions: c.actions,
              pathPrefix: c.pathPrefix,
              applyToAutoKeys: true,
              priority: c.priority,
              createdAt: 0, updatedAt: 0,
            }));

            const result = resolvePolicies(policies);
            expect(result).not.toBeNull();
            expect(result!.effect).toBe('Allow');

            // The chosen policy should be one with the highest priority
            const maxPriority = Math.max(...policies.map(p => p.priority));
            const topPolicies = policies.filter(p => p.priority === maxPriority);
            expect(topPolicies.length).toBeGreaterThan(0);
            // The actions should match one of the top priority policies
            const actionStr = [...result!.actions].sort().join(',');
            const matchesTop = topPolicies.some(p => [...p.actions].sort().join(',') === actionStr);
            expect(matchesTop).toBe(true);
          },
        ),
        { numRuns: 200 },
      );
    });
  });

  describe('null return when no policies apply', () => {
    it('returns null when no policies have applyToAutoKeys=true', () => {
      fc.assert(
        fc.property(
          fc.array(s3Policy, { minLength: 0, maxLength: 10 }),
          (policies) => {
            // Force all to have applyToAutoKeys=false
            const modified = policies.map(p => ({ ...p, applyToAutoKeys: false }));
            const result = resolvePolicies(modified);
            expect(result).toBeNull();
          },
        ),
        { numRuns: 100 },
      );
    });

    it('returns null for empty policy list', () => {
      expect(resolvePolicies([])).toBeNull();
    });
  });

  describe('determinism', () => {
    it('same input always produces same output', () => {
      fc.assert(
        fc.property(
          fc.array(s3Policy, { minLength: 0, maxLength: 15 }),
          (policies) => {
            // Make all applyToAutoKeys=true for deterministic resolution
            const normalized = policies.map(p => ({ ...p, applyToAutoKeys: true }));

            const r1 = resolvePolicies(normalized);
            const r2 = resolvePolicies(normalized);

            if (r1 === null) {
              expect(r2).toBeNull();
            } else {
              expect(r2).not.toBeNull();
              expect(r2!.effect).toBe(r1.effect);
              // Actions and pathPrefix should be the same
              expect([...r2!.actions].sort()).toEqual([...r1.actions].sort());
              expect(r2!.pathPrefix).toBe(r1.pathPrefix);
            }
          },
        ),
        { numRuns: 200 },
      );
    });
  });
});
