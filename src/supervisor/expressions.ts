import type { Predicate, ValueExpression } from "../dsl/types.ts";
export interface ExpressionContext { input?: unknown; item?: unknown; round?: number; outputs: Record<string, unknown> }
export function resolveExpression(value: ValueExpression | unknown, context: ExpressionContext): unknown {
  if (Array.isArray(value)) return value.map((item) => resolveExpression(item, context));
  if (!value || typeof value !== "object") return value;
  if ("$ref" in value && typeof (value as { $ref: unknown }).$ref === "string") return getPath(context, (value as { $ref: string }).$ref);
  if ("$template" in value && typeof (value as { $template: unknown }).$template === "string") return (value as { $template: string }).$template.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_all, path: string) => stringify(getPath(context, path)));
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, resolveExpression(child, context)]));
}
export function evaluatePredicate(predicate: Predicate, context: ExpressionContext): boolean {
  switch (predicate.op) {
    case "truthy": return Boolean(resolveExpression(predicate.value, context));
    case "not": return !evaluatePredicate(predicate.item, context);
    case "and": return predicate.items.every((item) => evaluatePredicate(item, context));
    case "or": return predicate.items.some((item) => evaluatePredicate(item, context));
    default: { const left = resolveExpression(predicate.left, context) as never; const right = resolveExpression(predicate.right, context) as never; switch (predicate.op) { case "eq": return Object.is(left, right); case "ne": return !Object.is(left, right); case "lt": return left < right; case "lte": return left <= right; case "gt": return left > right; case "gte": return left >= right; } }
  }
}
function getPath(context: ExpressionContext, path: string): unknown { const parts = path.split("."); const first = parts.shift()!; let value: unknown = first === "input" ? context.input : first === "item" ? context.item : first === "round" ? context.round : context.outputs[first]; if (parts[0] === "output") parts.shift(); for (const part of parts) { if (value === null || value === undefined) return undefined; if (Array.isArray(value) && /^\d+$/.test(part)) value = value[Number(part)]; else if (typeof value === "object" && Object.hasOwn(value, part)) value = (value as Record<string, unknown>)[part]; else return undefined; } return value; }
function stringify(value: unknown): string { return typeof value === "string" ? value : value === undefined ? "" : JSON.stringify(value); }
