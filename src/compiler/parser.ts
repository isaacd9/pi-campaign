import ts from "typescript";
import { CampaignCompileError, type CompileDiagnostic, type SourceRange } from "./diagnostics.ts";

export interface ParsedCall { $call: string; args: ParsedValue[]; range: SourceRange }
export type ParsedValue = null | boolean | number | string | ParsedValue[] | { [key: string]: ParsedValue } | ParsedCall;
export interface ParsedCampaignSource { definition: ParsedCall; sourceFile: ts.SourceFile }
const ALLOWED_IMPORTS = new Set(["defineCampaign", "sequence", "parallel", "task", "map", "branch", "repeatUntil", "gate", "checkpoint", "emit", "aggregate", "ref", "template", "commandGate", "schemaGate", "artifactGate", "predicateGate", "approvalGate", "reviewGate", "acceptanceGate", "safetyGate", "budgetGate"]);

export function parseCampaignSource(source: string, fileName = "campaign.ts"): ParsedCampaignSource {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);
  const parseDiagnostics = (sf as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics ?? [];
  const diagnostics: CompileDiagnostic[] = parseDiagnostics.map((diag: ts.Diagnostic) => ({ code: "syntax", message: ts.flattenDiagnosticMessageText(diag.messageText, "\n"), range: range(sf, diag.start ?? 0, (diag.start ?? 0) + (diag.length ?? 1)) }));
  const aliases = new Map<string, string>();
  let exported: ts.Expression | undefined;
  for (const statement of sf.statements) {
    if (ts.isImportDeclaration(statement)) {
      if (!ts.isStringLiteral(statement.moduleSpecifier) || statement.moduleSpecifier.text !== "pi-campaign/dsl") {
        diagnostics.push(error(sf, statement, "unsafe-import", "Campaigns may import only from pi-campaign/dsl.", "Remove filesystem, network, and runtime imports."));
        continue;
      }
      const clause = statement.importClause;
      if (!clause || clause.name || !clause.namedBindings || !ts.isNamedImports(clause.namedBindings)) {
        diagnostics.push(error(sf, statement, "invalid-import", "Use named DSL imports only."));
        continue;
      }
      for (const specifier of clause.namedBindings.elements) {
        const original = specifier.propertyName?.text ?? specifier.name.text;
        if (!ALLOWED_IMPORTS.has(original)) diagnostics.push(error(sf, specifier, "unknown-import", `Unknown campaign DSL import '${original}'.`));
        else aliases.set(specifier.name.text, original);
      }
      continue;
    }
    if (ts.isExportAssignment(statement) && !statement.isExportEquals && !exported) { exported = statement.expression; continue; }
    diagnostics.push(error(sf, statement, "unsupported-statement", "Only DSL imports and one `export default defineCampaign(...)` are allowed."));
  }
  if (!exported) diagnostics.push({ code: "missing-export", message: "Expected one `export default defineCampaign({...})`." });
  if (diagnostics.length) throw new CampaignCompileError(diagnostics);
  const value = parseExpression(exported!, sf, aliases, diagnostics);
  if (!isCall(value) || value.$call !== "defineCampaign") diagnostics.push(error(sf, exported!, "invalid-export", "Default export must be defineCampaign({...})."));
  if (diagnostics.length) throw new CampaignCompileError(diagnostics);
  return { definition: value as ParsedCall, sourceFile: sf };
}

function parseExpression(node: ts.Expression, sf: ts.SourceFile, aliases: Map<string, string>, diagnostics: CompileDiagnostic[]): ParsedValue {
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) || ts.isSatisfiesExpression(node)) return parseExpression(node.expression, sf, aliases, diagnostics);
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isNumericLiteral(node)) return Number(node.text.replaceAll("_", ""));
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (node.kind === ts.SyntaxKind.NullKeyword) return null;
  if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(node.operand)) return -Number(node.operand.text.replaceAll("_", ""));
  if (ts.isArrayLiteralExpression(node)) return node.elements.map((element) => {
    if (ts.isSpreadElement(element)) { diagnostics.push(error(sf, element, "spread-rejected", "Spread syntax is not allowed.")); return null; }
    return parseExpression(element, sf, aliases, diagnostics);
  });
  if (ts.isObjectLiteralExpression(node)) {
    const output: Record<string, ParsedValue> = Object.create(null) as Record<string, ParsedValue>;
    for (const prop of node.properties) {
      if (!ts.isPropertyAssignment(prop) || prop.name && ts.isComputedPropertyName(prop.name)) { diagnostics.push(error(sf, prop, "property-rejected", "Use explicit, non-computed object properties.")); continue; }
      const key = propertyName(prop.name);
      if (!key) { diagnostics.push(error(sf, prop, "property-rejected", "Object property name must be an identifier or string.")); continue; }
      if (["__proto__", "prototype", "constructor"].includes(key)) { diagnostics.push(error(sf, prop, "property-rejected", `Unsafe property name '${key}' is not allowed.`)); continue; }
      if (Object.hasOwn(output, key)) diagnostics.push(error(sf, prop, "duplicate-property", `Duplicate property '${key}'.`));
      output[key] = parseExpression(prop.initializer, sf, aliases, diagnostics);
    }
    return output;
  }
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
    const name = aliases.get(node.expression.text);
    if (!name) { diagnostics.push(error(sf, node, "call-rejected", `Call '${node.expression.text}' is not an imported campaign DSL combinator.`)); return null; }
    if (node.typeArguments?.length) diagnostics.push(error(sf, node, "type-arguments-rejected", "DSL calls do not accept runtime type arguments."));
    if (node.arguments.length !== 1) diagnostics.push(error(sf, node, "invalid-arity", `${name} expects exactly one argument.`));
    return { $call: name, args: node.arguments.map((arg) => parseExpression(arg, sf, aliases, diagnostics)), range: range(sf, node.getStart(sf), node.getEnd()) };
  }
  diagnostics.push(error(sf, node, "expression-rejected", `Unsupported syntax '${ts.SyntaxKind[node.kind]}'. Campaign source is declarative and is never executed.`));
  return null;
}
function propertyName(name: ts.PropertyName): string | undefined { return ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name) ? name.text : undefined; }
export function isCall(value: unknown): value is ParsedCall { return value !== null && value !== undefined && typeof value === "object" && !Array.isArray(value) && "$call" in value; }
function range(sf: ts.SourceFile, start: number, end: number): SourceRange { const pos = sf.getLineAndCharacterOfPosition(start); return { start, end, line: pos.line + 1, column: pos.character + 1 }; }
function error(sf: ts.SourceFile, node: ts.Node, code: string, message: string, hint?: string): CompileDiagnostic { return { code, message, range: range(sf, node.getStart(sf), node.getEnd()), ...(hint ? { hint } : {}) }; }
