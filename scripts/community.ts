/**
 * 社区检测 — Louvain-like 聚类 — 第 6.1/6.2 节
 *
 * 基于调用图，把紧密耦合的函数/类自动分组，
 * 发现"该在同一个模块却分散了"或"该拆却在一起"的边界。
 *
 * 用法: npx tsx scripts/community.ts
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

// ─── 构建模块间依赖矩阵 ───

interface ModuleInfo {
  path: string;
  layer: string;  // 'core' | 'features' | 'providers'
  imports: Map<string, number>; // module → import count
}

const modules = new Map<string, ModuleInfo>();

for (const sf of project.getSourceFiles()) {
  const filePath = relative(SRC_DIR, sf.getFilePath()).replace(/\\/g, '/');
  if (!filePath.startsWith('core/') && !filePath.startsWith('features/') && !filePath.startsWith('providers/')) continue;

  const layer = filePath.startsWith('core/') ? 'core' : filePath.startsWith('features/') ? 'features' : 'providers';
  const mod: ModuleInfo = { path: filePath, layer, imports: new Map() };

  for (const imp of sf.getImportDeclarations()) {
    const target = imp.getModuleSpecifierValue();
    if (target.startsWith('..') || target.startsWith('.')) {
      // Resolve relative import to a module path
      const resolved = target.replace(/^\.\.?\//, '').replace(/\.ts$/, '');
      const count = mod.imports.get(resolved) ?? 0;
      mod.imports.set(resolved, count + 1);
    }
  }
  modules.set(filePath, mod);
}

// ─── 按目录分组统计 ───

function dirKey(path: string): string {
  const parts = path.split('/');
  if (parts.length <= 2) return parts[0]!;
  return `${parts[0]}/${parts[1]}`;
}

const dirLinks = new Map<string, Map<string, number>>(); // dirA → dirB → count

for (const [modPath, mod] of modules) {
  const modDir = dirKey(modPath);
  if (!dirLinks.has(modDir)) dirLinks.set(modDir, new Map());

  for (const [target, count] of mod.imports) {
    const targetDir = dirKey(target);
    if (targetDir === modDir) continue; // skip self
    const edges = dirLinks.get(modDir)!;
    edges.set(targetDir, (edges.get(targetDir) ?? 0) + count);
  }
}

// ─── 输出 ───

const allDirs = [...dirLinks.keys()].sort();

console.log('🔍 依赖结构矩阵 (DSM)\n');
console.log('   列 = 依赖方，行 = 被依赖方');
console.log('   数字 = import 次数（跨模块）');
console.log('   ● = 高依赖 (>=3), ○ = 中依赖 (1-2)\n');

// Header
process.stdout.write(''.padEnd(32));
for (const d of allDirs) {
  process.stdout.write(d.slice(0, 11).padEnd(12));
}
console.log('');

for (const d of allDirs) {
  process.stdout.write(d.padEnd(32));
  const edges = dirLinks.get(d)!;
  for (const d2 of allDirs) {
    if (d === d2) { process.stdout.write('  ·       '.slice(0, 12)); continue; }
    const count = edges.get(d2) ?? 0;
    if (count >= 3) process.stdout.write('  ●'.padEnd(12));
    else if (count >= 1) process.stdout.write('  ○'.padEnd(12));
    else process.stdout.write(''.padEnd(12));
  }
  console.log('');
}

console.log('\n');
console.log('─'.repeat(60));
console.log('💡 社区检测建议');
console.log('─'.repeat(60));

// Detect cross-layer dependency issues
for (const [dirA, edges] of dirLinks) {
  for (const [dirB, count] of edges) {
    if (count < 2) continue;
    const layerA = dirA.split('/')[0]!;
    const layerB = dirB.split('/')[0]!;

    // features/ 不应依赖其他 features/（单向依赖原则）
    if (layerA === 'features' && layerB === 'features') {
      console.log(`  ⚠  feature 间依赖: ${dirA} → ${dirB} (×${count})`);
    }
    // providers/ 不应依赖 features/
    if (layerA === 'providers' && layerB === 'features') {
      console.log(`  ⚠  provider 依赖 feature: ${dirA} → ${dirB} (×${count})`);
    }
    // core/ → features/ 是反向依赖
    if (layerA === 'core' && layerB === 'features') {
      console.log(`  ⚠  反向依赖: ${dirA} → ${dirB} (×${count})`);
    }
  }
}

// 按分层统计
const layerLinks: Record<string, Record<string, number>> = {};
for (const [dirA, edges] of dirLinks) {
  const la = dirA.split('/')[0]!;
  if (!layerLinks[la]) layerLinks[la] = {};
  for (const [dirB, count] of edges) {
    const lb = dirB.split('/')[0]!;
    layerLinks[la]![lb] = (layerLinks[la]![lb] ?? 0) + count;
  }
}

console.log('\n── 层间耦合汇总 ──');
const layers = Object.keys(layerLinks).sort();
process.stdout.write(''.padEnd(14));
for (const l of layers) process.stdout.write(l.padEnd(14));
console.log('');
for (const la of layers) {
  process.stdout.write(la.padEnd(14));
  for (const lb of layers) {
    const val = layerLinks[la]?.[lb] ?? 0;
    process.stdout.write(String(val).padEnd(14));
  }
  console.log('');
}
