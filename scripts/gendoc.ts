/**
 * Auto-generate module documentation from TypeScript compiler API.
 *
 * Extracts exported symbols, their type signatures, and existing JSDoc comments.
 * Signatures are compiler-verified. Symbols without JSDoc get TODO placeholders.
 *
 * Usage:  npx tsx scripts/gendoc.ts
 * Output: docs/modules/<path>.md + docs/modules/README.md
 */

import { Project, Node, SyntaxKind, type ExportedDeclarations } from 'ts-morph';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();
const SRC = join(ROOT, 'src').replace(/\\/g, '/');
const OUT = join(ROOT, 'docs', 'modules');
const SRC_RE = new RegExp(escapeRe(SRC + '/'), 'g');
const ROOT_RE = new RegExp(escapeRe(ROOT.replace(/\\/g, '/') + '/node_modules/'), 'g');

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&');
}

/** Replace absolute paths from SRC with relative module references. */
function shortenPaths(s: string): string {
  let t = s.replace(SRC_RE, '');
  // Collapse node_modules paths to the package name
  t = t.replace(/import\("\.\.?\/node_modules\/([^"]+)"\)\.(\w+)/g, 'import("$1").$2');
  t = t.replace(ROOT_RE, '');
  return t;
}

mkdirSync(OUT, { recursive: true });

const project = new Project({
  tsConfigFilePath: join(ROOT, 'tsconfig.json'),
  skipAddingFilesFromTsConfig: false,
});

// ─── Collect exports ───

interface ExportedSymbol {
  name: string;
  kind: 'class' | 'function' | 'interface' | 'type' | 'enum' | 'const';
  signature: string;
  doc?: string | undefined;
  deprecated?: boolean | undefined;
  members: ExportedSymbol[];
}

interface ModuleDoc {
  path: string;
  overview?: string | undefined;
  symbols: ExportedSymbol[];
}

const modules: ModuleDoc[] = [];

for (const sf of project.getSourceFiles()) {
  const filePath = sf.getFilePath();
  if (!filePath.replace(/\\/g, '/').startsWith(SRC.replace(/\\/g, '/'))) continue;
  const relPath = relative(SRC, filePath).replace(/\\/g, '/');

  // Module overview: first JSDoc in file (typically the file header)
  const overview = extractFileOverview(sf);

  const symbols = sf.getExportedDeclarations();
  const exported: ExportedSymbol[] = [];

  for (const [name, decls] of symbols) {
    const decl = decls[0];
    if (!decl) continue;

    const symbol = extractSymbol(name, decl);
    if (symbol) exported.push(symbol);
  }

  if (exported.length > 0) {
    modules.push({ path: relPath, overview, symbols: exported });
  }
}

// ─── Extract file overview ───

function extractFileOverview(sf: ReturnType<typeof project.getSourceFiles>[number]): string | undefined {
  // Check for a JSDoc at the very top of the file (before any import)
  for (const stmt of sf.getStatementsWithComments()) {
    try {
      const comments = (stmt as unknown as { getLeadingCommentRanges?: () => { getText(): string; getKind(): number }[] }).getLeadingCommentRanges?.();
      if (comments) {
        for (const c of comments) {
          const text = c.getText().replace(/^\/\*\*?\s*\n?|\s*\*\/$/g, '').replace(/^[ \t]*\*[ \t]?/gm, '').trim();
          if (text.length > 0 && c.getKind() === 2) return text;
        }
      }
    } catch { /* skip */ }
    break;
  }
  return undefined;
}

// ─── Extract JSDoc from declaration ───

function extractDoc(decl: ExportedDeclarations): { doc?: string; deprecated?: boolean } {
  // Try JSDoc first
  try {
    const maybeNode = decl as unknown as { getJsDocs?: () => { getDescription(): string; getTags(): { getTagName(): string }[] }[] };
    if (typeof maybeNode.getJsDocs === 'function') {
      const jsDocs = maybeNode.getJsDocs();
      if (jsDocs.length > 0) {
        const desc = jsDocs.map(j => j.getDescription().trim()).filter(Boolean).join('\n\n');
        const deprecated = jsDocs.some(j => j.getTags().some(t => t.getTagName() === 'deprecated'));
        if (desc) return { doc: desc, deprecated: deprecated || undefined };
      }
    }
  } catch { /* not a JSDocable node */ }

  // Fallback: leading block comment
  try {
    const n = decl as unknown as { getLeadingCommentRanges?: () => { getText(): string; getKind(): number }[] };
    if (typeof n.getLeadingCommentRanges === 'function') {
      const comments = n.getLeadingCommentRanges();
      if (comments.length > 0) {
        const text = comments[0]!.getText().replace(/^\/\*\*?\s*\n?|\s*\*\/$/g, '').replace(/^[ \t]*\*[ \t]?/gm, '').trim();
        if (text.length > 0) return { doc: text };
      }
    }
  } catch { /* not a comment-having node */ }

  return {};
}

