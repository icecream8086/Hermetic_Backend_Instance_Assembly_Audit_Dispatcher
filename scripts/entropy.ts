/**
 * 信息熵度量 — 第 6.4 节
 *
 * H(M) = -Σ p(m_i) · log₂(p(m_i))
 * p(m_i) = 模块 M 对第 i 个外部依赖的引用比例
 *
 * 高熵 = 依赖面杂乱（缺乏抽象接口）
 * 低熵 = 依赖集中（有明确的抽象层）
 *
 * 用法: npx tsx scripts/entropy.ts
 */
import { Project } from 'ts-morph';
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

// ─── 计算每个模块的依赖熵 ───

interface ModuleEntropy {
  path: string;
  totalImports: number;
  uniqueDeps: number;
  entropy: number;
  topDeps: string[];
}

const results: ModuleEntropy[] = [];

for (const sf of project.getSourceFiles()) {
  const filePath = relative(SRC_DIR, sf.getFilePath()).replace(/\\/g, '/');
  if (!filePath.startsWith('core/') && !filePath.startsWith('features/') && !filePath.startsWith('providers/')) continue;

  const depCount = new Map<string, number>();
  let total = 0;

  for (const imp of sf.getImportDeclarations()) {
    const target = imp.getModuleSpecifierValue();
    // Group into domain categories
    let category = 'other';
    if (target.includes('/store/')) category = 'store';
    else if (target.includes('/audit/') || target.includes('/logger/')) category = 'logging';
    else if (target.includes('/provider/') || target.includes('/providers/')) category = 'provider';
    else if (target.includes('/middleware/')) category = 'middleware';
    else if (target.includes('/auth/')) category = 'auth';
    else if (target.includes('/event-bus/') || target.includes('/scheduler/')) category = 'event';
    else if (target.includes('/region/')) category = 'region';
    else if (target.includes('/brand.ts') || target.includes('/types.ts') || target.includes('/interfaces.ts')) category = 'types';
    else if (target.includes('/permission/')) category = 'permission';

    depCount.set(category, (depCount.get(category) ?? 0) + 1);
    total++;
  }

  if (total === 0) continue;

  // Shannon entropy: H = -Σ p_i · log₂(p_i)
  let entropy = 0;
  for (const count of depCount.values()) {
    const p = count / total;
    entropy -= p * Math.log2(p);
  }

  const topDeps = [...depCount.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([k, v]) => `${k}(${v})`);

  results.push({ path: filePath, totalImports: total, uniqueDeps: depCount.size, entropy, topDeps });
}

// ─── 输出 ───

results.sort((a, b) => b.entropy - a.entropy);

console.log('🔍 依赖熵分析 (Shannon Entropy)\n');
console.log('  H > 2.5 = 高熵（依赖面杂乱，建议引入 Facade）');
console.log('  H 1.5-2.5 = 中等');
console.log('  H < 1.5 = 低熵（依赖集中，健康）\n');
console.log('─'.repeat(70));
console.log('模块'.padEnd(40), '熵值', '依赖数', '种类', 'Top 依赖');
console.log('─'.repeat(70));

for (const r of results) {
  const marker = r.entropy > 2.5 ? '⚠️' : r.entropy > 1.5 ? '○' : '  ';
  console.log(`${marker} ${r.path.slice(0, 37).padEnd(37)}`,
    r.entropy.toFixed(2).padStart(5),
    String(r.totalImports).padStart(5),
    String(r.uniqueDeps).padStart(5),
    r.topDeps.join(' ').slice(0, 25));
}

const high = results.filter(r => r.entropy > 2.5);
if (high.length > 0) {
  console.log('\n');
  console.log('─'.repeat(70));
  console.log('💡 高熵模块建议');
  console.log('─'.repeat(70));
  for (const r of high) {
    console.log(`  ${r.path}`);
    console.log(`    熵=${r.entropy.toFixed(2)}, ${r.uniqueDeps} 种依赖类别, ${r.totalImports} 个 import`);
    console.log(`    建议: 引入 Facade 或中间层收拢依赖`);
  }
}
