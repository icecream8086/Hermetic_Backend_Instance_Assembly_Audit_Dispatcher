export interface S3Policy {
  readonly id: string;
  readonly bucketId: string;
  readonly name: string;
  readonly description?: string | undefined;
  readonly effect: 'Allow' | 'Deny';
  readonly actions: readonly string[];
  readonly pathPrefix: string;
  readonly applyToAutoKeys: boolean;
  readonly priority: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface CreateS3PolicyInput {
  readonly name: string;
  readonly description?: string | undefined;
  readonly effect: 'Allow' | 'Deny';
  readonly actions: readonly string[];
  readonly pathPrefix?: string | undefined;
  readonly applyToAutoKeys?: boolean | undefined;
  readonly priority?: number | undefined;
}

export interface UpdateS3PolicyInput {
  readonly name?: string | undefined;
  readonly description?: string | null | undefined;
  readonly effect?: 'Allow' | 'Deny' | undefined;
  readonly actions?: readonly string[] | undefined;
  readonly pathPrefix?: string | undefined;
  readonly applyToAutoKeys?: boolean | undefined;
  readonly priority?: number | undefined;
}
