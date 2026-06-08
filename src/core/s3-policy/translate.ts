import type { S3Policy } from './types.ts';

interface MergedPolicy {
  effect: 'Allow' | 'Deny';
  actions: string[];
  pathPrefix: string;
}

/**
 * Build the resource ARN from bucket name + path prefix.
 * MinIO IAM uses AWS-style ARN:  arn:aws:s3:::bucket/key-prefix*
 */
function resourceArn(bucket: string, pathPrefix: string): string {
  const base = `arn:aws:s3:::${bucket}`;
  if (!pathPrefix) return `${base}/*`;
  const prefix = pathPrefix.endsWith('*') ? pathPrefix : `${pathPrefix}*`;
  return `${base}/${prefix}`;
}

/**
 * Merge an ordered list of policies into a single MinIO-compatible IAM policy.
 * Policies are assumed to be pre-sorted by priority (desc), with Deny overriding.
 */
function mergePolicies(policies: MergedPolicy[], bucket: string): { Effect: string; Action: string[]; Resource: string[] }[] {
  const statements: { Effect: string; Action: string[]; Resource: string[] }[] = [];

  for (const p of policies) {
    const statement = statements.find(s => s.Effect === p.effect);
    if (statement) {
      for (const a of p.actions) {
        if (!statement.Action.includes(a)) statement.Action.push(a);
      }
      statement.Resource.push(resourceArn(bucket, p.pathPrefix));
    } else {
      statements.push({
        Effect: p.effect,
        Action: [...p.actions],
        Resource: [resourceArn(bucket, p.pathPrefix)],
      });
    }
  }

  return statements;
}

/**
 * Convert S3Policy list to a MinIO-compatible IAM policy JSON string.
 */
export function toMinioPolicy(policies: readonly S3Policy[], bucket: string): string {
  const merged = groupByEffect(policies);
  const statements = mergePolicies(merged, bucket);
  return JSON.stringify({ Version: '2012-10-17', Statement: statements });
}

/**
 * Convert S3Policy list to an Alibaba OSS RAM policy JSON string.
 * OSS uses a different ARN format:  acs:oss:{region}:{account-id}:{bucket}/{key-prefix}
 * For simplicity the region and account-id are placeholders.
 */
export function toOssPolicy(policies: readonly S3Policy[], bucket: string): string {
  const merged = groupByEffect(policies);
  const statements: { Effect: string; Action: string[]; Resource: string[] }[] = [];

  for (const p of merged) {
    const resource = !p.pathPrefix
      ? `acs:oss:*:*:${bucket}/*`
      : `acs:oss:*:*:${bucket}/${p.pathPrefix}*`;
    statements.push({
      Effect: p.effect,
      Action: [...p.actions],
      Resource: [resource],
    });
  }

  return JSON.stringify({ Version: '1', Statement: statements });
}

function groupByEffect(policies: readonly S3Policy[]): MergedPolicy[] {
  // Sort by priority descending, Deny first
  const sorted = [...policies].sort((a, b) => {
    if (a.effect !== b.effect) return a.effect === 'Deny' ? -1 : 1;
    return b.priority - a.priority;
  });
  return sorted.map(p => ({ effect: p.effect, actions: [...p.actions], pathPrefix: p.pathPrefix }));
}
