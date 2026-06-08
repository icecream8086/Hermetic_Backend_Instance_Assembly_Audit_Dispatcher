/**
 * 最大流/最小割瓶颈分析 — 第 5 节
 *
 * 将调用图建模为流网络，找最小割 = 系统真实瓶颈。
 * 源点: HTTP handler 函数
 * 汇点: I/O 操作 (atomic.get/set, fetch, writeFile 等)
 * 边容量: 扇出数 (调用复杂度)
 *
 * 算法: Dinic (O(V²E))
 *
 * 用法:
 *   npx tsx scripts/maxflow.ts
 *   npx tsx scripts/maxflow.ts --top 10
 */
import { Project, SyntaxKind } from 'ts-morph';
import { readdirSync } from 'node:fs';
import { resolve, relative } from 'node:path';

const SRC_DIR = resolve(import.meta.dirname, '..', 'src');
const files: string[] = [];

function walk(d: string) {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    if (e.isDirectory() && e.name !== 'node_modules' && !e.name.startsWith('.'))
      walk(resolve(d, e.name));
    else if (e.name.endsWith('.ts') && !e.name.endsWith('.test.ts') && !e.name.endsWith('.spec.ts'))
      files.push(resolve(d, e.name));
  }
}
walk(SRC_DIR);

const project = new Project({ compilerOptions: { strict: true, target: 99, module: 99 } });
for (const f of files) {
  try { project.addSourceFileAtPath(f); } catch {}
}

// ─── 构建调用图 ───
// 识别入口 (handler) 和 I/O 操作

const ENTRY_PATTERNS = ['handler', 'router', 'route'];
const IO_PATTERNS = ['atomic.get', 'atomic.set', 'fetch', 'writeFile', 'readFile', 'rpcCall', 'db.', 'query', 'storage.get', 'storage.put'];

const graph = new Map<string, Map<string, number>>();
const nodeType = new Map<string, 'entry' | 'io' | 'internal'>();

function ensureNode(name: string): void {
  if (!graph.has(name)) graph.set(name, new Map());
  if (!nodeType.has(name)) {
    if (ENTRY_PATTERNS.some(p => name.toLowerCase().includes(p))) nodeType.set(name, 'entry');
    else if (IO_PATTERNS.some(p => name.includes(p))) nodeType.set(name, 'io');
    else nodeType.set(name, 'internal');
  }
}

function addEdge(from: string, to: string): void {
  ensureNode(from);
  ensureNode(to);
  const edges = graph.get(from)!;
  edges.set(to, (edges.get(to) ?? 0) + 1);
}

for (const sf of project.getSourceFiles()) {
  const rel = relative(SRC_DIR, sf.getFilePath()).replace(/\\/g, '/');
  for (const cls of sf.getClasses()) {
    for (const m of cls.getMethods()) {
      const qn = `${cls.getName()}.${m.getName()}`;
      ensureNode(qn);
      const calls = m.getDescendantsOfKind(SyntaxKind.CallExpression);
      for (const c of calls) {
        const callee = c.getExpression().getText();
        if (callee !== qn) addEdge(qn, callee);
      }
    }
  }
}

// ─── Dinic 最大流 ───

interface Edge { to: number; rev: number; cap: number; label: string; }

class Dinic {
  readonly N: number;
  readonly g: Edge[][];
  readonly nodeNames: string[];

  constructor(nodeList: string[]) {
    this.N = nodeList.length;
    this.nodeNames = nodeList;
    this.g = Array.from({ length: this.N }, () => []);
  }

  addEdge(from: string, to: string, cap: number): void {
    const u = this.nodeNames.indexOf(from);
    const v = this.nodeNames.indexOf(to);
    if (u < 0 || v < 0) return;
    this.g[u].push({ to: v, rev: this.g[v].length, cap, label: `${from}→${to}` });
    this.g[v].push({ to: u, rev: this.g[u].length - 1, cap: 0, label: '' });
  }

  bfs(s: number, t: number, level: number[]): boolean {
    level.fill(-1);
    const q: number[] = [s];
    level[s] = 0;
    while (q.length > 0) {
      const v = q.shift()!;
      for (const e of this.g[v]) {
        if (e.cap > 0 && level[e.to] < 0) {
          level[e.to] = level[v] + 1;
          q.push(e.to);
        }
      }
    }
    return level[t] >= 0;
  }

