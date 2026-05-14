// ─── Base type hierarchy for the sandbox domain ───
// Every domain type extends one of these bases.
// This enforces consistent identity, metadata, and lifecycle patterns.

// ═══════════════════════════════════════════════════
// Layer 0: Key-value tag
// ═══════════════════════════════════════════════════

export interface Tag {
  readonly key: string;
  readonly value: string;
}

// ═══════════════════════════════════════════════════
// Layer 1: Identity
// ═══════════════════════════════════════════════════

/** Anything that can be uniquely identified. */
export interface Identifiable<TId> {
  readonly id: TId;
}

// ═══════════════════════════════════════════════════
// Layer 1: Metadata
// ═══════════════════════════════════════════════════

/** Common metadata carried by every domain object. */
export interface HasMetadata {
  readonly name: string;
  readonly description?: string;
  readonly tags: readonly Tag[];
  readonly createdAt: number;
  readonly updatedAt: number;
}

// ═══════════════════════════════════════════════════
// Layer 2: Lifecycle
// ═══════════════════════════════════════════════════

/** Anything with a finite status machine. S = status enum. */
export interface HasLifecycle<S extends string> {
  readonly status: S;
}

/** A state transition event, recorded for audit. */
export interface TransitionEvent<S extends string> {
  readonly from: S;
  readonly to: S;
  readonly timestamp: number;
  readonly reason: string;
}

// ═══════════════════════════════════════════════════
// Layer 3: Versioned (for optimistic concurrency)
// ═══════════════════════════════════════════════════

export interface HasVersion {
  readonly version: string;
}

// ═══════════════════════════════════════════════════
// Composite base types
// ═══════════════════════════════════════════════════

/** A domain entity: identity + metadata + lifecycle. */
export interface BaseEntity<TId, S extends string>
  extends Identifiable<TId>, HasMetadata, HasLifecycle<S> {}

/** A persisted entity adds optimistic-concurrency version. */
export interface PersistedEntity<TId, S extends string>
  extends BaseEntity<TId, S>, HasVersion {}

// ═══════════════════════════════════════════════════
// Blueprint / Template base (immutable config)
// ═══════════════════════════════════════════════════

/** A template is a named, immutable configuration fragment. It has no lifecycle.
 *  Templates are stored in KV as `template:{name}` — `name` IS the identity.
 *  `kind` discriminates the union (volume / container / resource / assembly). */
export interface BaseTemplate<K extends string = string> {
  readonly name: string;
  readonly description?: string;
  /** Kind discriminator. Concrete templates narrow this to a literal enum value. */
  readonly kind: K;
  /** Semantic version of this template. */
  readonly version: string;
}

// ═══════════════════════════════════════════════════
// Value object base (no identity, compared by value)
// ═══════════════════════════════════════════════════

/** A value object: equality is structural, not by ID. */
export interface ValueObject {
  readonly _brand: 'ValueObject';
}

// ═══════════════════════════════════════════════════
// DAG edge (for assembly templates)
// ═══════════════════════════════════════════════════

export enum MergeStrategy {
  Override = 'override',
  Append = 'append',
  Merge = 'merge',
}

/** A directed edge from one template to another in the assembly DAG. */
export interface DagEdge {
  /** Name of the dependency template. */
  readonly target: string;
  readonly mergeStrategy: MergeStrategy;
}
