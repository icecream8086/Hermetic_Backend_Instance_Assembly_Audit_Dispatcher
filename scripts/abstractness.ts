/**
 * 抽象度-不稳定度均衡 (A/I/D) — 第 6.5 节
 *
 * 基于 depcruise --metrics 数据 + 抽象类统计。
 * A = 抽象类数 / 总类数
 * I = Ce / (Ce + Ca)  (不稳定度, 来自 depcruise)
 * D = |A + I - 1|     (距主序列距离, D=0 最理想)
 *
 * D > 0.3 = 失衡模块
 *
 * 用法:
 *   npx depcruise --output-type json src > deps/deps.json
 *   npx tsx scripts/abstractness.ts --input deps/deps.json
 */
import { Project, SyntaxKind } from 'ts-morph';
import { readdirSync, readFileSync } from 'node:fs';
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

// ─── 统计每个目录的抽象类数 ───

interface DirStats {
  totalClasses: number;
  abstractClasses: number;
  interfaces: number;
}

const dirStats = new Map<string, DirStats>();

for (const sf of project.getSourceFiles()) {
  const filePath = relative(SRC_DIR, sf.getFilePath()).replace(/\\/g, '/');
  if (!filePath.startsWith('core/') && !filePath.startsWith('features/') && !filePath.startsWith('providers/')) continue;

  const dir = filePath.split('/').slice(0, 2).join('/');
  if (!dirStats.has(dir)) dirStats.set(dir, { totalClasses: 0, abstractClasses: 0, interfaces: 0 });
  const stats = dirStats.get(dir)!;

  for (const cls of sf.getClasses()) {
    stats.totalClasses++;
    if (cls.isAbstract()) stats.abstractClasses++;
  }
  for (const intf of sf.getInterfaces()) {
    if (intf.getName()) stats.interfaces++;
  }
}

// ─── 读取 depcruise metrics (Ca/Ce) ───

interface ModuleMetrics {
  name: string;
  Ca: number;  // afferent (incoming)
  Ce: number;  // efferent (outgoing)
  I: number;   // instability = Ce/(Ca+Ce)
}

const depcruiseMetrics: ModuleMetrics[] = [];

// Try to parse depcruise --metrics output
const metricsPath = process.argv.find(a => a.startsWith('--input='))?.slice(8);
if (metricsPath) {
  try {
    const raw = JSON.parse(readFileSync(resolve(metricsPath), 'utf-8'));
    for (const m of raw.modules || []) {
      if (m.type === 'folder') continue;
      const name = m.name.replace(SRC_DIR + '/', '');
      depcruiseMetrics.push({
        name,
        Ca: m.Ca ?? 0,
        Ce: m.Ce ?? 0,
        I: m.Ca + m.Ce > 0 ? m.Ce / (m.Ca + m.Ce) : 0,
      });
    }
  } catch {}
}

// ─── 合并计算 ───

console.log('🔍 抽象度-不稳定度分析 (A/I/D 均衡)\n');
console.log('  A = 抽象率 (抽象类+接口 / 总类数)');
console.log('  I = 不稳定度 (传出耦合/总耦合)');
console.log('  D = |A+I-1| (距主序列距离, 0=完美)\n');
console.log('─'.repeat(85));
console.log('模块'.padEnd(32), 'A(抽象)', 'I(不稳)', 'D(距序)', '类数', '抽象', 'Ca', 'Ce');
console.log('─'.repeat(85));

const results: Array<{ dir: string; A: number; I: number; D: number; total: number; abstract: number; Ca: number; Ce: number }> = [];

for (const [dir, stats] of dirStats) {
  const A = stats.totalClasses > 0 ? (stats.abstractClasses + stats.interfaces) / stats.totalClasses : 0;

  // Find matching depcruise metrics by directory prefix
  let Ca = 0, Ce = 0;
  for (const m of depcruiseMetrics) {
    if (m.name.startsWith(dir)) {
      Ca = Math.max(Ca, m.Ca);
      Ce = Math.max(Ce, m.Ce);
    }
  }
  // Fallback: compute from module imports
  if (Ca === 0 && Ce === 0) {
    // rough estimate from file count in directory
    const dirFiles = files.filter(f => f.includes(dir));
    Ce = dirFiles.length;
    Ca = Math.max(1, files.filter(f => !f.includes(dir) && f.includes(dir.split('/')[0]!)).length);
  }

  const I = Ca + Ce > 0 ? Ce / (Ca + Ce) : 0.5;
  const D = Math.abs(A + I - 1);

  results.push({ dir, A, I, D, total: stats.totalClasses, abstract: stats.abstractClasses + stats.interfaces, Ca, Ce });
}

results.sort((a, b) => b.D - a.D);

for (const r of results) {
  const marker = r.D > 0.3 ? '⚠️' : '  ';
  console.log(`${marker} ${r.dir.padEnd(30)}`,
    r.A.toFixed(2).padStart(5),
    r.I.toFixed(2).padStart(5),
    r.D.toFixed(2).padStart(5),
    String(r.total).padStart(5),
    String(r.abstract).padStart(5),
    String(r.Ca).padStart(5),
    String(r.Ce).padStart(5));
}

const imbalanced = results.filter(r => r.D > 0.3);
if (imbalanced.length > 0) {
  console.log('\n');
  console.log('─'.repeat(85));
  console.log('💡 失衡模块 (D > 0.3)');
  console.log('─'.repeat(85));
  for (const r of imbalanced) {
    const issue = r.A < 0.2 && r.I > 0.7
      ? '具体且不稳定 — 易碎模块，应增加抽象层'
      : r.A > 0.5 && r.I < 0.3
        ? '抽象但稳定 — 基础库，检查是否有无用抽象'
        : '远离主序列 — 应调整抽象或依赖结构';
    console.log(`  ${r.dir}: A=${r.A.toFixed(2)}, I=${r.I.toFixed(2)}, D=${r.D.toFixed(2)}`);
    console.log(`    ${issue}`);
  }
}