// ─── Extract symbol ───

function extractSymbol(name: string, decl: ExportedDeclarations): ExportedSymbol | null {
  const { doc, deprecated } = extractDoc(decl);

  if (Node.isClassDeclaration(decl)) {
    const members: ExportedSymbol[] = [];
    for (const m of decl.getInstanceMembers()) {
      const isPrivate = m.hasModifier(SyntaxKind.PrivateKeyword);
      const isProtected = m.hasModifier(SyntaxKind.ProtectedKeyword);
      const isPublic = m.hasModifier(SyntaxKind.PublicKeyword) || (!isPrivate && !isProtected);
      if (!isPublic) continue;
      let memberSig = '';
      if (Node.isMethodDeclaration(m) || Node.isMethodSignature(m)) {
        const params = m.getParameters().map(p => `${p.getName()}: ${p.getType().getText()}`).join(', ');
        memberSig = `${m.getName()}(${params}): ${m.getReturnType().getText()}`;
      } else if (Node.isPropertyDeclaration(m) || Node.isPropertySignature(m)) {
        memberSig = `${m.getName()}: ${m.getType().getText()}`;
      } else if (Node.isGetAccessorDeclaration(m)) {
        memberSig = `get ${m.getName()}: ${m.getReturnType().getText()}`;
      }
      if (memberSig) {
        const mDoc = extractDoc(m);
        members.push({ name: m.getName(), kind: 'function', signature: memberSig, doc: mDoc.doc, deprecated: mDoc.deprecated, members: [] });
      }
    }
    return { name, kind: 'class', signature: `class ${name}`, doc, deprecated, members };
  }

  if (Node.isFunctionDeclaration(decl)) {
    const params = decl.getParameters().map(p => `${p.getName()}: ${p.getType().getText()}`).join(', ');
    const rt = decl.getReturnType().getText();
    return { name, kind: 'function', signature: `function ${name}(${params}): ${rt}`, doc, deprecated, members: [] };
  }

  if (Node.isInterfaceDeclaration(decl)) {
    const members: ExportedSymbol[] = [];
    for (const m of decl.getMembers()) {
      const mDoc = extractDoc(m);
      if (Node.isPropertySignature(m)) {
        members.push({ name: m.getName(), kind: 'type', signature: `${m.getName()}: ${m.getType().getText()}`, doc: mDoc.doc, deprecated: mDoc.deprecated, members: [] });
      } else if (Node.isMethodSignature(m)) {
        const params = m.getParameters().map(p => `${p.getName()}: ${p.getType().getText()}`).join(', ');
        members.push({ name: m.getName(), kind: 'function', signature: `${m.getName()}(${params}): ${m.getReturnType().getText()}`, doc: mDoc.doc, deprecated: mDoc.deprecated, members: [] });
      }
    }
    return { name, kind: 'interface', signature: `interface ${name}`, doc, deprecated, members };
  }

  if (Node.isTypeAliasDeclaration(decl)) {
    return { name, kind: 'type', signature: `type ${name} = ${decl.getTypeNode()?.getText() ?? '...'}`, doc, deprecated, members: [] };
  }

  if (Node.isEnumDeclaration(decl)) {
    const vals = decl.getMembers().map(m => {
      const v = m.getValue();
      const mDoc = extractDoc(m);
      return `${m.getName()}${v !== undefined ? ` = ${String(v)}` : ''}${mDoc.doc ? ` /* ${mDoc.doc.slice(0, 60)} */` : ''}`;
    }).join(', ');
    return { name, kind: 'enum', signature: `enum ${name} { ${vals} }`, doc, deprecated, members: [] };
  }

  if (Node.isVariableDeclaration(decl)) {
    const init = decl.getInitializer()?.getText() ?? '...';
    return { name, kind: 'const', signature: `const ${name} = ${init.slice(0, 80)}`, doc, deprecated, members: [] };
  }

  return null;
}

// ─── Generate markdown ───

function docBlock(doc: string | undefined, deprecated: boolean | undefined, fallback: string): string {
  let out = '';
  if (doc) {
    out += `${doc}\n\n`;
  } else {
    out += `<!-- TODO: ${fallback} -->\n\n`;
  }
  if (deprecated) {
    out += '> **@deprecated** — this symbol is scheduled for removal.\n\n';
  }
  return out;
}

