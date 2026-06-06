/**
 * 内聚/耦合度量分析
 *
 * 计算 LCOM / RFC / CBO / 扇入扇出 / 不稳定度
 * 定位模块设计缺陷：低内聚、高耦合、上帝类、基础模块扇入过高
 *
 * 用法: npx tsx scripts/metrics.ts
 */
import { Project, SyntaxKind, type ClassDeclaration } from 'ts-morph';
import { readdirSync } from 'node:fs';
import { resolve, relative } from 'node:path';

const SRC = resolve(import.meta.dirname, '..', 'src');
const files: string[] = [];

function walk(d: string) {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    if (e.isDirectory() && e.name !== 'node_modules' && !e.name.startsWith('.'))
      walk(resolve(d, e.name));
    else if (e.name.endsWith('.ts') && !e.name.endsWith('.test.ts') && !e.name.endsWith('.spec.ts'))
      files.push(resolve(d, e.name));
  }
}
walk(SRC);

const project = new Project({ compilerOptions: { strict: true, target: 99, module: 99 } });
for (const f of files) {
  try { project.addSourceFileAtPath(f); } catch {}
}

// ─── 收集类的字段（含构造参数属性） ───
function getClassFields(cls: ClassDeclaration): string[] {
  // 1) 显式属性声明: private x = ...
  const props = cls.getProperties().map(p => p.getName());

  // 2) 构造参数属性: constructor(private readonly atomic: ...)
  const ctors = cls.getConstructors();
  for (const ctor of ctors) {
    for (const param of ctor.getParameters()) {
      // 有 public/private/protected 修饰的就是参数属性
      // 检查是否有 scope（public/private/protected）
      const modifiers = param.getModifiers();
      const hasScope = modifiers.some(m =>
        m.getKind() === SyntaxKind.PublicKeyword ||
        m.getKind() === SyntaxKind.PrivateKeyword ||
        m.getKind() === SyntaxKind.ProtectedKeyword
      );
      if (hasScope) {
        props.push(param.getName());
      }
    }
  }

  // 3) 私有字段: #xxx
  // ts-morph 的 getProperties() 已经包括 #xxx 字段
  return props;
}

// ─── 计算调用图 ───
const fanInMap = new Map<string, number>();
const fanOutMap = new Map<string, number>();

for (const sf of project.getSourceFiles()) {
  for (const cls of sf.getClasses()) {
    for (const m of cls.getMethods()) {
      const qn = `${cls.getName()}.${m.getName()}`;
      const calls = m.getDescendantsOfKind(SyntaxKind.CallExpression);
      fanOutMap.set(qn, calls.length);
      for (const c of calls) {
        const callee = c.getExpression().getText();
        fanInMap.set(callee, (fanInMap.get(callee) ?? 0) + 1);
      }
    }
  }
}

// ─── 类级别度量 ───
interface Metric {
  cls: string;
  file: string;
  LCOM: number;       // 方法间不共享字段的比例 → 0=高内聚 1=低内聚
  RFC: number;        // 方法数 + 调用的不同外部函数数
  CBO: number;        // import 数 + 父类数
  methods: number;
  fields: number;
  fanIn: number;      // 该类被多少外部函数调用
  fanOut: number;     // 该类调用了多少外部方法
}

const results: Metric[] = [];

for (const sf of project.getSourceFiles()) {
  const rel = relative(SRC, sf.getFilePath()).replace(/\\/g, '/');

  for (const cls of sf.getClasses()) {
    const name = cls.getName();
    if (!name) continue;
    const methods = cls.getMethods();
    if (methods.length < 2) continue;

    const fields = getClassFields(cls);

    // LCOM: 方法对中共享字段的比例（Henderson-Sellers 版本）
    let sharedCount = 0;
    let totalPairs = 0;
    for (let i = 0; i < methods.length; i++) {
      for (let j = i + 1; j < methods.length; j++) {
        totalPairs++;
        const m1Ids = methods[i]!.getDescendantsOfKind(SyntaxKind.Identifier).map(id => id.getText());
        const m2Ids = methods[j]!.getDescendantsOfKind(SyntaxKind.Identifier).map(id => id.getText());
        const m1Fields = fields.filter(f => m1Ids.includes(f));
        const m2Fields = fields.filter(f => m2Ids.includes(f));
        const shared = m1Fields.filter(f => m2Fields.includes(f));
        if (shared.length > 0) sharedCount++;
      }
    }
    const lcom = totalPairs > 0 ? 1 - (sharedCount / totalPairs) : 0;

    // RFC = 方法数 + 调用中不同的外部函数
    const allCalls = new Set(
      methods.flatMap(m =>
        m.getDescendantsOfKind(SyntaxKind.CallExpression).map(c => c.getExpression().getText())
      )
    );
    const rfc = methods.length + allCalls.size;

    // CBO = import 数 + 父类数
    const imports = sf.getImportDeclarations().map(i => i.getModuleSpecifierValue()).length;
    const cbo = imports + (cls.getBaseClass() ? 1 : 0);

    // 扇入: 该类方法被外部调用的总次数
    let fanIn = 0;
    for (const m of methods) {
      fanIn += fanInMap.get(`${name}.${m.getName()}`) ?? 0;
    }
    // 扇出: 该类方法调用的外部函数总数
    const fanOut = allCalls.size;

    results.push({ cls: name, file: rel, LCOM: lcom, RFC: rfc, CBO: cbo, methods: methods.length, fields: fields.length, fanIn, fanOut });
  }
}

