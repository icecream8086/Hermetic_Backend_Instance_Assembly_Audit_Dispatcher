import { readFileSync, writeFileSync } from 'node:fs';

const graph = JSON.parse(readFileSync('dependency-graph.json', 'utf8')) as Record<string, string[]>;

// Compute fan-in per module
const fanIn: Record<string, string[]> = {};
for (const [mod, deps] of Object.entries(graph)) {
  fanIn[mod] ??= [];
  for (const dep of deps) {
    fanIn[dep] ??= [];
    fanIn[dep].push(mod);
  }
}

interface Metric {
  mod: string;
  fanOut: number;
  fanIn: number;
  I: number;
  deps: string[];
  dependents: string[];
}

const metrics: Metric[] = Object.keys(graph).map(mod => {
  const fo = graph[mod].length;
  const fi = (fanIn[mod] || []).length;
  return {
    mod,
    fanOut: fo,
    fanIn: fi,
    I: fi + fo > 0 ? fo / (fi + fo) : 0,
    deps: graph[mod],
    dependents: fanIn[mod] || [],
  };
});

// Rankings
const byFanIn = metrics.filter(m => m.fanIn > 0).sort((a, b) => b.fanIn - a.fanIn);
const byFanOut = metrics.filter(m => m.fanOut > 0).sort((a, b) => b.fanOut - a.fanOut);
const stable = metrics.filter(m => m.fanIn > 0 && m.I < 0.3).sort((a, b) => a.I - b.I);
const unstable = metrics.filter(m => m.I > 0.7 && m.fanOut > 0).sort((a, b) => b.I - a.I);

const HR = '='.repeat(110);
const lines: string[] = [];

lines.push('Module Dependency Metrics — madge (src/)');
lines.push('Generated: ' + new Date().toISOString());
lines.push('Total modules: ' + metrics.length);
lines.push('Total edges: ' + metrics.reduce((s, m) => s + m.fanOut, 0));
lines.push('Circular: core/provider/types.ts → core/provider/container-lifecycle.ts → features/sandbox/types.ts');
lines.push('');

// Fan-in Top 30
lines.push(HR);
lines.push('FAN-IN TOP 30 — Most depended-upon modules (foundation)');
lines.push(HR);
lines.push('FanIn  FanOut  I     Module');
lines.push(HR);
for (const m of byFanIn.slice(0, 30)) {
  lines.push(`${String(m.fanIn).padStart(5)}  ${String(m.fanOut).padStart(5)}  ${m.I.toFixed(2).padStart(4)}  ${m.mod}`);
}

// Fan-out Top 30
lines.push('');
lines.push(HR);
lines.push('FAN-OUT TOP 30 — Modules with most dependencies (complex hubs)');
lines.push(HR);
lines.push('FanIn  FanOut  I     Module');
lines.push(HR);
for (const m of byFanOut.slice(0, 30)) {
  lines.push(`${String(m.fanIn).padStart(5)}  ${String(m.fanOut).padStart(5)}  ${m.I.toFixed(2).padStart(4)}  ${m.mod}`);
}

// Stable
lines.push('');
lines.push(HR);
lines.push('STABLE MODULES (I < 0.3) — Hard to change, many dependents');
lines.push(HR);
for (const m of stable.slice(0, 20)) {
  lines.push(`I=${m.I.toFixed(2)}  Fi=${String(m.fanIn).padStart(3)}  Fo=${String(m.fanOut).padStart(3)}  ${m.mod}`);
  const depList = m.dependents.slice(0, 8).join(', ');
  const suffix = m.dependents.length > 8 ? ` ...+${m.dependents.length - 8}` : '';
  lines.push(`         dependents: ${depList}${suffix}`);
}

// Unstable
lines.push('');
lines.push(HR);
lines.push('UNSTABLE MODULES (I > 0.7) — Safe to change, few dependents');
lines.push(HR);
for (const m of unstable.slice(0, 15)) {
  lines.push(`I=${m.I.toFixed(2)}  Fi=${String(m.fanIn).padStart(2)}  Fo=${String(m.fanOut).padStart(3)}  ${m.mod}`);
}

// Layered aggregation
lines.push('');
lines.push(HR);
lines.push('LAYERED VIEW — src/* top-level aggregation');
lines.push(HR);

const layers: Record<string, { fanIn: number; fanOut: number; count: number }> = {};
for (const m of metrics) {
  const layer = m.mod.split('/')[0];
  layers[layer] ??= { fanIn: 0, fanOut: 0, count: 0 };
  layers[layer].fanIn += m.fanIn;
  layers[layer].fanOut += m.fanOut;
  layers[layer].count++;
}
const sortedLayers = Object.entries(layers).sort((a, b) => b[1].fanIn - a[1].fanIn);
for (const [name, l] of sortedLayers) {
  const i = l.fanIn + l.fanOut > 0 ? (l.fanOut / (l.fanIn + l.fanOut)).toFixed(2) : '0.00';
  lines.push(`I=${i}  Fi=${String(l.fanIn).padStart(3)}  Fo=${String(l.fanOut).padStart(3)}  ${String(l.count).padStart(3)} mods  ${name}/`);
}

writeFileSync('module-metrics.txt', lines.join('\n') + '\n');
console.log('Written module-metrics.txt (' + lines.length + ' lines)');
