import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import type { RawCall, RawImport, RawSymbol, RawTest } from "./indexer.ts";
import { isJsSourceFile, isJsTestFile } from "./js.ts";

/**
 * TypeScript/JavaScript extraction for the knowledge graph, with the TypeScript compiler API (syntax only, no type
 * checker): modules, classes, functions, methods, interfaces, type aliases and enums; module-level imports resolved to
 * repository files when relative (or through tsconfig `paths` when they match); call references by syntactic callee
 * name; `it(`/`test(` blocks as test cases. The shapes mirror `python/index_repo.py` so the graph builder treats both
 * languages alike: a module's name is its repository path without the extension (`src/util/git`).
 */

export interface TsExtraction {
  modules: string[];
  symbols: RawSymbol[];
  imports: RawImport[];
  calls: RawCall[];
  tests: RawTest[];
  skipped: Array<{ path: string; reason: string }>;
}

const EXT_RE = /\.(d\.ts|tsx|ts|mts|cts|jsx|js|mjs|cjs)$/;
export const tsModuleName = (p: string): string => p.replace(EXT_RE, "");
const CANDIDATE_EXT = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];

interface PathAlias {
  prefix: string;
  suffix: string;
  targets: string[];
}

/** tsconfig `compilerOptions.paths` as prefix/suffix aliases relative to `baseUrl` (or the tsconfig directory). */
export function readPathAliases(repoPath: string): PathAlias[] {
  const file = path.join(repoPath, "tsconfig.json");
  if (!fs.existsSync(file)) return [];
  try {
    const parsed = ts.readConfigFile(file, (f) => fs.readFileSync(f, "utf8"));
    const options = (parsed.config?.compilerOptions ?? {}) as { baseUrl?: string; paths?: Record<string, string[]> };
    const base = options.baseUrl ? path.posix.normalize(options.baseUrl.replace(/\\/g, "/")).replace(/^\.\/?/, "") : "";
    return Object.entries(options.paths ?? {}).map(([pattern, targets]) => {
      const star = pattern.indexOf("*");
      return { prefix: star >= 0 ? pattern.slice(0, star) : pattern, suffix: star >= 0 ? pattern.slice(star + 1) : "", targets: targets.map((t) => path.posix.normalize(path.posix.join(base, t.replace(/\\/g, "/")))) };
    });
  } catch {
    return [];
  }
}

/** Resolve an import specifier to a repository file: relative paths, then tsconfig aliases; packages stay unresolved. */
export function resolveSpecifier(spec: string, fromFile: string, files: Set<string>, aliases: PathAlias[]): string | null {
  const tryFile = (base: string): string | null => {
    const clean = path.posix.normalize(base);
    if (files.has(clean) && isJsSourceFile(clean)) return clean;
    const stripped = clean.replace(/\.(js|jsx|mjs|cjs|ts|tsx|mts|cts)$/, "");
    for (const ext of CANDIDATE_EXT) if (files.has(stripped + ext)) return stripped + ext;
    for (const ext of CANDIDATE_EXT) if (files.has(`${stripped}/index${ext}`)) return `${stripped}/index${ext}`;
    return null;
  };
  if (spec.startsWith(".")) return tryFile(path.posix.join(path.posix.dirname(fromFile), spec));
  if (spec.startsWith("/")) return null;
  for (const a of aliases) {
    if (!spec.startsWith(a.prefix) || !spec.endsWith(a.suffix)) continue;
    const middle = spec.slice(a.prefix.length, spec.length - a.suffix.length);
    for (const t of a.targets) {
      const hit = tryFile(t.includes("*") ? t.replace("*", middle) : t);
      if (hit) return hit;
    }
  }
  return null;
}

const text = (sf: ts.SourceFile, node: ts.Node): string => node.getText(sf);
const lineOf = (sf: ts.SourceFile, pos: number): number => sf.getLineAndCharacterOfPosition(pos).line + 1;

function jsDoc(node: ts.Node): string | null {
  const docs = (node as { jsDoc?: ts.JSDoc[] }).jsDoc;
  if (!docs?.length) return null;
  const last = docs[docs.length - 1]!;
  const c = last.comment;
  const s = typeof c === "string" ? c : c ? c.map((p) => p.text).join("") : "";
  return s.trim() || null;
}

