import { describe, it, expect } from 'vitest';
import {
  MergeStrategy,
} from '../../src/features/sandbox/base.ts';
import type {
  Identifiable,
  HasMetadata,
  HasLifecycle,
  HasVersion,
  BaseEntity,
  PersistedEntity,
  BaseTemplate,
  ValueObject,
  DagEdge,
  Tag,
  TransitionEvent,
} from '../../src/features/sandbox/base.ts';

describe('base type hierarchy', () => {
  describe('Tag', () => {
    it('accepts valid key-value pair', () => {
      const tag: Tag = { key: 'env', value: 'prod' };
      expect(tag.key).toBe('env');
      expect(tag.value).toBe('prod');
    });
  });

  describe('Identifiable<TId>', () => {
    it('structural typing allows branded string IDs', () => {
      type MyId = string & { readonly _brand: unique symbol };
      const entity: Identifiable<MyId> = { id: 'abc' as MyId };
      expect(entity.id).toBe('abc');
    });
  });

  describe('HasMetadata', () => {
    it('requires name and timestamps', () => {
      const meta: HasMetadata = {
        name: 'test',
        tags: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      expect(meta.name).toBe('test');
    });

    it('description is optional', () => {
      const meta: HasMetadata = {
        name: 'x',
        tags: [],
        createdAt: 0,
        updatedAt: 0,
      };
      expect(meta.description).toBeUndefined();
    });
  });

  describe('HasLifecycle<S>', () => {
    it('carries a status of the given enum type', () => {
      enum MyStatus { A = 'a', B = 'b' }
      const obj: HasLifecycle<MyStatus> = { status: MyStatus.A };
      expect(obj.status).toBe('a');
    });
  });

  describe('HasVersion', () => {
    it('carries an opaque version string', () => {
      const v: HasVersion = { version: 'v1' };
      expect(v.version).toBe('v1');
    });
  });

  describe('PersistedEntity<TId, S>', () => {
    it('composes Identifiable + HasMetadata + HasLifecycle + HasVersion', () => {
      type Id = string & { readonly _b: unique symbol };
      enum S { Active = 'Active' }
      const e: PersistedEntity<Id, S> = {
        id: 'x' as Id,
        name: 'e1',
        tags: [{ key: 'a', value: 'b' }],
        createdAt: 1,
        updatedAt: 2,
        status: S.Active,
        version: 'uuid-1',
      };
      expect(e.id).toBe('x');
      expect(e.name).toBe('e1');
      expect(e.status).toBe(S.Active);
      expect(e.version).toBe('uuid-1');
    });
  });

  describe('BaseTemplate<K>', () => {
    it('carries name, kind discriminator, and version', () => {
      type K = 'volume' | 'container';
      const t: BaseTemplate<K> = {
        name: 'my-template',
        kind: 'volume',
        version: '2.0.0',
      };
      expect(t.name).toBe('my-template');
      expect(t.kind).toBe('volume');
      expect(t.version).toBe('2.0.0');
    });
  });

  describe('ValueObject', () => {
    it('has the _brand discriminator', () => {
      const vo: ValueObject = { _brand: 'ValueObject' };
      expect(vo._brand).toBe('ValueObject');
    });
  });

  describe('DagEdge', () => {
    it('carries target name and merge strategy', () => {
      const edge: DagEdge = { target: 'nginx', mergeStrategy: MergeStrategy.Merge };
      expect(edge.target).toBe('nginx');
      expect(edge.mergeStrategy).toBe('merge');
    });
  });

  describe('MergeStrategy', () => {
    it('has three values', () => {
      expect(Object.values(MergeStrategy)).toEqual(['override', 'append', 'merge']);
    });
  });

  describe('TransitionEvent<S>', () => {
    it('captures a state transition for audit', () => {
      const te: TransitionEvent<'A' | 'B'> = {
        from: 'A',
        to: 'B',
        timestamp: 1712345678000,
        reason: 'user requested stop',
      };
      expect(te.from).toBe('A');
      expect(te.to).toBe('B');
    });
  });
});
