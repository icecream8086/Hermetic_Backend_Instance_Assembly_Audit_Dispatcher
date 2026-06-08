/**
 * 瓶颈节点分析 — 综合扇入/扇出/圈复杂度识别架构瓶颈。
 *
 * 指标:
 *   扇入 (In)       = 被多少函数调用 — 高 = 基础模块
 *   扇出 (Out)      = 调了多少函数 — 高 = 协调者
 *   综合得分         = In × Out — 同时高 = 最可能成为瓶颈的枢纽节点
 *   介数中心性近似   = BFS Brandes 算法（有向图版本）
 *
 * 用法:
 *   npx tsx scripts/bottleneck.ts
 *   npx tsx scripts/bottleneck.ts --top 30
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

const fanIn = new Map<string, number>();
const fanOut = new Map<string, number>();
const edges = new Map<string, string[]>();
const locations = new Map<string, string>();

for (const sf of project.getSourceFiles()) {
  const rel = relative(SRC_DIR, sf.getFilePath()).replace(/\\/g, '/');
  for (const cls of sf.getClasses()) {
    for (const m of cls.getMethods()) {
      const qn = `${cls.getName()}.${m.getName()}`;
      locations.set(qn, `${rel}:${m.getStartLineNumber()}`);
      if (!fanIn.has(qn)) fanIn.set(qn, 0);
      if (!fanOut.has(qn)) fanOut.set(qn, 0);
      if (!edges.has(qn)) edges.set(qn, []);

      const calls = m.getDescendantsOfKind(SyntaxKind.CallExpression);
      const callees = new Set<string>();
      for (const c of calls) {
        const callee = c.getExpression().getText();
        if (callee === qn) continue;
        callees.add(callee);
        fanIn.set(callee, (fanIn.get(callee) ?? 0) + 1);
      }
      fanOut.set(qn, callees.size);
      edges.set(qn, [...callees]);
    }
  }
}

const allNodes = [...new Set([...fanIn.keys(), ...fanOut.keys()])];

// ─── 介数中心性 (Brandes) ───

function computeBetweenness(): Map<string, number> {
  const bc = new Map<string, number>();
  const isolatedNodes = allNodes.filter(n => !locations.has(n));
  for (const n of isolatedNodes) { bc.set(n, 0); continue; }

  const sourceNodes = allNodes.filter(n => locations.has(n));
  const targetNodes = new Set(allNodes.filter(n => edges.has(n) || fanIn.get(n)! > 1));

  for (const s of sourceNodes) {
    if (fanOut.get(s) === 0) continue;

    const stack: string[] = [];
    const pred = new Map<string, string[]>();
    const sigma = new Map<string, number>();
    const dist = new Map<string, number>();
    const delta = new Map<string, number>();

    for (const n of allNodes) {
      pred.set(n, []);
      sigma.set(n, 0);
      dist.set(n, -1);
      delta.set(n, 0);
    }
    sigma.set(s, 1);
    dist.set(s, 0);

    const queue: string[] = [s];
    while (queue.length > 0) {
      const v = queue.shift()!;
      stack.push(v);

      const neighbors = edges.get(v);
      if (!neighbors) continue;

      for (const w of neighbors) {
        if (!targetNodes.has(w)) continue;
        const wDist = dist.get(w)!;
        if (wDist < 0) {
          queue.push(w);
          dist.set(w, dist.get(v)! + 1);
        }
        if (dist.get(w) === dist.get(v)! + 1) {
          sigma.set(w, sigma.get(w)! + sigma.get(v)!);
          pred.get(w)!.push(v);
        }
      }
    }

    while (stack.length > 0) {
      const w = stack.pop()!;
      for (const v of pred.get(w)!) {
        const contrib = (sigma.get(v)! / sigma.get(w)!) * (1 + delta.get(w)!);
        delta.set(v, delta.get(v)! + contrib);
      }
      if (w !== s) {
        bc.set(w, (bc.get(w) ?? 0) + delta.get(w)!);
      }
    }
  }

  return bc;
}

// ─── 输出 ───

const topN = parseInt(process.argv.find(a => a.startsWith('--top='))?.slice(6) ?? '25', 10);

console.log('🔍 分析调用图...');
console.log(`   节点数: ${allNodes.length}`);
console.log(`   其中带位置信息（可追溯源码）: ${[...locations.keys()].length}`);
console.log('');

// 1. 扇入最高（被最多人调用 = 基础模块/热点函数）
console.log('─'.repeat(85));
console.log('📈 扇入 Top（被最多函数调用 — 高=基础热点）');
console.log('─'.repeat(85));
console.log('Fn'.padEnd(50), '扇入', '位置');
console.log('─'.repeat(85));
const byFanIn = allNodes
  .map(n => ({ name: n, fanIn: fanIn.get(n) ?? 0, loc: locations.get(n) }))
  .sort((a, b) => b.fanIn - a.fanIn)
  .slice(0, topN);
for (const r of byFanIn) {
  console.log(r.name.padEnd(48), String(r.fanIn).padStart(5), r.loc?.slice(0, 30) || '(external)');
}

// 2. 扇出最高（调用最多子函数 = 协调者/上帝函数）
console.log('\n');
console.log('─'.repeat(85));
console.log('📉 扇出 Top（调用最多子函数 — 高=上帝函数/胖控制器）');
console.log('─'.repeat(85));
console.log('Fn'.padEnd(50), '扇出', '位置');
console.log('─'.repeat(85));
const byFanOut = allNodes
  .filter(n => locations.has(n))
  .map(n => ({ name: n, fanOut: fanOut.get(n) ?? 0, loc: locations.get(n)! }))
  .sort((a, b) => b.fanOut - a.fanOut)
  .slice(0, topN);
for (const r of byFanOut) {
  console.log(r.name.padEnd(48), String(r.fanOut).padStart(5), r.loc.slice(0, 30));
}

// 2. 介数中心性
console.log('\n');
console.log('─'.repeat(85));
console.log('🔗 介数中心性（值越高=越瓶颈）');
console.log('─'.repeat(85));
console.log('Fn'.padEnd(50), '介数', '位置');
console.log('─'.repeat(85));
const bc = computeBetweenness();
const byBC = [...bc.entries()]
  .map(([name, score]) => ({ name, score, loc: locations.get(name) ?? '' }))
  .filter(r => r.loc && r.score > 0)
  .sort((a, b) => b.score - a.score)
  .slice(0, topN);
if (byBC.length > 0) {
  for (const r of byBC) {
    console.log(r.name.padEnd(48), r.score.toFixed(1).padStart(6), r.loc?.slice(0, 30));
  }
} else {
  console.log('  （无显著介数中心性节点 — 调用图深度较浅）');
}

// 3. 结论
console.log('\n');
console.log('─'.repeat(85));
console.log('💡 分析结论');
console.log('─'.repeat(85));
const highScore = byFanOut.slice(0, 5);
if (highScore.length > 0) {
  console.log('  扇出最高的内部节点（调了最多子函数 = 职责过重）:');
  for (const r of highScore) {
    console.log(`    ${r.name} (${r.loc}) — 扇出=${r.fanOut}`);
  }
  console.log('');
  console.log('  扇入高的外部函数由整个系统共享，这是正常的基础设施依赖。');
  console.log('  扇出高的内部函数才是胖控制器——应检查能否拆分子模块。');
}
