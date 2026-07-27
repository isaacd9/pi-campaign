import type { CampaignEdge, CampaignIR, CampaignNode, FailureAction, GateCheck, HardCaps, Predicate, ValueExpression } from "../dsl/types.ts";
import { DEFAULT_HARD_CAPS } from "../dsl/types.ts";
import { sha256, stableStringify } from "../shared/json.ts";
import { CampaignCompileError, type CompileDiagnostic } from "./diagnostics.ts";
import { isCall, parseCampaignSource, type ParsedCall, type ParsedValue } from "./parser.ts";
import { validateIR } from "./validator.ts";
export * from "./diagnostics.ts";
export * from "./parser.ts";
export * from "./validator.ts";

export interface CompileResult { ir: CampaignIR; summary: string; irHash: string }
export function compileCampaign(source: string, options: { fileName?: string; hardCaps?: HardCaps; availableModels?: string[] } = {}): CompileResult {
  const parsed = parseCampaignSource(source, options.fileName);
  if (parsed.definition.args.length !== 1 || !isObject(parsed.definition.args[0])) throw new CampaignCompileError([{ code: "invalid-definition", message: "defineCampaign expects one object literal." }]);
  const definition = parsed.definition.args[0];
  const diagnostics: CompileDiagnostic[] = [];
  rejectUnknownKeys(definition, new Set(["meta", "limits", "inputSchema", "program"]), "defineCampaign", diagnostics, parsed.definition.range);
  const meta = object(definition.meta, "meta", diagnostics);
  rejectUnknownKeys(meta, new Set(["name", "description", "version"]), "meta", diagnostics, parsed.definition.range);
  const limits = object(definition.limits, "limits", diagnostics);
  rejectUnknownKeys(limits, new Set(["maxAgents", "maxConcurrency", "maxRounds", "maxTokens", "timeoutMs"]), "limits", diagnostics, parsed.definition.range);
  if (definition.inputSchema !== undefined && !isObject(definition.inputSchema)) diagnostics.push({ code: "invalid-schema", message: "inputSchema must be an object literal.", range: parsed.definition.range });
  if (meta.description !== undefined && typeof meta.description !== "string") diagnostics.push({ code: "invalid-description", message: "meta.description must be a string.", range: parsed.definition.range });
  const builder = new Builder(diagnostics);
  if (!isCall(definition.program)) diagnostics.push({ code: "missing-program", message: "Campaign program must be a DSL combinator call." });
  const root = isCall(definition.program) ? builder.add(definition.program) : "invalid";
  const ir: CampaignIR = {
    irVersion: 1,
    sourceHash: sha256(source.replaceAll("\r\n", "\n")),
    meta: { name: string(meta.name, "meta.name", diagnostics), ...(typeof meta.description === "string" ? { description: meta.description } : {}), version: integer(meta.version, "meta.version", diagnostics) },
    ...(isObject(definition.inputSchema) ? { inputSchema: plain(definition.inputSchema) as Record<string, unknown> } : {}),
    limits: {
      maxAgents: integer(limits.maxAgents, "limits.maxAgents", diagnostics), maxConcurrency: integer(limits.maxConcurrency, "limits.maxConcurrency", diagnostics),
      maxRounds: integer(limits.maxRounds, "limits.maxRounds", diagnostics), maxTokens: integer(limits.maxTokens, "limits.maxTokens", diagnostics),
      ...(typeof limits.timeoutMs === "number" ? { timeoutMs: limits.timeoutMs } : {}),
    },
    root, nodes: builder.nodes, edges: builder.edges, outputs: builder.outputs,
  };
  if (options.availableModels) for (const node of ir.nodes) if (node.kind === "agent-task" && node.model && !options.availableModels.includes(node.model) && !node.fallbackModels?.some((model) => options.availableModels!.includes(model))) diagnostics.push({ code: "unavailable-model", message: `Node '${node.id}' hardcodes unavailable model '${node.model}' without an available fallback.`, ...(builder.ranges.get(node.id) ? { range: builder.ranges.get(node.id)! } : {}) });
  diagnostics.push(...validateIR(ir, options.hardCaps ?? DEFAULT_HARD_CAPS).map((diagnostic) => {
    if (diagnostic.range) return diagnostic;
    const quotedId = diagnostic.message.match(/'([^']+)'/)?.[1];
    return { ...diagnostic, range: quotedId ? builder.ranges.get(quotedId) ?? parsed.definition.range : parsed.definition.range };
  }));
  if (diagnostics.length) throw new CampaignCompileError(diagnostics);
  const counts = Object.fromEntries([...new Set(ir.nodes.map((node) => node.kind))].sort().map((kind) => [kind, ir.nodes.filter((node) => node.kind === kind).length]));
  return { ir, summary: `${ir.meta.name}: ${ir.nodes.length} nodes (${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(", ")}); limits ${ir.limits.maxAgents} agents / ${ir.limits.maxConcurrency} concurrent / ${ir.limits.maxRounds} rounds`, irHash: sha256(stableStringify(ir)) };
}

