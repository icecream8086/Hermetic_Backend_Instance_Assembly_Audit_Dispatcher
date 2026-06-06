/**
 * 调用图 + 容斥计数分析
 *
 * 用 ts-morph 走 TS 语法树，对 src/ 下所有函数/方法：
 *   - 记录 caller → callees（出边）
 *   - 记录 callee → callers（入边）
 * 然后按容斥原理找出热点重叠路径。
 *
 * 用法:
 *   npx tsx scripts/callgraph.ts                       — 完整调用图 + 容斥分析
 *   npx tsx scripts/callgraph.ts --trace=SandboxService.provision  — 查某个函数的调用链
 */

import { Project, SyntaxKind, type CallExpression, type MethodDeclaration, type FunctionDeclaration, type ArrowFunction, type SourceFile } from 'ts-morph';
import { readdirSync, statSync } from 'node:fs';
import { resolve, relative, sep } from 'node:path';

// ─── 配置 ───

const SRC_DIR = resolve(import.meta.dirname, '..', 'src');
const EXCLUDE_DIRS = new Set(['node_modules']);

// ─── 调用图数据结构 ───

interface FuncNode {
  /** 模块内限定名，如 "SandboxService.provision" */
  name: string;
  /** 源文件路径（相对 src/） */
  file: string;
  /** 行号 */
  line: number;
  /** 这个函数调了谁（出边） */
  callees: Set<string>;
  /** 谁调了这个函数（入边） */
  callers: Set<string>;
}

const graph = new Map<string, FuncNode>();

// ─── 遍历源文件 ───

function walkDir(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!EXCLUDE_DIRS.has(entry.name)) {
        files.push(...walkDir(resolve(dir, entry.name)));
      }
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') && !entry.name.endsWith('.spec.ts')) {
      files.push(resolve(dir, entry.name));
    }
  }
  return files;
}

// ─── 获取函数/方法的限定名 ───

function getFuncName(node: MethodDeclaration | FunctionDeclaration | ArrowFunction): string | null {
  // Named function: function foo() {}
  if (node.isKind(SyntaxKind.FunctionDeclaration)) {
    const name = node.getName();
    return name ?? null;
  }

  // Method: class Foo { bar() {} }
  if (node.isKind(SyntaxKind.MethodDeclaration)) {
    const parent = node.getParent();
    if (parent?.isKind(SyntaxKind.ClassDeclaration)) {
      const className = parent.getName();
      const methodName = node.getName();
      if (className && methodName) return `${className}.${methodName}`;
    }
    return node.getName() ?? null;
  }

  // Arrow / function expression assigned to variable: const foo = () => {}
  if (node.isKind(SyntaxKind.ArrowFunction) || node.isKind(SyntaxKind.FunctionExpression)) {
    const parent = node.getParent();
    if (parent?.isKind(SyntaxKind.VariableDeclaration)) {
      return parent.getName() ?? null;
    }
    if (parent?.isKind(SyntaxKind.PropertyAssignment)) {
      return parent.getName() ?? null;
    }
    // Method-like arrow in object literal: { foo: () => {} }
    if (parent?.isKind(SyntaxKind.MethodDeclaration)) {
      return parent.getName() ?? null;
    }
  }

  return null;
}

// ─── 解析调用表达式的被调函数名 ───

function resolveCalleeName(call: CallExpression): string | null {
  const expr = call.getExpression();

  // Simple identifier: foo()
  if (expr.isKind(SyntaxKind.Identifier)) {
    return expr.getText();
  }

  // Property access: this.foo(), obj.bar()
  if (expr.isKind(SyntaxKind.PropertyAccessExpression)) {
    const propAccess = expr.asKindOrThrow(SyntaxKind.PropertyAccessExpression);
    const obj = propAccess.getExpression().getText();
    const prop = propAccess.getName();
    const objText = obj;

    // static method call: ClassName.method()
    // this.method()
    // instance.method()
    if (objText === 'this') return `${prop}`;
    return `${objText}.${prop}`;
  }

  return null;
}

// ─── 分析单个文件 ───

