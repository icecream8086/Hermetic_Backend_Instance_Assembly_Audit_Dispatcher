/**
 * Generate per-module architecture docs from dependency graph metrics.
 *
 * Inputs (auto-refreshed by `npm run map`):
 *   - dependency-graph.json — madge full dependency graph
 *
 * Usage:
 *   npm run map && npx tsx scripts/arch-doc.ts
 *
 * Output: docs/modules/<path>.md — one per source module
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

const { parse: parseJson } = JSON;

const ROOT = process.cwd();
const SRC = join(ROOT, 'src');
const OUT = join(ROOT, 'docs', 'modules');

type DepGraph = Record<string, string[]>;

const depGraph: DepGraph = parseJson(readFileSync('dependency-graph.json', 'utf8'));

// ─── Compute fan-in / fan-out / instability per module ───

const fanIn: Record<string, string[]> = {};
for (const [mod, deps] of Object.entries(depGraph)) {
  fanIn[mod] ??= [];
  for (const dep of deps) {
    fanIn[dep] ??= [];
    fanIn[dep].push(mod);
  }
}

interface ModMetric {
  path: string;
  short: string;
  fanOut: number;
  fanIn: number;
  I: number;
  deps: string[];
  dependents: string[];
  layer: string;
}

const mods: ModMetric[] = Object.keys(depGraph)
  .map(mod => {
    const short = mod.replace(/\\/g, '/').replace(/^.*\/src\//, '');
    const fo = (depGraph[mod] || []).length;
    const fi = (fanIn[mod] || []).length;
    const deps = (depGraph[mod] || []).map(d => d.replace(/\\/g, '/').replace(/^.*\/src\//, ''));
    const dependents = (fanIn[mod] || []).map(d => d.replace(/\\/g, '/').replace(/^.*\/src\//, ''));
    const layer = classifyLayer(short);
    return { path: mod, short, fanOut: fo, fanIn: fi, I: fi + fo > 0 ? fo / (fi + fo) : 0, deps, dependents, layer };
  })
  .filter(m => !m.short.startsWith('..') && (m.short.endsWith('.ts') || m.short.endsWith('.json')));

// ─── Data-driven layer classification (no hardcoded names) ───

function classifyLayer(p: string): string {
  const parts = p.split('/');
  if (parts[0] === 'config') return 'config';
  if (parts[0] === 'queue') return 'queue';
  if (parts[0] === 'core') return parts.length >= 2 ? `core/${parts[1]}` : 'core';
  if (parts[0] === 'features') return parts.length >= 2 ? `features/${parts[1]}` : 'features';
  if (parts[0] === 'providers') return parts.length >= 2 ? `providers/${parts[1]}` : 'providers';
  return parts[0] ?? 'root';
}

// ─── Aggregate per-layer stats ───

const layerMap = new Map<string, ModMetric[]>();
for (const m of mods) {
  const list = layerMap.get(m.layer) ?? [];
  list.push(m);
  layerMap.set(m.layer, list);
}

// ─── Role classification from metrics ───

function role(m: ModMetric): string {
  if (m.fanIn >= 15 && m.I <= 0.10) return 'Foundation — highly depended-on abstraction. Changes here cascade widely.';
  if (m.fanIn >= 5 && m.I <= 0.30) return 'Stable abstraction — depended-on but focused. Change carefully.';
  if (m.fanOut >= 10 && m.fanIn <= 3) return 'Orchestrator — integrates many dependencies. High coupling risk.';
  if (m.I >= 0.80) return 'Leaf — depends on many, depended-on by few. Safe to refactor.';
  if (m.fanIn === 0 && m.fanOut === 0) return 'Island — no dependencies either direction.';
  return 'Balanced — moderate coupling in both directions.';
}

// ─── Circular dependency check ───

function findCycles(graph: DepGraph): string[][] {
  const cycles: string[][] = [];
  const visiting = new Set<string>();

  function dfs(node: string, path: string[]) {
    if (path.includes(node)) {
      const i = path.indexOf(node);
      if (i !== -1 && path.length - i <= 8) cycles.push([...path.slice(i), node]);
      return;
    }
    if (visiting.has(node)) return;
    visiting.add(node);
    for (const dep of graph[node] || []) {
      if (dep in graph) dfs(dep, [...path, node]);
    }
    visiting.delete(node);
  }
  for (const node of Object.keys(graph)) dfs(node, []);
  return cycles;
}

const cycles = findCycles(depGraph);
const inCycle = new Set<string>();
for (const c of cycles) for (const n of c) inCycle.add(n.replace(/\\/g, '/').replace(/^.*\/src\//, ''));

// ─── Generate per-module docs ───

function shortify(deps: string[]): string[] {
  return deps.map(d => d.replace(/^src\//, '')).filter(d => mods.some(m => m.short === d));
}

mkdirSync(OUT, { recursive: true });

for (const m of mods) {
  // Skip non-src entries (e.g. ../openapi.json)
  if (m.short.startsWith('..')) continue;
  const dir = join(OUT, dirname(m.short));
  mkdirSync(dir, { recursive: true });
  const fname = (m.short.split('/').pop() ?? 'index').replace(/\.ts$/, '.md').replace(/\.json$/, '.md');

  const isCyclic = inCycle.has(m.short);
  const depNames = shortify(m.deps);
  const dependentNames = shortify(m.dependents);
  const rankedAll = [...mods].sort((a, b) => b.fanIn - a.fanIn);
  const rank = rankedAll.findIndex(x => x.short === m.short) + 1;

  let md = '';
  md += `# \`${m.short}\`\n\n`;
  if (isCyclic) md += '> **Circular dependency detected.** See [cycles](#cycles) below.\n\n';

  // Metric summary
  md += '| Metric | Value |\n|--------|-------|\n';
  md += `| Fan-In | ${m.fanIn} (rank ${rank}/${mods.length}) |\n`;
  md += `| Fan-Out | ${m.fanOut} |\n`;
  md += `| Instability (I) | ${m.I.toFixed(2)} |\n`;
  md += `| Layer | \`${m.layer}\` |\n\n`;

  // Role
  md += `**Role**: ${role(m)}\n\n`;

  // Layer peers
  const peers = (layerMap.get(m.layer) ?? []).filter(x => x.short !== m.short);
  if (peers.length > 0) {
    md += `**Layer peers** (${peers.length} other modules in \`${m.layer}/\`):\n`;
    for (const p of peers.slice(0, 10)) {
      md += `- [\`${p.short}\`](${p.short.replace(/\.ts$/, '.md')}) — Fi:${p.fanIn} Fo:${p.fanOut} I:${p.I.toFixed(2)}\n`;
    }
    if (peers.length > 10) md += `- ... and ${peers.length - 10} more\n`;
    md += '\n';
  }

  // Dependencies (what this module imports)
  if (depNames.length > 0) {
    md += `## Dependencies (${depNames.length})\n\n`;
    md += '| Module | Fan-In | Layer |\n|--------|--------|-------|\n';
    for (const d of depNames) {
      const dm = mods.find(x => x.short === d);
      md += `| [\`${d}\`](${d.replace(/\.ts$/, '.md')}) | ${dm?.fanIn ?? '?'} | \`${dm?.layer ?? '?'}\` |\n`;
    }
    md += '\n';
  }

  // Dependents (what imports this module)
  if (dependentNames.length > 0) {
    md += `## Dependents (${dependentNames.length})\n\n`;
    if (dependentNames.length <= 20) {
      for (const d of dependentNames) {
        md += `- [\`${d}\`](${d.replace(/\.ts$/, '.md')})\n`;
      }
    } else {
      md += `*Too many to list (${dependentNames.length}). This is a foundation module — changes affect ${dependentNames.length} consumers.*\n`;
    }
    md += '\n';
  }

  // Cycles
  if (isCyclic) {
    md += '## Cycles\n\n';
    for (const c of cycles) {
      const shortCycle = c.map(n => n.replace(/\\/g, '/').replace(/^.*\/src\//, ''));
      if (shortCycle.includes(m.short)) {
        md += `- ${shortCycle.join(' → ')}\n`;
      }
    }
    md += '\n';
  }

  writeFileSync(join(dir, fname), md);
}

// ─── Generate index ───

let index = '# Module Architecture Index\n\n';
index += '> Auto-generated from `dependency-graph.json`. Refresh: `npm run map && npx tsx scripts/arch-doc.ts`\n\n';

index += '## Layer Overview\n\n';
index += '| Layer | Modules | Total Fan-Out | Avg I |\n|-------|---------|---------------|-------|\n';
for (const [layer, list] of [...layerMap.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
  const avgI = list.reduce((s, m) => s + m.I, 0) / list.length;
  index += `| \`${layer}\` | ${list.length} | ${list.reduce((s, m) => s + m.fanOut, 0)} | ${avgI.toFixed(2)} |\n`;
}
index += '\n';

index += '## Top 30 by Fan-In (Foundation)\n\n';
index += '| Rank | Module | Fan-In | Fan-Out | I | Layer | Role |\n|------|--------|--------|---------|---|-------|------|\n';
for (const [i, m] of mods.filter(x => x.fanIn > 0).sort((a, b) => b.fanIn - a.fanIn).slice(0, 30).entries()) {
  index += `| ${i + 1} | [\`${m.short}\`](modules/${m.short.replace(/\.ts$/, '.md')}) | ${m.fanIn} | ${m.fanOut} | ${m.I.toFixed(2)} | \`${m.layer}\` | ${role(m).split('.')[0]!} |\n`;
}
index += '\n';

index += '## Top 20 Orchestrators (High Fan-Out)\n\n';
index += '| Rank | Module | Fan-Out | Fan-In | I | Layer |\n|------|--------|---------|--------|---|-------|\n';
for (const [i, m] of mods.sort((a, b) => b.fanOut - a.fanOut).slice(0, 20).entries()) {
  index += `| ${i + 1} | [\`${m.short}\`](modules/${m.short.replace(/\.ts$/, '.md')}) | ${m.fanOut} | ${m.fanIn} | ${m.I.toFixed(2)} | \`${m.layer}\` |\n`;
}
index += '\n';

if (cycles.length > 0) {
  index += '## Circular Dependencies\n\n';
  for (const c of cycles.slice(0, 15)) {
    const shortCycle = c.map(n => n.replace(/\\/g, '/').replace(/^.*\/src\//, ''));
    index += `- ${shortCycle.join(' → ')}\n`;
  }
  index += '\n';
}

writeFileSync(join(ROOT, 'docs', 'modules', 'README.md'), index);
console.log(`Generated ${mods.length} module pages + index`);
