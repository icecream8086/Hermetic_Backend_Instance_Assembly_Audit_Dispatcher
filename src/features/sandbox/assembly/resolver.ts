import { Dag } from '../../../core/dag/graph.ts';
import type {
  Template,
  AssemblyTemplate,
  ContainerTemplate,
  ResourceTemplate,
  ResolveResult,
  ResolveError,
} from './types.ts';
import { TemplateKind } from './types.ts';
import type { CreateSandboxInput, ContainerConfig } from '../types.ts';

/** Mutable builder used internally during merge. Frozen to CreateSandboxInput on completion. */
type MutableSandboxInput = {
  name: string;
  description?: string;
  region: string;
  resourceSpec: { cpu: number; memory: number };
  spotStrategy: CreateSandboxInput['spotStrategy'];
  restartPolicy: CreateSandboxInput['restartPolicy'];
  containers: ContainerConfig[];
  volumes?: CreateSandboxInput['volumes'];
  network: {
    subnetIds?: string[];
    securityGroupId?: string;
    allocatePublicIp: boolean;
    publicIpBandwidth?: number;
  };
  tags?: CreateSandboxInput['tags'];
  providerOverrides?: Record<string, unknown>;
};

// ─── DAG resolver ───

/**
 * Resolve an assembly template into a complete CreateSandboxInput.
 * Pure function — no side effects. All template data is passed in via `store`.
 */
export function resolveAssembly(
  rootName: string,
  store: ReadonlyMap<string, Template>,
): ResolveResult {
  const dag = new Dag<string, Template>(t => t.name);
  const errors: ResolveError[] = [];

  collectToDag(rootName, store, dag, new Set(), new Set(), errors);
  if (errors.length > 0) return { success: false, errors };

  const sorted = dag.topologicalSort();
  if (!sorted.success) {
    return {
      success: false,
      errors: [{ templateName: '(assembly)', message: sorted.error }],
    };
  }

  const merged = mergeTemplates([...sorted.sorted]);
  if (merged === null) {
    return { success: false, errors: [{ templateName: '(assembly)', message: 'Merge produced no result' }] };
  }

  // Apply assembly-level static overrides
  const root = store.get(rootName);
  if (root?.kind === TemplateKind.Assembly && (root as AssemblyTemplate).overrides) {
    Object.assign(merged, (root as AssemblyTemplate).overrides);
  }

  const validationErrors = validateConfig(merged);
  if (validationErrors.length > 0) {
    return { success: false, errors: validationErrors };
  }

  return { success: true, config: merged as CreateSandboxInput };
}

// ─── DFS collection with cycle detection ───

function collectToDag(
  name: string,
  store: ReadonlyMap<string, Template>,
  dag: Dag<string, Template>,
  visited: Set<string>,
  path: Set<string>,
  errors: ResolveError[],
): void {
  const template = store.get(name);
  if (!template) {
    errors.push({ templateName: name, message: `Template not found` });
    return;
  }

  if (path.has(name)) {
    errors.push({
      templateName: name,
      message: `Circular dependency: ${[...path, name].join(' -> ')}`,
    });
    return;
  }

  if (visited.has(name)) return;

  visited.add(name);
  dag.addNode(template);

  if (template.kind === TemplateKind.Assembly) {
    const assembly = template as AssemblyTemplate;
    path.add(name);

    for (const edge of assembly.components) {
      collectToDag(edge.target, store, dag, visited, path, errors);
    }

    // All targets are now in the DAG — safe to add edges
    for (const edge of assembly.components) {
      if (dag.hasNode(edge.target)) {
        dag.addEdge(name, edge.target);
      }
    }

    path.delete(name);
  }
}

// ─── Merge engine ───

function mergeTemplates(sorted: Template[]): MutableSandboxInput | null {
  if (sorted.length === 0) return null;

  const config: MutableSandboxInput = {
    name: '',
    region: '',
    resourceSpec: { cpu: 0, memory: 0 },
    spotStrategy: 'None' as CreateSandboxInput['spotStrategy'],
    restartPolicy: 'Never',
    containers: [],
    network: { allocatePublicIp: false },
  };

  for (const template of sorted) {
    switch (template.kind) {
      case TemplateKind.Volume:
        // Volume templates are resolved at provision time from VolumeRepository.
        // The assembly only declares which volumes are needed via component edges.
        break;

      case TemplateKind.Container: {
        const ct = template as ContainerTemplate;
        const idx = config.containers.findIndex(c => c.name === ct.spec.name);
        if (idx >= 0) {
          config.containers = [
            ...config.containers.slice(0, idx),
            { ...config.containers[idx], ...ct.spec },
            ...config.containers.slice(idx + 1),
          ];
        } else {
          config.containers = [...config.containers, ct.spec];
        }
        break;
      }

      case TemplateKind.Resource: {
        const rt = template as ResourceTemplate;
        if (!config.providerOverrides) config.providerOverrides = {};
        const prev = (config.providerOverrides[rt.resourceType] ?? {}) as Record<string, unknown>;
        config.providerOverrides[rt.resourceType] = { ...prev, ...rt.spec };
        break;
      }

      case TemplateKind.Assembly:
        // No spec to merge — assembly only wires components
        break;
    }
  }

  return config;
}

// ─── Validation ───

function validateConfig(config: MutableSandboxInput): ResolveError[] {
  const errors: ResolveError[] = [];

  if (!config.name.trim()) {
    errors.push({ templateName: '(assembly)', message: 'name is required' });
  }
  if (!config.region.trim()) {
    errors.push({ templateName: '(assembly)', message: 'region is required' });
  }
  if (config.resourceSpec.cpu <= 0) {
    errors.push({ templateName: '(assembly)', message: 'resourceSpec.cpu must be > 0' });
  }
  if (config.resourceSpec.memory <= 0) {
    errors.push({ templateName: '(assembly)', message: 'resourceSpec.memory must be > 0' });
  }
  if (config.containers.length === 0) {
    errors.push({ templateName: '(assembly)', message: 'at least one container is required' });
  }

  return errors;
}