function analyzeFile(filePath: string, project: Project): void {
  const sourceFile = project.addSourceFileAtPath(filePath);
  const relPath = relative(SRC_DIR, filePath).replace(/\\/g, '/');
  const functions = sourceFile.getDescendantsOfKind(SyntaxKind.MethodDeclaration)
    .concat(sourceFile.getDescendantsOfKind(SyntaxKind.FunctionDeclaration))
    .concat(sourceFile.getDescendantsOfKind(SyntaxKind.ArrowFunction));

  for (const fn of functions) {
    // Skip nested functions (they're closures, not interesting at this level)
    if (fn.getParent().isKind(SyntaxKind.Block)) continue;

    const name = getFuncName(fn);
    if (!name) continue;

    // Skip anonymous / internal helpers
    if (name.startsWith('_') || name.startsWith('#')) continue;

    const line = fn.getStartLineNumber();
    const callees = new Set<string>();

    // Find all call expressions in this function body
    const calls = fn.getDescendantsOfKind(SyntaxKind.CallExpression);
    for (const call of calls) {
      const callee = resolveCalleeName(call);
      if (callee && callee !== name) {
        callees.add(callee);
      }
    }

    if (!graph.has(name)) {
      graph.set(name, { name, file: relPath, line, callees: new Set(), callers: new Set() });
    }
    const node = graph.get(name)!;
    node.file = relPath;
    node.line = line;
    for (const c of callees) {
      node.callees.add(c);
      if (!graph.has(c)) {
        graph.set(c, { name: c, file: '', line: 0, callees: new Set(), callers: new Set() });
      }
      graph.get(c)!.callers.add(name);
    }
  }
}

// ─── 容斥计数 ───

interface PairReport {
  a: string;
  b: string;
  /** |callers(A) ∩ callers(B)| */
  sharedCallers: number;
  /** |callees(A) ∩ callees(B)| */
  sharedCallees: number;
  intersectCallers: string[];
  intersectCallees: string[];
}

function inclusionExclusion(): PairReport[] {
  const nodes = [...graph.values()].filter(n => n.name.includes('.') || n.callers.size > 0 || n.callees.size > 0);
  const reports: PairReport[] = [];

  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i]!;
      const b = nodes[j]!;

      const sharedCallers = [...a.callers].filter(c => b.callers.has(c));
      const sharedCallees = [...a.callees].filter(c => b.callees.has(c));

      if (sharedCallers.length > 0 || sharedCallees.length > 0) {
        reports.push({
          a: a.name,
          b: b.name,
          sharedCallers: sharedCallers.length,
          sharedCallees: sharedCallees.length,
          intersectCallers: sharedCallers,
          intersectCallees: sharedCallees,
        });
      }
    }
  }

  return reports.sort((a, b) => (b.sharedCallers + b.sharedCallees) - (a.sharedCallers + a.sharedCallees));
}

// ─── Trace 查询 ───

function traceFn(name: string, depth = 2): void {
  const node = graph.get(name);
  if (!node) { console.log(`  ❌ "${name}" not found in call graph`); return; }
  const loc = node.file ? `${node.file}:${node.line}` : '(external)';
  console.log(`\n  ${name}  —  ${loc}\n`);

  // Recursively collect callers
  const seen = new Set<string>();
  function printCallers(fn: string, indent: number) {
    if (indent > depth || seen.has(fn)) return;
    seen.add(fn);
    const n = graph.get(fn);
    if (!n || n.callers.size === 0) return;
    const prefix = '  '.repeat(indent) + '↑ ';
    for (const c of n.callers) {
      const cloc = graph.get(c)?.file ? ` (${graph.get(c)!.file}:${graph.get(c)!.line})` : '';
      console.log(`${prefix}${c}${cloc}`);
      printCallers(c, indent + 1);
    }
  }
  console.log('  Callers（上级调用链）:');
  printCallers(name, 1);
  if (!seen.has(name)) { /* was already added */ }

  // Recursively collect callees
  seen.clear();
  function printCallees(fn: string, indent: number) {
    if (indent > depth || seen.has(fn)) return;
    seen.add(fn);
    const n = graph.get(fn);
    if (!n || n.callees.size === 0) return;
    const prefix = '  '.repeat(indent) + '↓ ';
    for (const c of n.callees) {
      const cloc = graph.get(c)?.file ? ` (${graph.get(c)!.file}:${graph.get(c)!.line})` : '';
      console.log(`${prefix}${c}${cloc}`);
      printCallees(c, indent + 1);
    }
  }
  console.log('  Callees（内部调用链）:');
  printCallees(name, 1);
}

// ─── 主函数 ───

