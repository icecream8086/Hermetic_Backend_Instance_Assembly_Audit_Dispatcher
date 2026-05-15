/** Node in an N-ary tree. */
export interface TreeNode<T> {
  value: T;
  children: TreeNode<T>[];
}

/** Node in a binary tree. */
export interface BinaryTreeNode<T> {
  value: T;
  left: BinaryTreeNode<T> | null;
  right: BinaryTreeNode<T> | null;
}

export type TreeTraversalOrder = 'preorder' | 'postorder' | 'bfs';
export type BinaryTreeTraversalOrder = 'preorder' | 'inorder' | 'postorder' | 'bfs' | 'dfs';