/** `a.b.c(` → `a.b.c`; `this.x(` → `this.x`; anything else null. */
function calleeName(expr: ts.Expression): string | null {
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr)) {
    const left = calleeName(expr.expression);
    return left ? `${left}.${expr.name.text}` : null;
  }
  if (expr.kind === ts.SyntaxKind.ThisKeyword) return "this";
  if (ts.isNonNullExpression(expr) || ts.isParenthesizedExpression(expr) || ts.isAsExpression(expr)) return calleeName(expr.expression);
  return null;
}

function signatureOf(sf: ts.SourceFile, node: ts.SignatureDeclaration): string {
  const params = node.parameters.map((p) => text(sf, p).replace(/\s+/g, " ")).join(", ");
  const ret = node.type ? `: ${text(sf, node.type)}` : "";
  return `(${params})${ret}`;
}

function stringArg(node: ts.CallExpression): string | null {
  const a = node.arguments[0];
  if (!a) return null;
  if (ts.isStringLiteral(a) || ts.isNoSubstitutionTemplateLiteral(a)) return a.text;
  return null;
}

/** `it(`, `test(`, `it.only(`, `test.skip(`, `it.each(...)(`: the base identifier when it is a test block. */
function testBlockName(node: ts.CallExpression): "it" | "test" | null {
  let e: ts.Expression = node.expression;
  if (ts.isCallExpression(e)) e = e.expression; // it.each([...])("title")
  while (ts.isPropertyAccessExpression(e)) e = e.expression;
  if (ts.isIdentifier(e) && (e.text === "it" || e.text === "test")) return e.text;
  return null;
}

