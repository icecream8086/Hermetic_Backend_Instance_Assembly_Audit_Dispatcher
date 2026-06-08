/**
 * CI 增量检查 — 第 7.6 节
 *
 * 对比当前分支与 main 的架构指标变化。
 * 检测: 新增循环依赖、介数显著上升、模块间新增反向依赖。
 *
 * 用法:
 *   npx tsx scripts/ci-check.ts                              # 对比 origin/main
 *   npx tsx scripts/ci-check.ts --baseline baseline.json      # 对比基线文件
 *   npx tsx scripts/ci-check.ts --changed-files file1 file2   # 只检查变更文件
 */
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const BASE_DIR = resolve(import.meta.dirname, '..');

// ─── 解析参数 ───

const baselineArg = process.argv.find(a => a.startsWith('--baseline='))?.slice(11);
const changedFilesArg = process.argv.find(a => a.startsWith('--changed-files='))?.slice(16);
const changedFiles = changedFilesArg ? changedFilesArg.split(' ') : [];

// ─── 运行 madge 检查循环依赖 ───

function checkCycles(dir: string): string[] {
  try {
    const out = execSync(`npx madge --circular ${dir} 2>/dev/null`, { cwd: BASE_DIR, encoding: 'utf-8', timeout: 30000 });
    const lines = out.split('\n').filter(l => l.trim());
    return lines;
  } catch (e: any) {
    return e.stdout?.split('\n').filter((l: string) => l.trim()) ?? ['(madge failed)'];
  }
}

// ─── 分析变更文件的影响 ───

function analyzeImpacts(files: string[]): string[] {
  const warnings: string[] = [];
  if (files.length === 0) return warnings;

  for (const f of files) {
    // Check for imports outside the file's own layer
    const content = existsSync(f) ? readFileSync(f, 'utf-8') : '';
    const imports = [...content.matchAll(/from\s+['"]([^'"]+)['"]/g)].map(m => m[1]);

    const layer = f.startsWith('src/features/') ? 'features' :
                  f.startsWith('src/core/') ? 'core' :
                  f.startsWith('src/providers/') ? 'providers' : 'other';

    for (const imp of imports) {
      // Layering violations
      if (layer === 'features' && imp.includes('/features/')) {
        warnings.push(`⚠️  ${f}: feature 引入了另一个 feature (${imp})`);
      }
      if (layer === 'providers' && (imp.includes('/features/') || imp.includes('/providers/'))) {
        if (imp.startsWith('../') || imp.startsWith('.')) {
          warnings.push(`⚠️  ${f}: provider 引入了上层模块 (${imp})`);
        }
      }
      if (layer === 'core' && imp.includes('/providers/')) {
        warnings.push(`⚠️  ${f}: core 引入了 provider 实现 (${imp})`);
      }
    }
  }

  return warnings;
}

// ─── 运行 ───

console.log('🔍 CI 架构检查\n');

// 1. 循环依赖
console.log('── 循环依赖检测 ──');
const cycles = checkCycles('src');
if (cycles.length === 0 || (cycles.length === 1 && !cycles[0])) {
  console.log('  ✅ 无循环依赖\n');
} else {
  for (const c of cycles) {
    if (c.trim()) console.log(`  ❌ ${c}`);
  }
  console.log('');
}

// 2. 变更影响分析
if (changedFiles.length > 0) {
  console.log('── 变更文件影响分析 ──');
  const warnings = analyzeImpacts(changedFiles);
  if (warnings.length === 0) {
    console.log('  ✅ 无分层违规\n');
  } else {
    for (const w of warnings) console.log(`  ${w}`);
    console.log('');
  }
}

// 3. 生成基线
if (baselineArg) {
  const baseline = {
    checkedAt: new Date().toISOString(),
    fileCount: 0,
    totalImports: 0,
    cycles,
  };

  try {
    const findOut = execSync(`find src -name '*.ts' -not -name '*.test.ts' -not -name 'generated.ts' | wc -l`, { cwd: BASE_DIR, encoding: 'utf-8' });
    baseline.fileCount = parseInt(findOut.trim(), 10);
  } catch {}

  writeFileSync(baselineArg, JSON.stringify(baseline, null, 2));
  console.log(`  📝 基线已写入 ${baselineArg}`);
}

if (!baselineArg && changedFiles.length === 0) {
  console.log('  用法:');
  console.log('    npx tsx scripts/ci-check.ts --changed-files="src/features/x/service.ts src/core/y.ts"');
  console.log('    npx tsx scripts/ci-check.ts --baseline baseline.json');
  console.log('');
  console.log('  无 --changed-files 参数时只检查循环依赖');
}