function main(): void {
  const traceTarget = process.argv.find(a => a.startsWith('--trace='))?.slice(8);
  const traceMode = !!traceTarget || process.argv.includes('--trace');
  console.log('🔍 扫描源文件...');
  const files = walkDir(SRC_DIR);
  console.log(`   找到 ${files.length} 个源文件`);

  const project = new Project({
    compilerOptions: {
      strict: true,
      target: 99, // ES2022
      module: 99,
    },
  });

  console.log('   分析调用关系...');
  for (const f of files) {
    try {
      analyzeFile(f, project);
    } catch (e: any) {
      console.warn(`   ⚠  ${relative(SRC_DIR, f)}: ${e.message}`);
    }
  }

  console.log(`\n   收录 ${graph.size} 个函数/方法\n`);

  // Trace mode: 查指定函数的调用链后退出
  if (traceMode) {
    const target = traceTarget ?? process.argv[process.argv.indexOf('--trace') + 1];
    if (target) traceFn(target);
    return;
  }

  // ─── 出/入度 Top 排名 ───

  const byOutDegree = [...graph.values()]
    .filter(n => n.callees.size > 0)
    .sort((a, b) => b.callees.size - a.callees.size)
    .slice(0, 20);

  const byInDegree = [...graph.values()]
    .filter(n => n.callers.size > 0)
    .sort((a, b) => b.callers.size - a.callers.size)
    .slice(0, 20);

  console.log('─'.repeat(60));
  console.log('📈 出度 Top 20（调了最多不同函数）');
  console.log('─'.repeat(60));
  for (const n of byOutDegree) {
    const loc = n.file ? ` ${n.file}:${n.line}` : ' (external)';
    console.log(`  ${String(n.callees.size).padStart(3)}  ${n.name}${loc}`);
  }

  console.log('\n' + '─'.repeat(60));
  console.log('📉 入度 Top 20（被最多函数调用）');
  console.log('─'.repeat(60));
  for (const n of byInDegree) {
    const loc = n.file ? ` ${n.file}:${n.line}` : ' (external)';
    console.log(`  ${String(n.callers.size).padStart(3)}  ${n.name}${loc}`);
  }

  // ─── 容斥分析 ───

  console.log('\n' + '─'.repeat(60));
  console.log('🔗 容斥重叠 Top 30（sharedCallers + sharedCallees 之和排序）');
  console.log('─'.repeat(60));

  const pairs = inclusionExclusion().slice(0, 30);
  for (const p of pairs) {
    const parts: string[] = [];
    if (p.sharedCallers > 0) parts.push(`callers∩=${p.sharedCallers} [${p.intersectCallers.join(', ')}]`);
    if (p.sharedCallees > 0) parts.push(`callees∩=${p.sharedCallees} [${p.intersectCallees.join(', ')}]`);
    console.log(`\n  ${p.a}  ↔  ${p.b}`);
    console.log(`     ${parts.join('; ')}`);
  }

  // ─── 高频路径推荐 ───

  console.log('\n' + '─'.repeat(60));
  console.log('💡 优化建议');
  console.log('─'.repeat(60));

  // 共享调用者 → 可合并/缓存
  const mergeCandidates = pairs.filter(p => p.sharedCallers >= 2);
  if (mergeCandidates.length > 0) {
    console.log('\n  [可合并/缓存] 以下函数对常被同一上级调用:');
    for (const p of mergeCandidates.slice(0, 10)) {
      console.log(`    ${p.a} + ${p.b}`);
      console.log(`      共同调用者: ${p.intersectCallers.join(', ')}`);
    }
  }

  // 共享被调用者 → 可预加载/批处理
  const batchCandidates = pairs.filter(p => p.sharedCallees >= 2);
  if (batchCandidates.length > 0) {
    console.log('\n  [可预加载/批处理] 以下函数对调用了相同子函数:');
    for (const p of batchCandidates.slice(0, 10)) {
      console.log(`    ${p.a} + ${p.b}`);
      console.log(`      共同子调用: ${p.intersectCallees.join(', ')}`);
    }
  }

  // 出度高且在热点路径上的
  const hotPaths = byOutDegree.filter(n => n.callers.size > 0);
  const traceTargets = hotPaths.filter(n => {
    const callers = [...n.callers];
    return callers.some(c => {
      const callerNode = graph.get(c);
      return callerNode && callerNode.callees.size >= 5;
    });
  });
  if (traceTargets.length > 0) {
    console.log('\n  [高频路径] 以下函数既是调用的热点又调了大量子函数:');
    for (const n of traceTargets.slice(0, 10)) {
      console.log(`    ${n.name} (入度=${n.callers.size}, 出度=${n.callees.size})`);
      console.log(`      调用者: ${[...n.callers].slice(0, 8).join(', ')}`);
      console.log(`      调用了: ${[...n.callees].slice(0, 8).join(', ')}`);
    }
  }

  console.log('');
}

main();
