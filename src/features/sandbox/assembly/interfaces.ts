import type { Template, ResolveResult } from './types.ts';

// ─── Template repository ───

/** Key prefix for template storage in IAtomicStore. */
export const TEMPLATE_KEY_PREFIX = 'template:';

export interface ITemplateRepository {
  /** Load a single template by name. */
  get(name: string): Promise<Template | null>;

  /** Load all templates referenced by an assembly (transitive closure). */
  getAssembly(name: string): Promise<Map<string, Template>>;

  /** Persist a template. */
  save(template: Template): Promise<void>;

  /** Delete a template by name. */
  delete(name: string): Promise<void>;

  /** List all template names. */
  list(): Promise<readonly string[]>;
}

// ─── Assembly resolver (higher-order, wraps the pure function) ───

export interface IAssemblyResolver {
  /** Resolve an assembly template by name to a full CreateSandboxInput. */
  resolve(assemblyName: string): Promise<ResolveResult>;
}
