import type { JobDef } from './types.ts';

/**
 * Matrix strategy configuration.
 *
 * @example
 * ```yaml
 * strategy:
 *   matrix:
 *     os: [ubuntu, alpine]
 *     node: [18, 20]
 *   exclude:
 *     - { os: alpine, node: 20 }
 *   maxParallel: 4
 * ```
 *
 * Extensibility: additional combinators (include, failFast, etc.)
 * can be added to the StrategyConfig union.
 */
export interface MatrixConfig {
  /** Variable → values mapping. Each combination produces one Job variant. */
  readonly matrix: Record<string, readonly (string | number | boolean)[]>;
  /** Combinations to exclude (exact match on subset of variables). */
  readonly exclude?: readonly Record<string, string | number | boolean>[];
  /** Maximum concurrent instances of expanded jobs. 0 = unlimited. */
  readonly maxParallel?: number;
  /** If true, cancel all remaining jobs when one fails. */
  readonly failFast?: boolean;
}

/** A single expanded job variant with its variable bindings. */
export interface JobVariant {
  /** Unique name for this variant, e.g. "test (os=ubuntu, node=18)". */
  readonly name: string;
  /** Variable bindings for use in ${{ matrix.os }} resolution. */
  readonly matrixVars: Record<string, string | number | boolean>;
  /** The job template (shared reference, not cloned). */
  readonly jobDef: JobDef;
}

/**
 * Expand a matrix strategy into individual job variants.
 *
 * Pure function — no side effects, no I/O.  Input: strategy config + job
 * template.  Output: list of JobVariant with variable bindings.
 *
 * Extensibility: the MatrixExpander class can be extended with additional
 * combinator strategies (e.g. weighted matrix, conditional include).
 */
export class MatrixExpander {
  /**
   * Expand a matrix configuration into individual job variants.
   * Returns an empty array if no matrix strategy is configured.
   */
  public expand(jobName: string, jobDef: JobDef): JobVariant[] {
    const matrix = (jobDef as any).strategy?.matrix as MatrixConfig['matrix'] | undefined;
    if (!matrix) return [{ name: jobName, matrixVars: {}, jobDef }];

    const exclude = (jobDef as any).strategy?.exclude as MatrixConfig['exclude'] | undefined;
    const failFast = (jobDef as any).strategy?.failFast as boolean | undefined;
    const maxParallel = (jobDef as any).strategy?.maxParallel as number | undefined;

    const variables = Object.entries(matrix);
    if (variables.length === 0) return [{ name: jobName, matrixVars: {}, jobDef }];

    // Cartesian product of all variable values
    const combinations = this.#cartesian(variables);

    // Apply excludes
    const filtered = exclude
      ? combinations.filter(combo =>
          !exclude.some(ex => this.#matchesExclude(combo, ex)),
        )
      : combinations;

    return filtered.map((vars, _i) => {
      const labelParts = Object.entries(vars).map(([k, v]) => `${k}=${v}`);
      return {
        name: `${jobName} (${labelParts.join(', ')})`,
        matrixVars: vars,
        jobDef: {
          ...jobDef,
          // Remove strategy from expanded job to prevent infinite recursion
          strategy: undefined as any,
          // Inject matrix variables into env
          env: {
            ...jobDef.env,
            ...Object.fromEntries(
              Object.entries(vars).map(([k, v]) => [`MATRIX_${k.toUpperCase()}`, String(v)]),
            ),
          },
          // Inject maxParallel / failFast metadata
          ...(maxParallel !== undefined ? { maxParallel } : {}),
          ...(failFast !== undefined ? { failFast } : {}),
        },
      };
    });
  }

  // ─── Helpers ───

  #cartesian(
    variables: [string, readonly (string | number | boolean)[]][],
  ): Record<string, string | number | boolean>[] {
    if (variables.length === 0) return [{}];

    const [head, ...tail] = variables;
    const [key, values] = head!;
    const rest = this.#cartesian(tail);

    const result: Record<string, string | number | boolean>[] = [];
    for (const value of values) {
      for (const r of rest) {
        result.push({ [key]: value, ...r });
      }
    }
    return result;
  }

  #matchesExclude(
    vars: Record<string, string | number | boolean>,
    exclude: Record<string, string | number | boolean>,
  ): boolean {
    return Object.entries(exclude).every(([k, v]) => vars[k] === v);
  }
}
