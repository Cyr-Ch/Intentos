import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import type { PolicyArchitectureRule } from "../knowledge/policy.ts";
import { isJsSourceFile } from "../knowledge/js.ts";
import { readPathAliases, resolveSpecifier, tsModuleName } from "../knowledge/ts_extract.ts";
import { matchesAny } from "../util/paths.ts";

/**
 * Deterministic architecture rule checks over a TypeScript/JavaScript source tree, the counterpart of
 * `python/architecture_rules.py`, with the same rule kinds and the same output shape:
 *
 *   forbidden_import: files matching `paths` may not import any of `forbidden_modules`. A forbidden module matches a
 *                     package specifier exactly or by prefix (`node:child_process`, `lodash/fp`, `@scope/pkg`), or a
 *                     repository path (`src/db`, `src/db/client.ts`) that a relative or aliased import resolves to.
 *   forbidden_call:   files matching `paths` (minus `allowed_paths`) may not call a callee whose dotted name ends with
 *                     one of `forbidden_callees` (`fetch`, `child_process.exec`, `process.exit`).
 *   required_import:  files matching `paths` that define functions must import one of `required_modules`.
 *   forbidden_names:  files matching `paths` may not reference a dotted name in `forbidden_names` (`process.env`,
 *                     `globalThis.fetch`) nor contain a string literal listed in `forbidden_literals`.
 *   frozen_paths:     evaluated from the Git diff by the verifier, not here.
 */

export interface TsRuleFinding {
  rule_id: string;
  kind: string;
  path: string;
  line: number;
  message: string;
  in_changed_file: boolean;
}

export interface TsRulesOutput {
  findings: TsRuleFinding[];
  checked_files: number;
  errors: Array<{ path: string; error: string }>;
}

const SKIP_DIRS = new Set([".git", ".intentos", "node_modules", "dist", "build", "coverage", ".intentos_hidden", ".next", ".turbo", "__pycache__", ".venv"]);

function listSources(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(full);
      } else if (e.isFile() && isJsSourceFile(e.name)) out.push(path.relative(root, full).split(path.sep).join("/"));
    }
  };
  walk(root);
  return out.sort();
}

/** `node:child_process` and `child_process` are the same module; `pkg/sub` is covered by `pkg`. */
function specifierMatches(spec: string, forbidden: string): boolean {
  const norm = (s: string) => s.replace(/^node:/, "");
  const a = norm(spec);
  const b = norm(forbidden);
  return a === b || a.startsWith(`${b}/`);
}

function moduleImports(sf: ts.SourceFile): Array<{ spec: string; line: number }> {
  const out: Array<{ spec: string; line: number }> = [];
  const line = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier)) out.push({ spec: st.moduleSpecifier.text, line: line(st) });
    else if (ts.isExportDeclaration(st) && st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier)) out.push({ spec: st.moduleSpecifier.text, line: line(st) });
    else if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        const init = d.initializer;
        if (init && ts.isCallExpression(init) && ts.isIdentifier(init.expression) && init.expression.text === "require" && init.arguments[0] && ts.isStringLiteral(init.arguments[0])) out.push({ spec: init.arguments[0].text, line: line(st) });
      }
    }
  }
  // dynamic import("x") and require("x") anywhere in the file count as imports too
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n) && n.arguments[0] && ts.isStringLiteral(n.arguments[0])) {
      if (n.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(n.expression) && n.expression.text === "require")) {
        const spec = n.arguments[0].text;
        if (!out.some((o) => o.spec === spec && o.line === line(n))) out.push({ spec, line: line(n) });
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

function dotted(expr: ts.Expression): string | null {
  if (ts.isIdentifier(expr)) return expr.text;
  if (expr.kind === ts.SyntaxKind.ThisKeyword) return "this";
  if (ts.isPropertyAccessExpression(expr)) {
    const left = dotted(expr.expression);
    return left ? `${left}.${expr.name.text}` : null;
  }
  if (ts.isNonNullExpression(expr) || ts.isParenthesizedExpression(expr) || ts.isAsExpression(expr)) return dotted(expr.expression);
  return null;
}

/** Local names bound by imports → the module they come from, so `import { exec } from "node:child_process"` canonicalises `exec` to `child_process.exec`. */
function importAliases(sf: ts.SourceFile): Map<string, string> {
  const map = new Map<string, string>();
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier) || !st.importClause) continue;
    const mod = st.moduleSpecifier.text.replace(/^node:/, "");
    if (st.importClause.name) map.set(st.importClause.name.text, mod);
    const nb = st.importClause.namedBindings;
    if (nb) {
      if (ts.isNamespaceImport(nb)) map.set(nb.name.text, mod);
      else for (const el of nb.elements) map.set(el.name.text, `${mod}.${(el.propertyName ?? el.name).text}`);
    }
  }
  return map;
}

function canonical(name: string, aliases: Map<string, string>): string {
  const [head, ...rest] = name.split(".");
  const target = aliases.get(head!);
  return target ? [target, ...rest].join(".") : name;
}

function hasFunctions(sf: ts.SourceFile): boolean {
  let found = false;
  const visit = (n: ts.Node) => {
    if (found) return;
    if (ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n) || ts.isArrowFunction(n) || ts.isFunctionExpression(n)) found = true;
    else ts.forEachChild(n, visit);
  };
  visit(sf);
  return found;
}

