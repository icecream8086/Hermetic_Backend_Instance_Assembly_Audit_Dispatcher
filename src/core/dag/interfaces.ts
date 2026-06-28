/** Result of a topological sort via Kahn's algorithm. */
export type TopoSortResult<TNode> = {
  readonly success: true;
  readonly sorted: readonly TNode[];
} | {
  readonly success: false;
  readonly sorted: readonly TNode[];
  readonly error: string;
};

/** Error reported by buildDag when a node is missing or a cycle is detected. */
export interface DagBuildError<TId> {
  readonly id: TId;
  readonly message: string;
}