class Builder {
  nodes: CampaignNode[] = []; edges: CampaignEdge[] = []; outputs: CampaignIR["outputs"] = {}; ranges = new Map<string, ParsedCall["range"]>(); private generated = new Map<string, number>();
  constructor(private diagnostics: CompileDiagnostic[]) {}
  add(call: ParsedCall): string {
    const config = this.config(call); const explicit = typeof config.id === "string" ? config.id : undefined;
    const id = explicit ?? this.generate(call.$call === "task" ? "task" : call.$call.toLowerCase());
    this.ranges.set(id, call.range);
    const common = { id, ...(typeof config.label === "string" ? { label: config.label } : {}) };
    let node: CampaignNode;
    switch (call.$call) {
      case "task": {
        node = { ...common, kind: "agent-task", agent: string(config.agent, `${id}.agent`, this.diagnostics), prompt: expression(config.prompt), ...(isObject(config.output) ? { outputSchema: plain(config.output) as Record<string, unknown> } : {}), capabilities: stringArray(config.capabilities), recovery: recovery(config.recovery, this.diagnostics, `${id}.recovery`, stringArray(config.capabilities).includes("code-write") || ["worker", "implementer"].includes(String(config.agent))), ...(typeof config.model === "string" ? { model: config.model } : {}), ...(Array.isArray(config.fallbackModels) ? { fallbackModels: stringArray(config.fallbackModels) } : {}), ...(typeof config.thinking === "string" ? { thinking: config.thinking as never } : {}), ...(isObject(config.acceptance) ? { acceptance: plain(config.acceptance) as Record<string, unknown> } : {}), ...(config.isolation === "worktree" ? { isolation: "worktree" } : {}) };
        this.outputs[id] = { nodeId: id, ...(node.outputSchema ? { schema: node.outputSchema } : {}) }; break;
      }
      case "sequence": {
        const calls = childCalls(config.children ?? call.args[0], `${id}.children`, this.diagnostics); const ids = calls.map((child) => this.add(child)); node = { ...common, kind: "sequence", children: ids }; ids.forEach((to) => this.edges.push({ from: id, to, type: "child" })); break;
      }
      case "parallel": {
        const rawChildren = Array.isArray(call.args[0]) ? call.args[0] : config.children; const calls = childCalls(rawChildren, `${id}.children`, this.diagnostics); const ids = calls.map((child) => this.add(child));
        node = { ...common, kind: "parallel", children: ids, concurrency: optionalInteger(config.concurrency, 4), isolation: config.isolation === "worktree" ? "worktree" : "none" }; ids.forEach((to) => this.edges.push({ from: id, to, type: "child" })); break;
      }
      case "map": { const body = requiredCall(config.body, `${id}.body`, this.diagnostics); const bodyId = this.add(body); node = { ...common, kind: "map", items: expression(config.items), body: bodyId, maxItems: integer(config.maxItems, `${id}.maxItems`, this.diagnostics), concurrency: optionalInteger(config.concurrency, 4), isolation: config.isolation === "worktree" ? "worktree" : "none" }; this.edges.push({ from: id, to: bodyId, type: "body" }); break; }
      case "branch": { const thenCall = requiredCall(config.then, `${id}.then`, this.diagnostics); const thenId = this.add(thenCall); const elseCall = isCall(config.else) ? config.else : undefined; const elseId = elseCall ? this.add(elseCall) : undefined; node = { ...common, kind: "branch", predicate: predicate(config.predicate), then: thenId, ...(elseId ? { else: elseId } : {}) }; this.edges.push({ from: id, to: thenId, type: "then" }); if (elseId) this.edges.push({ from: id, to: elseId, type: "else" }); break; }
      case "repeatUntil": { const body = requiredCall(config.body, `${id}.body`, this.diagnostics); const bodyId = this.add(body); node = { ...common, kind: "loop", body: bodyId, until: predicate(config.until), maxRounds: integer(config.maxRounds, `${id}.maxRounds`, this.diagnostics), ...(typeof config.timeoutMs === "number" ? { timeoutMs: config.timeoutMs } : {}), ...(config.noProgress === true ? { noProgress: true } : {}) }; this.edges.push({ from: id, to: bodyId, type: "body" }); break; }
      case "gate": node = { ...common, kind: "gate", check: gateCheck(config.check, this.diagnostics), overridable: config.overridable === true, ...(typeof config.timeoutMs === "number" ? { timeoutMs: config.timeoutMs } : {}), onFail: failure(config.onFail, this.diagnostics, `${id}.onFail`), onError: failure(config.onError ?? { action: "stop" }, this.diagnostics, `${id}.onError`) }; break;
      case "checkpoint": node = { ...common, kind: "checkpoint", name: typeof config.name === "string" ? config.name : id }; break;
      case "emit": node = { ...common, kind: "emit", message: expression(config.message), final: config.final === true }; break;
      case "aggregate": node = { ...common, kind: "aggregate", inputs: Array.isArray(config.inputs) ? config.inputs.map(expression) : [], reducer: ["array", "object", "concat"].includes(String(config.reducer)) ? config.reducer as "array" : "array", ...(isObject(config.output) ? { outputSchema: plain(config.output) as Record<string, unknown> } : {}) }; this.outputs[id] = { nodeId: id, ...(node.outputSchema ? { schema: node.outputSchema } : {}) }; break;
      default: this.diagnostics.push({ code: "unknown-combinator", message: `Unsupported program combinator '${call.$call}'.`, range: call.range }); node = { ...common, kind: "checkpoint", name: id };
    }
    this.nodes.unshift(node); if (!this.outputs[id]) this.outputs[id] = { nodeId: id }; return id;
  }
  private config(call: ParsedCall): Record<string, ParsedValue> {
    if (call.$call === "checkpoint" && typeof call.args[0] === "string") return { id: call.args[0] };
    if (call.$call === "sequence" && Array.isArray(call.args[0])) return { children: call.args[0] };
    if (call.$call === "parallel" && Array.isArray(call.args[0])) return { children: call.args[0] };
    if (!isObject(call.args[0])) { this.diagnostics.push({ code: "invalid-arguments", message: `${call.$call} expects an object literal.`, range: call.range }); return {}; }
    validateConfigShape(call.$call, call.args[0], this.diagnostics, call.range);
    return call.args[0];
  }
  private generate(prefix: string): string { const next = (this.generated.get(prefix) ?? 0) + 1; this.generated.set(prefix, next); return `${prefix}-${next}`; }
}

