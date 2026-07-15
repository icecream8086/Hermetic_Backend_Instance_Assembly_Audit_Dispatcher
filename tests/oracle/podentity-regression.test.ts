/**
 * Regression: PodEntitySchema emits all 15 fields in the generated SDK.
 * Covers ISSUE-00084 — if PodEntitySchema regresses, gen:sdk output shrinks.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';

const SDK_PATH = resolve(import.meta.dirname, '../../src/generated/sdk.d.ts');
const sdk = readFileSync(SDK_PATH, 'utf-8');

function topLevelKeysAfter(block: string): number {
  // Find the first `{` after `PodEntity:` and count top-level `key: type;` entries
  // by tracking brace depth — only count `;` at depth 1 (inside PodEntity's `{}`
  // but not inside nested specs like `spec: { ... }`).
  const start = block.indexOf('{');
  if (start === -1) return 0;
  let depth = 0;
  let count = 0;
  for (let i = start; i < block.length; i++) {
    if (block[i] === '{') depth++;
    else if (block[i] === '}') depth--;
    else if (block[i] === ';' && depth === 1) count++;
    if (depth === 0) break;
  }
  return count;
}

describe('ISSUE-00084 PodEntity 15 fields', () => {
  it('sdk.d.ts PodEntity has ≥15 top-level keys', () => {
    const match = sdk.match(/\bPodEntity:\s*\{/);
    expect(match).not.toBeNull();
    const block = sdk.slice(match!.index!);
    const count = topLevelKeysAfter(block);
    expect(count).toBeGreaterThanOrEqual(15);
  });
});
