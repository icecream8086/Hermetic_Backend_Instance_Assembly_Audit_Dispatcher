import type { Facility, LogId, VersionId } from '../../brand.ts';

/**
 * Coordinates the linked-list tail pointer for audit-chain integrity.
 * Each facility maintains a singly-linked list of log entries via prevId.
 * The tail coordinator atomically advances the chain head.
 */
export interface ILogTailCoordinator {
  /**
   * Atomically advance the tail pointer.
   * Returns the new tail VersionId on success, or null if another writer advanced first.
   */
  tryAdvance(facility: Facility, newTailId: LogId, expectedVersion: VersionId): Promise<VersionId | null>;

  /** Read the current tail pointer. */
  getTail(facility: Facility): Promise<{ tailId: LogId; version: VersionId } | null>;

  /** Force-set the tail pointer (recovery only). */
  forceSetTail(facility: Facility, tailId: LogId): Promise<void>;
}