function plain(value: ParsedValue | undefined): unknown { if (isCall(value)) return callValue(value); if (Array.isArray(value)) return value.map(plain); if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, plain(v)])); return value; }
function callValue(call: ParsedCall): unknown {
  if (call.$call === "ref") return { $ref: call.args[0] };
  if (call.$call === "template") return { $template: call.args[0] };
  const suffix = call.$call.endsWith("Gate") ? call.$call.slice(0, -4) : call.$call;
  if (suffix === "predicate") return { type: "predicate", predicate: plain(call.args[0]) };
  return { type: suffix, ...(isObject(call.args[0]) ? plain(call.args[0]) as object : {}) };
}
function expression(value: ParsedValue | undefined): ValueExpression { return plain(value ?? null) as ValueExpression; }
function gateCheck(value: ParsedValue | undefined, diagnostics: CompileDiagnostic[]): GateCheck { const result = plain(value ?? null); if (!isObject(result) || typeof result.type !== "string") { diagnostics.push({ code: "invalid-gate", message: "Gate check must use a gate helper such as commandGate({...})." }); return { type: "predicate", predicate: { op: "truthy", value: false } }; } return result as unknown as GateCheck; }
function predicate(value: ParsedValue | undefined): Predicate { return plain(value ?? { op: "truthy", value: false }) as Predicate; }
function failure(value: ParsedValue | undefined, diagnostics: CompileDiagnostic[], path: string): FailureAction { const objectValue = object(value, path, diagnostics); const action = typeof objectValue.action === "string" ? objectValue.action : "stop"; if (!["stop", "skip", "retry", "repair", "pause"].includes(action)) diagnostics.push({ code: "invalid-failure", message: `${path}.action is invalid.` }); return { action: action as FailureAction["action"], ...(typeof objectValue.maxAttempts === "number" ? { maxAttempts: objectValue.maxAttempts } : {}) }; }
function childCalls(value: ParsedValue | undefined, path: string, diagnostics: CompileDiagnostic[]): ParsedCall[] { if (!Array.isArray(value)) { diagnostics.push({ code: "invalid-children", message: `${path} must be an array.` }); return []; } return value.flatMap((item) => isCall(item) ? [item] : (diagnostics.push({ code: "invalid-child", message: `${path} entries must be DSL calls.` }), [])); }
function requiredCall(value: ParsedValue | undefined, path: string, diagnostics: CompileDiagnostic[]): ParsedCall { if (isCall(value)) return value; diagnostics.push({ code: "missing-child", message: `${path} must be a DSL call.` }); return { $call: "checkpoint", args: [{ id: `invalid-${path}` }], range: { start: 0, end: 0, line: 1, column: 1 } }; }
function isObject(value: unknown): value is Record<string, ParsedValue> { return value !== null && value !== undefined && typeof value === "object" && !Array.isArray(value) && !isCall(value); }
function object(value: ParsedValue | undefined, path: string, diagnostics: CompileDiagnostic[]): Record<string, ParsedValue> { if (isObject(value)) return value; diagnostics.push({ code: "invalid-object", message: `${path} must be an object literal.` }); return {}; }
function string(value: ParsedValue | undefined, path: string, diagnostics: CompileDiagnostic[]): string { if (typeof value === "string" && value) return value; diagnostics.push({ code: "invalid-string", message: `${path} must be a non-empty string.` }); return "invalid"; }
function integer(value: ParsedValue | undefined, path: string, diagnostics: CompileDiagnostic[]): number { if (typeof value === "number" && Number.isInteger(value)) return value; diagnostics.push({ code: "invalid-integer", message: `${path} must be an integer.` }); return 0; }
function optionalInteger(value: ParsedValue | undefined, fallback: number): number { return typeof value === "number" && Number.isInteger(value) ? value : fallback; }
function stringArray(value: ParsedValue | undefined): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []; }
function recovery(value: ParsedValue | undefined, diagnostics: CompileDiagnostic[], path: string, writer: boolean): "safe-retry" | "verify-before-retry" | "restart-from-checkpoint" | "manual" { if (value === undefined) return writer ? "verify-before-retry" : "safe-retry"; if (["safe-retry", "verify-before-retry", "restart-from-checkpoint", "manual"].includes(String(value))) return value as never; diagnostics.push({ code: "invalid-recovery", message: `${path} is not a supported recovery policy.` }); return "verify-before-retry"; }

