import type { IAtomicStore } from '../../core/store/interfaces.ts';
import type { VersionId } from '../../core/brand.ts';
import { generateVersionId } from '../../core/brand.ts';

const PFX = 'action-def:';
const IDX = 'action-def:ids';

export interface ActionDef {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly description?: string;
  /** Input parameters the action accepts. */
  readonly inputs?: Record<string, {
    readonly description?: string;
    readonly required?: boolean;
    readonly default?: string;
  }>;
  /** Outputs the action produces. */
  readonly outputs?: Record<string, { readonly description?: string }>;
  /** How the action runs: 'container' for Docker image, 'node' for JS. */
  readonly runs: {
    readonly using: 'container' | 'node';
    readonly main?: string;   // JS entrypoint file
    readonly image?: string;  // Container image reference
  };
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly versionId: VersionId;
}

export interface CreateActionInput {
  readonly name: string;
  readonly version: string;
  readonly description?: string;
  readonly inputs?: Record<string, { description?: string; required?: boolean; default?: string }>;
  readonly outputs?: Record<string, { description?: string }>;
  readonly runs: { using: 'container' | 'node'; main?: string; image?: string };
}

/**
 * Resolve a `uses:` reference like "docker/build-push@v1" or "my-action@1.0.0"
 * to a concrete ActionDef (image reference or JS entrypoint).
 *
 * Lookup strategy:
 *   1. Exact match: name@version in action-def registry
 *   2. Container fallback: if name contains '/', treat as image reference directly
 */
export class ActionRegistry {
  constructor(private readonly atomic: IAtomicStore) {}

  async register(input: CreateActionInput): Promise<ActionDef> {
    const id = `act_${crypto.randomUUID()}`;
    const def: ActionDef = {
      id,
      name: input.name,
      version: input.version,
      ...(input.description ? { description: input.description } : {}),
      ...(input.inputs ? { inputs: input.inputs } : {}),
      ...(input.outputs ? { outputs: input.outputs } : {}),
      runs: input.runs,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      versionId: generateVersionId(),
    };

    await this.atomic.set(PFX + id, def, null);
    const idx = await this.atomic.get<string[]>(IDX);
    await this.atomic.set(IDX, [...(idx?.value ?? []), id], idx?.version ?? null);
    return def;
  }

  async get(id: string): Promise<ActionDef | null> {
    const entry = await this.atomic.get<ActionDef>(PFX + id);
    return entry?.value ?? null;
  }

  async list(): Promise<ActionDef[]> {
    const idx = await this.atomic.get<string[]>(IDX);
    if (!idx) return [];
    const entries = await Promise.all(
      idx.value.map(i => this.atomic.get<ActionDef>(PFX + i)),
    );
    return entries.filter(e => e).map(e => e!.value);
  }

  /**
   * Resolve a `uses:` string to a concrete run configuration.
   *
   * @returns { image, entrypoint } for container actions, or null if not found.
   */
  async resolve(uses: string): Promise<{
    image: string;
    entrypoint?: string[];
    env?: Record<string, string>;
  } | null> {
    // Try exact match: name@version
    const idx = await this.atomic.get<string[]>(IDX);
    if (idx) {
      for (const id of idx.value) {
        const entry = await this.atomic.get<ActionDef>(PFX + id);
        if (!entry) continue;
        const fullRef = `${entry.value.name}@${entry.value.version}`;
        if (fullRef === uses) {
          if (entry.value.runs.using === 'container' && entry.value.runs.image) {
            const ep = entry.value.runs.main ? { entrypoint: [entry.value.runs.main] } : {};
            return { image: entry.value.runs.image, ...ep };
          }
          // node actions not supported in P1
          return null;
        }
      }
    }

    // Container image fallback: docker.io/library/node:20, etc.
    if (uses.includes('/') || uses.includes(':')) {
      const [image, tag] = uses.includes(':') ? uses.split(':') : [uses, 'latest'];
      return { image: `${image}:${tag}` };
    }

    return null;
  }
}