export function runTsArchitectureRules(root: string, rules: PolicyArchitectureRule[], changedFiles: string[]): TsRulesOutput {
  const findings: TsRuleFinding[] = [];
  const errors: TsRulesOutput["errors"] = [];
  const files = listSources(root);
  const fileSet = new Set(files);
  const aliases = readPathAliases(root);
  const changed = new Set(changedFiles);
  const sources = new Map<string, ts.SourceFile>();
  const wanted = new Set(files.filter((f) => rules.some((r) => r.kind !== "frozen_paths" && matchesAny(f, r.paths.length ? r.paths : ["**"]))));
  for (const rel of files) {
    if (!wanted.has(rel)) continue;
    try {
      const text = fs.readFileSync(path.join(root, rel), "utf8");
      const kind = rel.endsWith("x") ? ts.ScriptKind.TSX : /\.[cm]?js$/.test(rel) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
      const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, kind);
      const diag = (sf as unknown as { parseDiagnostics?: ts.Diagnostic[] }).parseDiagnostics ?? [];
      if (diag.length) {
        errors.push({ path: rel, error: `syntax error: ${ts.flattenDiagnosticMessageText(diag[0]!.messageText, " ")}` });
        continue;
      }
      sources.set(rel, sf);
    } catch (e) {
      errors.push({ path: rel, error: (e as Error).message });
    }
  }
  const lineOf = (sf: ts.SourceFile, n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;

  for (const rule of rules) {
    const paths = rule.paths.length ? rule.paths : ["**"];
    const targets = [...sources.keys()].filter((f) => matchesAny(f, paths));
    const add = (rel: string, line: number, message: string) => findings.push({ rule_id: rule.id, kind: rule.kind, path: rel, line, message, in_changed_file: changed.has(rel) });
    if (rule.kind === "forbidden_import") {
      for (const rel of targets) {
        for (const imp of moduleImports(sources.get(rel)!)) {
          const resolved = resolveSpecifier(imp.spec, rel, fileSet, aliases);
          const resolvedModule = resolved ? tsModuleName(resolved) : null;
          for (const forb of rule.forbidden_modules) {
            const asPath = forb.replace(/\/\*\*$/, "").replace(/\/$/, "");
            const hit = specifierMatches(imp.spec, forb) || (resolved !== null && (resolved === asPath || resolvedModule === tsModuleName(asPath) || resolved.startsWith(`${asPath}/`)));
            if (hit) add(rel, imp.line, `${rel}:${imp.line} imports '${imp.spec}'${resolved && resolved !== imp.spec ? ` (${resolved})` : ""} which is forbidden for ${paths.join(", ")} (${rule.id})`);
          }
        }
      }
    } else if (rule.kind === "forbidden_call") {
      for (const rel of targets) {
        if (matchesAny(rel, rule.allowed_paths)) continue;
        const sf = sources.get(rel)!;
        const aliasMap = importAliases(sf);
        const visit = (n: ts.Node) => {
          if (ts.isCallExpression(n) || ts.isNewExpression(n)) {
            const name = dotted(n.expression);
            if (name) {
              const canon = canonical(name, aliasMap);
              const last = name.split(".").pop()!;
              if (rule.forbidden_callees.some((c) => last === c || name === c || name.endsWith(`.${c}`) || canon === c || canon.endsWith(`.${c}`))) add(rel, lineOf(sf, n), `${rel}:${lineOf(sf, n)} calls '${name}', which may only be called from ${rule.allowed_paths.join(", ") || "nowhere"} (${rule.id})`);
            }
          }
          ts.forEachChild(n, visit);
        };
        visit(sf);
      }
    } else if (rule.kind === "required_import") {
      for (const rel of targets) {
        const sf = sources.get(rel)!;
        if (!hasFunctions(sf)) continue;
        const imported = moduleImports(sf);
        const ok = imported.some((imp) => {
          const resolved = resolveSpecifier(imp.spec, rel, fileSet, aliases);
          return rule.required_modules.some((r) => specifierMatches(imp.spec, r) || (resolved !== null && (resolved === r || tsModuleName(resolved) === tsModuleName(r) || resolved.startsWith(`${r.replace(/\/\*\*$/, "")}/`))));
        });
        if (!ok) add(rel, 1, `${rel} must import one of ${rule.required_modules.join(", ")} (${rule.id})`);
      }
    } else if (rule.kind === "forbidden_names") {
      const literals = (rule as { forbidden_literals?: string[] }).forbidden_literals?.map((l) => l.toLowerCase()) ?? [];
      for (const rel of targets) {
        const sf = sources.get(rel)!;
        const aliasMap = importAliases(sf);
        const visit = (n: ts.Node) => {
          if (ts.isPropertyAccessExpression(n) || ts.isIdentifier(n)) {
            const name = dotted(n as ts.Expression);
            if (name) {
              const canon = canonical(name, aliasMap);
              if (rule.forbidden_names.some((f) => canon === f || canon.endsWith(`.${f}`) || name === f || name.endsWith(`.${f}`))) {
                add(rel, lineOf(sf, n), `${rel}:${lineOf(sf, n)} references '${name}' (${canon}), forbidden for ${paths.join(", ")} (${rule.id})`);
                return; // the inner identifiers of a.b.c would report again
              }
            }
          } else if ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) && literals.length) {
            const low = n.text.toLowerCase();
            if (literals.some((l) => low.includes(l))) add(rel, lineOf(sf, n), `${rel}:${lineOf(sf, n)} contains literal ${JSON.stringify(n.text)}, forbidden for ${paths.join(", ")} (${rule.id})`);
          }
          ts.forEachChild(n, visit);
        };
        visit(sf);
      }
    } else if (rule.kind !== "frozen_paths") errors.push({ path: "", error: `unknown rule kind ${rule.kind} for ${rule.id}` });
  }
  return { findings, checked_files: sources.size, errors };
}