// ─── 辅助函数：按列输出 ───
const HR = '─'.repeat(120);

function printRows(rows: Metric[], sortFn: (a: Metric, b: Metric) => number, label: string) {
  const sorted = [...rows].sort(sortFn).slice(0, 20);
  console.log(`\n${label}`);
  console.log(HR);
  console.log('Class'.padEnd(35), 'LCOM ', 'RFC  ', 'CBO  ', 'Mtd ', 'Fld ', 'FanIn', 'FanOut  File');
  console.log(HR);
  for (const r of sorted) {
    console.log(
      r.cls.padEnd(35),
      r.LCOM.toFixed(2).padStart(5),
      String(r.RFC).padStart(5),
      String(r.CBO).padStart(5),
      String(r.methods).padStart(5),
      String(r.fields).padStart(5),
      String(r.fanIn).padStart(5),
      String(r.fanOut).padStart(6).padEnd(3),
      r.file
    );
  }
}

console.log('=== 内聚/耦合度量报告 ===');
console.log(`源文件: ${files.length}`);
console.log(`含方法类: ${results.length}`);

// ─── 低内聚 Top 20 ───
printRows(results, (a, b) => b.LCOM - a.LCOM || b.RFC - a.RFC, '\n📉 低内聚 Top 20（LCOM 高 = 方法间共享字段少）');

// ─── 高耦合 Top 20（RFC） ───
printRows(results, (a, b) => b.RFC - a.RFC, '\n🔗 高耦合 Top 20（RFC 高 = 方法调用面宽）');

// ─── 上帝类 Top 20 ───
printRows(results, (a, b) => (a.methods * a.RFC) - (b.methods * b.RFC) || a.CBO - b.CBO, '\n🦣 上帝类 Top 20（方法数 × RFC、CBO 综合）');

// ─── 不稳定模块（扇出 >> 扇入） ───
const unstable = results.filter(r => r.fanIn > 0 && r.fanOut / r.fanIn > 3);
printRows(unstable, (a, b) => (b.fanOut / b.fanIn) - (a.fanOut / a.fanIn), '\n🌊 不稳定模块 Top 20（扇出/扇入 > 3 = 依赖多被依赖少）');

// ─── 分析建议 ───
console.log('\n\n=== 💡 设计缺陷分析 ===\n');

// 1) 高 LCOM + 高 RFC = 胖服务类
const godServices = results
  .filter(r => r.LCOM > 0.5 && r.methods >= 8)
  .sort((a, b) => b.methods * b.RFC - a.methods * a.RFC);
if (godServices.length > 0) {
  console.log('[胖服务] 方法多、内聚低、调用面宽 → 应考虑拆分:');
  for (const r of godServices.slice(0, 8)) {
    console.log(`  ${r.cls.padEnd(30)} ${r.methods} 方法, LCOM=${r.LCOM.toFixed(2)}, RFC=${r.RFC}, CBO=${r.CBO}  ${r.file}`);
  }
}

// 2) 高 CBO = 耦合太宽
const highCbo = results.filter(r => r.CBO >= 12).sort((a, b) => b.CBO - a.CBO);
if (highCbo.length > 0) {
  console.log('\n[高耦合] CBO ≥ 12 — import 太多，依赖面过宽:');
  for (const r of highCbo.slice(0, 8)) {
    console.log(`  ${r.cls.padEnd(30)} CBO=${r.CBO}, RFC=${r.RFC}  ${r.file}`);
  }
}

// 3) 基础模块陷阱：被大量依赖但自身也依赖很多
const baseModules = results
  .filter(r => r.fanIn >= 10 && r.fanOut >= 10)
  .sort((a, b) => b.fanIn + b.fanOut - (a.fanIn + a.fanOut));
if (baseModules.length > 0) {
  console.log('\n[基础模块] 扇入扇出都高 — 被大量依赖但自己也依赖很多（易碎基础）:');
  for (const r of baseModules.slice(0, 5)) {
    console.log(`  ${r.cls.padEnd(30)} 扇入=${r.fanIn}, 扇出=${r.fanOut}, CBO=${r.CBO}  ${r.file}`);
  }
}

// 4) 零字段服务类 = 纯事务脚本
const noFields = results.filter(r => r.fields === 0 && r.methods >= 3);
if (noFields.length > 0) {
  console.log('\n[事务脚本] 零字段但有多个方法 — 纯操作无状态（事务脚本模式）:');
  for (const r of noFields.slice(0, 8)) {
    console.log(`  ${r.cls.padEnd(30)} ${r.methods} 方法, RFC=${r.RFC}, LCOM=${r.LCOM.toFixed(2)}  ${r.file}`);
  }
}