  dfs(v: number, t: number, f: number, level: number[], it: number[]): number {
    if (v === t) return f;
    for (let i = it[v]; i < this.g[v].length; i++) {
      it[v] = i;
      const e = this.g[v][i]!;
      if (e.cap > 0 && level[v] < level[e.to]) {
        const d = this.dfs(e.to, t, Math.min(f, e.cap), level, it);
        if (d > 0) {
          e.cap -= d;
          this.g[e.to][e.rev]!.cap += d;
          return d;
        }
      }
    }
    return 0;
  }

  maxFlow(s: string, t: string): { flow: number; minCut: Edge[] } {
    const si = this.nodeNames.indexOf(s);
    const ti = this.nodeNames.indexOf(t);
    if (si < 0 || ti < 0) return { flow: 0, minCut: [] };

    let flow = 0;
    const level = new Int32Array(this.N);
    const INF = 1e9;
    while (this.bfs(si, ti, level)) {
      const it = new Int32Array(this.N);
      while (true) {
        const f = this.dfs(si, ti, INF, level, it);
        if (f === 0) break;
        flow += f;
      }
    }

    // Find min cut: nodes reachable from s in residual graph
    const reachable = new Set<number>();
    const q: number[] = [si];
    reachable.add(si);
    while (q.length > 0) {
      const v = q.shift()!;
      for (const e of this.g[v]) {
        if (e.cap > 0 && !reachable.has(e.to)) {
          reachable.add(e.to);
          q.push(e.to);
        }
      }
    }

    const minCut: Edge[] = [];
    for (const v of reachable) {
      for (const e of this.g[v]) {
        if (!reachable.has(e.to) && e.label) minCut.push(e);
      }
    }

    return { flow, minCut };
  }
}

// ─── 主函数 ───

const topN = parseInt(process.argv.find(a => a.startsWith('--top='))?.slice(6) ?? '10', 10);

const allNodes = [...graph.keys()];
const entries = allNodes.filter(n => nodeType.get(n) === 'entry');
const ios = allNodes.filter(n => nodeType.get(n) === 'io');

console.log('🔍 构建流网络...');
console.log(`   节点数: ${allNodes.length}`);
console.log(`   入口(entry): ${entries.length}`);
console.log(`   I/O 操作: ${ios.length}`);

// Build super-source and super-sink
const dinic = new Dinic(['__SOURCE__', '__SINK__', ...allNodes]);

// Source → entries
for (const e of entries) {
  const fanOut = graph.get(e)?.size ?? 1;
  dinic.addEdge('__SOURCE__', e, Math.min(fanOut, 50));
}

// I/O → Sink
for (const io of ios) {
  const fanIn = [...graph.values()].filter(e => e.has(io)).length;
  dinic.addEdge(io, '__SINK__', Math.min(fanIn * 2, 100));
}

// Internal edges
for (const [from, edges] of graph) {
  for (const [to, count] of edges) {
    if (nodeType.get(to) !== 'io') {
      dinic.addEdge(from, to, Math.min(count * 2, 30));
    } else {
      dinic.addEdge(from, to, count);
    }
  }
}

const result = dinic.maxFlow('__SOURCE__', '__SINK__');
console.log(`\n📊 最大流值: ${result.flow.toFixed(1)}（越大 = 系统吞吐能力越强）\n`);

if (result.minCut.length > 0) {
  const sorted = result.minCut.sort((a, b) => b.cap - a.cap).slice(0, topN);
  console.log('─'.repeat(70));
  console.log(`✂️  最小割 Top ${topN}（容量越大 = 瓶颈越严重）`);
  console.log('─'.repeat(70));
  console.log('调用链'.padEnd(50), '容量');
  console.log('─'.repeat(70));
  for (const e of sorted) {
    console.log(e.label.padEnd(50), String(e.cap).padStart(5));
  }

  console.log('\n');
  console.log('💡 解读: 最小割 = 要切断这些边才能让系统停止工作。');
  console.log('         这些就是系统真正的瓶颈——优化它们优先于任何其他优化。');
}

// Find bottleneck edges within internal functions
console.log('\n── 内部热点边（高容量调用链） ──');
const internalEdges: { label: string; cap: number }[] = [];
for (const [from, edges] of graph) {
  if (nodeType.get(from) === 'entry') continue;
  for (const [to, count] of edges) {
    const cap = Math.min(count * 2, 30);
    if (cap >= 5) internalEdges.push({ label: `${from} → ${to}`, cap });
  }
}
internalEdges.sort((a, b) => b.cap - a.cap).slice(0, topN).forEach(e => {
  console.log(`  ${e.cap}  ${e.label}`);
});
