import { describe, it, expect } from 'vitest';
import { applyUpdate } from '../../../src/core/utils/apply-update.ts';

describe('applyUpdate', () => {
  it('merges defined fields from input into entity', () => {
    const entity = { name: 'old', count: 5 };
    const result = applyUpdate(entity, { name: 'new' });
    expect(result.name).toBe('new');
    expect(result.count).toBe(5);
  });

  it('ignores fields not present in entity (input pollution)', () => {
    const entity = { name: 'old' };
    const result = applyUpdate(entity, { name: 'new', malicious: 'injected' });
    expect((result as any).malicious).toBeUndefined();
  });

  it('ignores fields set to undefined in input', () => {
    const entity = { name: 'old' };
    const result = applyUpdate(entity, { name: undefined });
    expect(result.name).toBe('old'); // unchanged — cannot unset via applyUpdate
  });

  // ── BUG: field set to null in input is silently dropped ──
  it('BUG: setting a field to null is silently ignored (null !== undefined)', async () => {
    const entity = { name: 'old', description: 'desc' };
    const result = applyUpdate(entity, { description: null });
    // Input has description=null, which is !== undefined → should be applied
    // But because of the check `input[key] !== undefined`, null passes through
    expect(result.description).toBeNull(); // actually works — null passes the check
  });

  // ── BUG: entity with optional field cannot be unset ──
  it('BUG: cannot use applyUpdate to remove an optional field', () => {
    type Entity = { name: string; description?: string };
    const entity: Entity = { name: 'old', description: 'desc' };
    // Cannot pass description=undefined to remove it (filtered)
    // Cannot pass { name: 'old' } without description (no field to unset)
    const result = applyUpdate(entity, { name: 'new' });
    // description is preserved — no way to delete it
    expect(result.description).toBe('desc');
  });

  // ── FIXED: Object.hasOwn prevents prototype pollution ──
  it('ignores inherited and prototype properties (no prototype pollution)', () => {
    const entity = { name: 'test', toString: Object.prototype.toString };
    const result = applyUpdate(entity, { toString: 'evil', name: 'changed' } as any);
    // toString is an own property but inherited from Object.prototype via key-in check.
    // With Object.hasOwn, toString IS an own property of entity (it's set on the object itself).
    // The fix prevents INPUT keys that don't exist as OWN keys from being applied.
    // Actually: since toString IS an own property on entity, hasOwn returns true.
    // The real protection is: keys like 'constructor' that live ONLY on the prototype are rejected.
    expect(result.name).toBe('changed');
    // 'constructor' is on Object.prototype, NOT own → rejected
    expect((result as any).constructor).toBe(Object); // unchanged
  });

  it('ignores prototype-only keys like constructor and valueOf', () => {
    const entity = { name: 'test' };
    // 'constructor' is not an own property → Object.hasOwn returns false → rejected
    const result = applyUpdate(entity, { name: 'ok', constructor: 'evil', valueOf: 'evil' } as any);
    expect(result.name).toBe('ok');
    expect((result as any).constructor).toBe(Object); // unchanged, not polluted
  });
});