export function extractTsFile(rel: string, source: string, files: Set<string>, aliases: PathAlias[], out: TsExtraction): void {
  const kind = rel.endsWith(".tsx") || rel.endsWith(".jsx") ? ts.ScriptKind.TSX : /\.[cm]?js$/.test(rel) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(rel, source, ts.ScriptTarget.Latest, true, kind);
  const diagnostics = (sf as unknown as { parseDiagnostics?: ts.Diagnostic[] }).parseDiagnostics ?? [];
  if (diagnostics.length) {
    const d = diagnostics[0]!;
    out.skipped.push({ path: rel, reason: `syntax error: ${ts.flattenDiagnosticMessageText(d.messageText, " ")} (line ${d.start !== undefined ? lineOf(sf, d.start) : "?"})` });
    return;
  }
  const module = tsModuleName(rel);
  const isTestFile = isJsTestFile(rel);
  const seen = new Map<string, number>();
  const unique = (base: string): string => {
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return n === 0 ? base : `${base}#${n + 1}`;
  };
  out.symbols.push({ id: `MOD:${module}`, kind: "module", qualified_name: module, name: path.posix.basename(module), path: rel, line_start: 1, line_end: lineOf(sf, sf.end), docstring: jsDoc(sf.statements[0] ?? sf) ?? null, parent: null, decorators: [], bases: [], is_test: isTestFile, signature: null });

  const addImport = (spec: string, names: string[], line: number) => {
    const resolved = resolveSpecifier(spec, rel, files, aliases);
    out.imports.push({ from_module: module, to_module: resolved ? tsModuleName(resolved) : spec, path: rel, line, names, resolved_internal: !!resolved });
  };
  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier)) {
      const names: string[] = [];
      const c = st.importClause;
      if (c?.name) names.push(c.name.text);
      if (c?.namedBindings) {
        if (ts.isNamespaceImport(c.namedBindings)) names.push(`* as ${c.namedBindings.name.text}`);
        else for (const el of c.namedBindings.elements) names.push(el.name.text);
      }
      addImport(st.moduleSpecifier.text, names, lineOf(sf, st.getStart(sf)));
    } else if (ts.isExportDeclaration(st) && st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier)) {
      const names = st.exportClause && ts.isNamedExports(st.exportClause) ? st.exportClause.elements.map((e) => e.name.text) : ["*"];
      addImport(st.moduleSpecifier.text, names, lineOf(sf, st.getStart(sf)));
    } else if (ts.isVariableStatement(st)) {
      // const x = require("y")
      for (const d of st.declarationList.declarations) {
        if (d.initializer && ts.isCallExpression(d.initializer) && ts.isIdentifier(d.initializer.expression) && d.initializer.expression.text === "require") {
          const spec = stringArg(d.initializer);
          if (spec) addImport(spec, [text(sf, d.name)], lineOf(sf, st.getStart(sf)));
        }
      }
    }
  }

  const recordCalls = (sym: RawSymbol, body: ts.Node) => {
    const walk = (n: ts.Node) => {
      if (ts.isCallExpression(n)) {
        const callee = calleeName(n.expression);
        if (callee) out.calls.push({ from_symbol: sym.id, callee, path: rel, line: lineOf(sf, n.getStart(sf)), extraction_method: "syntactic_name", confidence: 0.4 });
      }
      if (ts.isNewExpression(n)) {
        const callee = calleeName(n.expression);
        if (callee) out.calls.push({ from_symbol: sym.id, callee, path: rel, line: lineOf(sf, n.getStart(sf)), extraction_method: "syntactic_name", confidence: 0.4 });
      }
      ts.forEachChild(n, walk);
    };
    ts.forEachChild(body, walk);
  };
  const decoratorsOf = (node: ts.Node): string[] => (ts.canHaveDecorators(node) ? (ts.getDecorators(node) ?? []).map((d) => text(sf, d.expression)) : []);

  const addFunction = (name: string, node: ts.SignatureDeclaration & { body?: ts.Node }, parentQn: string | null, kind: RawSymbol["kind"]) => {
    const qn = parentQn ? `${parentQn}.${name}` : `${module}.${name}`;
    const sym: RawSymbol = { id: unique(`SY:${qn}`), kind, qualified_name: qn, name, path: rel, line_start: lineOf(sf, node.getStart(sf)), line_end: lineOf(sf, node.end), docstring: jsDoc(node), parent: parentQn, decorators: decoratorsOf(node), bases: [], is_test: false, signature: signatureOf(sf, node) };
    out.symbols.push(sym);
    if (node.body) recordCalls(sym, node.body);
  };
  const addClassLike = (node: ts.ClassDeclaration | ts.InterfaceDeclaration | ts.EnumDeclaration | ts.TypeAliasDeclaration, kind: RawSymbol["kind"]) => {
    const name = node.name?.text ?? "default";
    const qn = `${module}.${name}`;
    const bases: string[] = [];
    if (ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node)) for (const h of node.heritageClauses ?? []) for (const t of h.types) bases.push(text(sf, t.expression));
    out.symbols.push({ id: unique(`SY:${qn}`), kind, qualified_name: qn, name, path: rel, line_start: lineOf(sf, node.getStart(sf)), line_end: lineOf(sf, node.end), docstring: jsDoc(node), parent: null, decorators: decoratorsOf(node), bases, is_test: false, signature: null });
    if (ts.isClassDeclaration(node)) {
      for (const m of node.members) {
        if ((ts.isMethodDeclaration(m) || ts.isGetAccessor(m) || ts.isSetAccessor(m) || ts.isConstructorDeclaration(m)) && (ts.isConstructorDeclaration(m) || ts.isIdentifier(m.name) || ts.isStringLiteral(m.name))) {
          const mname = ts.isConstructorDeclaration(m) ? "constructor" : (m.name as ts.Identifier | ts.StringLiteral).text;
          addFunction(mname, m, qn, "method");
        } else if (ts.isPropertyDeclaration(m) && m.initializer && (ts.isArrowFunction(m.initializer) || ts.isFunctionExpression(m.initializer)) && ts.isIdentifier(m.name)) {
          addFunction(m.name.text, m.initializer, qn, "method");
        }
      }
    }
  };

  const topLevelCalls: RawSymbol = { id: `SY:${module}.<module>`, kind: "function", qualified_name: `${module}.<module>`, name: "<module>", path: rel, line_start: 1, line_end: 1, docstring: null, parent: null, decorators: [], bases: [], is_test: false, signature: null };
  let hasTopLevelCalls = false;
  for (const st of sf.statements) {
    if (ts.isFunctionDeclaration(st) && st.name) addFunction(st.name.text, st, null, "function");
    else if (ts.isClassDeclaration(st)) addClassLike(st, "class");
    else if (ts.isInterfaceDeclaration(st)) addClassLike(st, "interface");
    else if (ts.isTypeAliasDeclaration(st)) addClassLike(st, "type");
    else if (ts.isEnumDeclaration(st)) addClassLike(st, "enum");
    else if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && d.initializer && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer))) addFunction(d.name.text, d.initializer, null, "function");
        else if (d.initializer && !(ts.isCallExpression(d.initializer) && ts.isIdentifier(d.initializer.expression) && d.initializer.expression.text === "require")) {
          hasTopLevelCalls = true;
          recordCalls(topLevelCalls, d.initializer);
        }
      }
    } else if (ts.isExpressionStatement(st)) {
      hasTopLevelCalls = true;
      recordCalls(topLevelCalls, st);
    }
  }
  if (hasTopLevelCalls && out.calls.some((c) => c.from_symbol === topLevelCalls.id)) out.symbols.push({ ...topLevelCalls, line_end: lineOf(sf, sf.end) });

  if (isTestFile) {
    const describes: string[] = [];
    const visit = (n: ts.Node) => {
      if (ts.isCallExpression(n)) {
        const title = stringArg(n);
        let base: ts.Expression = n.expression;
        if (ts.isCallExpression(base)) base = base.expression;
        while (ts.isPropertyAccessExpression(base)) base = base.expression;
        if (ts.isIdentifier(base) && base.text === "describe" && title) {
          describes.push(title);
          ts.forEachChild(n, visit);
          describes.pop();
          return;
        }
        if (testBlockName(n) && title) {
          const line = lineOf(sf, n.getStart(sf));
          const qn = `${module}.${[...describes, title].join(" > ")}`;
          // parent is the module: titles may contain dots, so the graph builder must not derive the owner from the qualified name.
          out.symbols.push({ id: unique(`SY:${qn}`), kind: "function", qualified_name: qn, name: title, path: rel, line_start: line, line_end: lineOf(sf, n.end), docstring: describes.length ? describes.join(" > ") : null, parent: module, decorators: [], bases: [], is_test: true, signature: null });
          out.tests.push({ id: unique(`TEST:${rel}::${title}`), path: rel, name: title, line, module });
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
}

/** Extract every tracked TypeScript/JavaScript file (or only `onlyFiles`), in `git ls-files` order. */
export function extractTypeScript(repoPath: string, trackedFiles: string[], opts: { onlyFiles?: string[]; maxFileBytes?: number } = {}): TsExtraction {
  const out: TsExtraction = { modules: [], symbols: [], imports: [], calls: [], tests: [], skipped: [] };
  const sources = trackedFiles.filter((f) => isJsSourceFile(f) && !f.split("/").includes("node_modules"));
  out.modules = sources.map(tsModuleName).sort();
  const files = new Set(trackedFiles);
  const aliases = readPathAliases(repoPath);
  const wanted = opts.onlyFiles ? new Set(opts.onlyFiles) : null;
  const max = opts.maxFileBytes ?? 1_500_000;
  for (const rel of sources) {
    if (wanted && !wanted.has(rel)) continue;
    const full = path.join(repoPath, rel);
    let size: number;
    try {
      size = fs.statSync(full).size;
    } catch (e) {
      out.skipped.push({ path: rel, reason: (e as Error).message });
      continue;
    }
    if (size > max) {
      out.skipped.push({ path: rel, reason: `file too large (${size} bytes)` });
      continue;
    }
    try {
      extractTsFile(rel, fs.readFileSync(full, "utf8"), files, aliases, out);
    } catch (e) {
      out.skipped.push({ path: rel, reason: `extraction failed: ${(e as Error).message}` });
    }
  }
  return out;
}