const CONFIG_KEYS: Record<string, readonly string[]> = {
  task: ["id", "label", "agent", "prompt", "output", "capabilities", "recovery", "model", "fallbackModels", "thinking", "acceptance", "isolation"],
  sequence: ["id", "label", "children"],
  parallel: ["id", "label", "children", "concurrency", "isolation"],
  map: ["id", "label", "items", "body", "maxItems", "concurrency", "isolation"],
  branch: ["id", "label", "predicate", "then", "else"],
  repeatUntil: ["id", "label", "body", "until", "maxRounds", "timeoutMs", "noProgress"],
  gate: ["id", "label", "check", "overridable", "timeoutMs", "onFail", "onError"],
  checkpoint: ["id", "label", "name"],
  emit: ["id", "label", "message", "final"],
  aggregate: ["id", "label", "inputs", "reducer", "output"],
};

function validateConfigShape(kind: string, config: Record<string, ParsedValue>, diagnostics: CompileDiagnostic[], range: ParsedCall["range"]): void {
  rejectUnknownKeys(config, new Set(CONFIG_KEYS[kind] ?? []), kind, diagnostics, range);
  const invalid = (code: string, message: string) => diagnostics.push({ code, message, range });
  if (config.id !== undefined && (typeof config.id !== "string" || !config.id)) invalid("invalid-id", `${kind}.id must be a non-empty string.`);
  if (config.label !== undefined && typeof config.label !== "string") invalid("invalid-label", `${kind}.label must be a string.`);
  if (kind === "task") {
    if (typeof config.agent !== "string" || !config.agent) invalid("invalid-agent", "task.agent must be a non-empty string.");
    if (config.prompt === undefined || !(typeof config.prompt === "string" || (isCall(config.prompt) && ["template", "ref"].includes(config.prompt.$call)))) invalid("invalid-prompt", "task.prompt must be a string, template(...), or ref(...).");
    if (config.output !== undefined && !isObject(config.output)) invalid("invalid-schema", "task.output must be a JSON Schema object.");
    if (config.model !== undefined && typeof config.model !== "string") invalid("invalid-model", "task.model must be a string.");
    if (config.capabilities !== undefined && (!Array.isArray(config.capabilities) || config.capabilities.some((value) => typeof value !== "string"))) invalid("invalid-capabilities", "task.capabilities must be an array of strings.");
    if (config.fallbackModels !== undefined && (!Array.isArray(config.fallbackModels) || config.fallbackModels.some((value) => typeof value !== "string"))) invalid("invalid-fallbacks", "task.fallbackModels must be an array of model strings.");
    if (config.thinking !== undefined && (typeof config.thinking !== "string" || !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(config.thinking))) invalid("invalid-thinking", "task.thinking is not a supported thinking level.");
    if (config.isolation !== undefined && !["none", "worktree"].includes(String(config.isolation))) invalid("invalid-isolation", "task.isolation must be none or worktree.");
    if (config.acceptance !== undefined) {
      if (!isObject(config.acceptance)) invalid("invalid-acceptance", "task.acceptance must be an object.");
      else {
        if (Object.keys(config.acceptance).some((key) => !["level", "evidence", "reason"].includes(key)) || containsCommandBearingAcceptance(config.acceptance)) invalid("unsafe-acceptance", "Restricted task.acceptance supports only safe level/evidence/reason fields; command-bearing verification belongs in a first-class gate.");
        if (config.acceptance.level !== undefined && !["auto", "attested", "checked"].includes(String(config.acceptance.level))) invalid("invalid-acceptance", "task.acceptance.level must be auto, attested, or checked.");
        if (config.acceptance.evidence !== undefined && (!Array.isArray(config.acceptance.evidence) || config.acceptance.evidence.some((item) => typeof item !== "string"))) invalid("invalid-acceptance", "task.acceptance.evidence must be an array of strings.");
        if (config.acceptance.reason !== undefined && typeof config.acceptance.reason !== "string") invalid("invalid-acceptance", "task.acceptance.reason must be a string.");
      }
    }
  }
  if (["parallel", "map"].includes(kind) && config.isolation !== undefined && !["none", "worktree"].includes(String(config.isolation))) invalid("invalid-isolation", `${kind}.isolation must be none or worktree.`);
  if (["parallel", "map"].includes(kind) && config.concurrency !== undefined && (!Number.isInteger(config.concurrency) || Number(config.concurrency) < 1)) invalid("invalid-concurrency", `${kind}.concurrency must be a positive integer.`);
  if (["repeatUntil", "gate"].includes(kind) && config.timeoutMs !== undefined && (!Number.isInteger(config.timeoutMs) || Number(config.timeoutMs) < 1)) invalid("invalid-timeout", `${kind}.timeoutMs must be a positive integer.`);
  if (kind === "map" && config.items === undefined) invalid("invalid-map", "map.items is required.");
  if (["branch", "repeatUntil"].includes(kind) && !isObject(kind === "branch" ? config.predicate : config.until)) invalid("invalid-predicate", `${kind} requires a predicate object.`);
  if (kind === "gate") {
    if (typeof config.overridable !== "boolean") invalid("invalid-gate", "gate.overridable must be boolean.");
    if (!isCall(config.check) || !config.check.$call.endsWith("Gate")) invalid("invalid-gate", "gate.check must use a gate helper.");
    if (!isObject(config.onFail)) invalid("invalid-failure", "gate.onFail must be an object.");
  }
  if (kind === "checkpoint" && config.name !== undefined && typeof config.name !== "string") invalid("invalid-checkpoint", "checkpoint.name must be a string.");
  if (kind === "emit" && config.message === undefined) invalid("invalid-emit", "emit.message is required.");
  if (kind === "aggregate" && !["array", "object", "concat"].includes(String(config.reducer))) invalid("invalid-reducer", "aggregate.reducer must be array, object, or concat.");
  if (kind === "aggregate" && !Array.isArray(config.inputs)) invalid("invalid-aggregate", "aggregate.inputs must be an array.");
  if (kind === "aggregate" && config.output !== undefined && !isObject(config.output)) invalid("invalid-schema", "aggregate.output must be a JSON Schema object.");
  if (kind === "emit" && config.final !== undefined && typeof config.final !== "boolean") invalid("invalid-final", "emit.final must be boolean.");
  if (kind === "repeatUntil" && config.noProgress !== undefined && typeof config.noProgress !== "boolean") invalid("invalid-no-progress", "repeatUntil.noProgress must be boolean.");
}

function containsCommandBearingAcceptance(value: ParsedValue, key = ""): boolean {
  if (/^(verify|verification|command|commands|cmd|bash|shell|script|steps|run|exec)$/i.test(key)) return true;
  if (Array.isArray(value)) return value.some((item) => containsCommandBearingAcceptance(item));
  if (isObject(value)) return Object.entries(value).some(([childKey, child]) => containsCommandBearingAcceptance(child, childKey));
  return false;
}

function rejectUnknownKeys(value: Record<string, ParsedValue>, allowed: Set<string>, path: string, diagnostics: CompileDiagnostic[], range: ParsedCall["range"]): void {
  for (const key of Object.keys(value)) if (!allowed.has(key)) diagnostics.push({ code: "unknown-property", message: `${path} contains unsupported property '${key}'.`, range });
}
