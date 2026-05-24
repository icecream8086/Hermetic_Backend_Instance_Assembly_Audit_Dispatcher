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

// ─── Infra container manager ───

export interface IInfraManager {
  /** Create an infra (pause) container for shared namespaces and return its provider ID. */
  createInfra(podName: string, infraImage?: string): Promise<string>;

  /** Remove an infra container by provider ID. */
  removeInfra(infraId: string): Promise<void>;

  /** Check whether the infra container is still alive. */
  isInfraAlive(infraId: string): Promise<boolean>;
}