function renderSymbol(s: ExportedSymbol, depth: number): string {
  const h = '#'.repeat(Math.min(depth + 2, 4));
  let out = '';

  switch (s.kind) {
    case 'class':
      out += `${h} \`${s.name}\`\n\n`;
      out += docBlock(s.doc, s.deprecated, `描述 ${s.name} 的职责和生命周期`);
      if (s.members.length > 0) {
        out += `**Public Members**\n\n`;
        for (const m of s.members) {
          const prefix = m.deprecated ? '~~' : '';
          const suffix = m.deprecated ? '~~ *(deprecated)*' : '';
          out += `- ${prefix}\`${m.signature}\`${suffix}`;
          if (m.doc) out += ` — ${m.doc.slice(0, 120)}`;
          out += '\n';
        }
        out += '\n';
      }
      break;
    case 'function':
      out += `${h} \`${s.signature}\`\n\n`;
      out += docBlock(s.doc, s.deprecated, '描述函数用途、参数含义、返回值');
      break;
    case 'interface':
      out += `${h} \`${s.name}\`\n\n`;
      out += docBlock(s.doc, s.deprecated, '描述接口契约');
      if (s.members.length > 0) {
        const props = s.members.filter(m => m.kind === 'type');
        const methods = s.members.filter(m => m.kind === 'function');
        if (props.length > 0) {
          out += '| Property | Type |\n|----------|------|\n';
          for (const m of props) {
            const typePart = m.signature.split(': ').slice(1).join(': ');
            const note = m.doc ? ` — ${m.doc.slice(0, 80)}` : '';
            const prefix = m.deprecated ? '~~' : '';
            const suffix = m.deprecated ? '~~' : '';
            out += `| ${prefix}\`${m.name}\`${suffix} | \`${typePart}\`${note} |\n`;
          }
          out += '\n';
        }
        for (const m of methods) {
          const prefix = m.deprecated ? '~~' : '';
          out += `- ${prefix}\`${m.signature}\`${prefix}`;
          if (m.doc) out += ` — ${m.doc.slice(0, 100)}`;
          out += '\n';
        }
        if (methods.length > 0) out += '\n';
      }
      break;
    case 'type':
      out += `${h} \`${s.signature}\`\n\n`;
      out += docBlock(s.doc, s.deprecated, '描述类型用途');
      break;
    case 'enum':
      out += `${h} \`${s.signature}\`\n\n`;
      out += docBlock(s.doc, s.deprecated, '描述枚举语义');
      break;
    case 'const':
      out += `${h} \`${s.signature}\`\n\n`;
      out += docBlock(s.doc, s.deprecated, '描述常量/单例用途');
      break;
  }
  return out;
}

// ─── Write docs ───

let indexMd = '# Module Index\n\n';
indexMd += '> Auto-generated by `npx tsx scripts/gendoc.ts`\n';
indexMd += `> ${modules.length} modules, ${modules.reduce((s, m) => s + m.symbols.length, 0)} exported symbols\n\n`;

modules.sort((a, b) => a.path.localeCompare(b.path));

for (const m of modules) {
  const relNoExt = m.path.replace(/\.ts$/, '');
  const dir = join(OUT, relNoExt.split('/').slice(0, -1).join('/'));
  mkdirSync(dir, { recursive: true });
  const fileName = (relNoExt.split('/').pop() ?? 'index') + '.md';

  let md = `# \`${m.path}\`\n\n`;
  if (m.overview) {
    md += `${m.overview}\n\n`;
  } else {
    md += `<!-- TODO: 模块概述 -->\n\n`;
  }

  const ifaces = m.symbols.filter(s => s.kind === 'interface');
  const classes = m.symbols.filter(s => s.kind === 'class');
  const funcs = m.symbols.filter(s => s.kind === 'function');
  const types = m.symbols.filter(s => s.kind === 'type' || s.kind === 'enum');
  const consts = m.symbols.filter(s => s.kind === 'const');

  if (ifaces.length > 0) { md += '## Interfaces\n\n'; for (const s of ifaces) md += renderSymbol(s, 2); }
  if (classes.length > 0) { md += '## Classes\n\n'; for (const s of classes) md += renderSymbol(s, 2); }
  if (funcs.length > 0) { md += '## Functions\n\n'; for (const s of funcs) md += renderSymbol(s, 2); }
  if (types.length > 0) { md += '## Types\n\n'; for (const s of types) md += renderSymbol(s, 2); }
  if (consts.length > 0) { md += '## Constants\n\n'; for (const s of consts) md += renderSymbol(s, 2); }

  writeFileSync(join(dir, fileName), shortenPaths(md));

  const linkPath = relNoExt + '.md';
  const summary = m.symbols.slice(0, 5).map(s => `\`${s.name}\``).join(' ');
  indexMd += `- [\`${m.path}\`](modules/${linkPath}) — ${summary}\n`;
}

writeFileSync(join(ROOT, 'docs', 'README.md'), indexMd);

// ─── Summary ───

let totalSymbols = 0;
let withDoc = 0;
for (const m of modules) {
  totalSymbols += m.symbols.length;
  for (const s of m.symbols) {
    if (s.doc) withDoc++;
    for (const mem of s.members) {
      totalSymbols++;
      if (mem.doc) withDoc++;
    }
  }
}
console.log(`Generated docs for ${modules.length} modules (${totalSymbols} symbols, ${withDoc} with JSDoc)`);
console.log(`Output: docs/modules/README.md + docs/modules/**/*.md`);
