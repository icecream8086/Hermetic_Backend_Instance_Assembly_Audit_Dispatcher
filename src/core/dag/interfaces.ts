/** Result of a topological sort via Kahn's algorithm. */
export type TopoSortResult<TNode> = {
  readonly success: true;
  readonly sorted: readonly TNode[];
} | {
  readonly success: false;
  readonly sorted: readonly TNode[];
  readonly error: string;
};
