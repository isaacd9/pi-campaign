import { Ajv } from "ajv";
import type { CampaignIR, CampaignNode, GateCheck, HardCaps, Predicate } from "../dsl/types.ts";
import { DEFAULT_HARD_CAPS } from "../dsl/types.ts";
import type { CompileDiagnostic } from "./diagnostics.ts";

export function validateIR(ir: CampaignIR, hardCaps: HardCaps = DEFAULT_HARD_CAPS): CompileDiagnostic[] {
  const errors: CompileDiagnostic[] = [];
  const ids = new Set<string>();
  const byId = new Map<string, CampaignNode>();
  for (const node of ir.nodes) {
    if (!/^[A-Za-z][A-Za-z0-9._-]{0,127}$/.test(node.id)) errors.push({ code: "invalid-id", message: `Node id '${node.id}' must be a safe identifier (letters, digits, dot, underscore, hyphen; start with a letter).` });
    if (ids.has(node.id)) errors.push({ code: "duplicate-id", message: `Duplicate node id '${node.id}'.`, hint: "Every campaign node id must be unique." });
    ids.add(node.id); byId.set(node.id, node);
  }
  if (!ids.has(ir.root)) errors.push({ code: "missing-root", message: `Root node '${ir.root}' does not exist.` });
  for (const edge of ir.edges) if (!ids.has(edge.from) || !ids.has(edge.to)) errors.push({ code: "missing-edge-node", message: `Edge ${edge.from} -> ${edge.to} references a missing node.` });
  const execution = executionOrder(ir.root, byId);
  const positions = new Map(execution.map((id, index) => [id, index]));
  const limits = ir.limits;
  for (const key of ["maxAgents", "maxConcurrency", "maxRounds", "maxTokens"] as const) {
    if (!Number.isInteger(limits[key]) || limits[key] < 1) errors.push({ code: "invalid-limit", message: `${key} must be a positive integer.` });
    if (limits[key] > hardCaps[key]) errors.push({ code: "hard-cap", message: `${key}=${limits[key]} exceeds configured hard cap ${hardCaps[key]}.` });
  }
  if (limits.timeoutMs !== undefined && (!Number.isInteger(limits.timeoutMs) || limits.timeoutMs < 1)) errors.push({ code: "invalid-limit", message: "timeoutMs must be a positive integer." });
  if (limits.timeoutMs && hardCaps.timeoutMs && limits.timeoutMs > hardCaps.timeoutMs) errors.push({ code: "hard-cap", message: `timeoutMs exceeds configured hard cap ${hardCaps.timeoutMs}.` });
  validateJsonSchema(ir.inputSchema, "campaign inputSchema", errors);
  for (const node of ir.nodes) {
    validateNodeShape(node, errors);
    if (node.kind === "parallel") {
      if (node.concurrency < 1 || node.concurrency > limits.maxConcurrency) errors.push({ code: "invalid-concurrency", message: `Parallel '${node.id}' concurrency exceeds campaign limit.` });
      const writers = node.children.filter((id) => containsWriter(id, byId, new Set()));
      if (writers.length > 1 && node.isolation !== "worktree") errors.push({ code: "parallel-writers", message: `Parallel '${node.id}' contains ${writers.length} writers without worktree isolation.`, hint: "Set isolation: 'worktree' or serialize writers." });
      const siblingSets = node.children.map((child) => descendants(child, byId));
      node.children.forEach((child, index) => {
        for (const member of siblingSets[index] ?? []) {
          const childNode = byId.get(member);
          if (!childNode) continue;
          visitRefs(childNode, (reference) => {
            const root = reference.split(".")[0]!;
            if (siblingSets.some((set, other) => other !== index && set.has(root))) errors.push({ code: "parallel-sibling-reference", message: `Parallel '${node.id}' child '${child}' references sibling output '${reference}', which is nondeterministic.` });
          });
        }
      });
    }
    if (node.kind === "map") {
      if (!Number.isInteger(node.maxItems) || node.maxItems < 0) errors.push({ code: "unbounded-map", message: `Map '${node.id}' requires a finite non-negative maxItems.` });
      if (node.concurrency < 1 || node.concurrency > limits.maxConcurrency) errors.push({ code: "invalid-concurrency", message: `Map '${node.id}' concurrency exceeds campaign limit.` });
      if (node.concurrency > 1 && containsWriter(node.body, byId, new Set()) && node.isolation !== "worktree") errors.push({ code: "parallel-writers", message: `Writer map '${node.id}' requires worktree isolation when concurrency > 1.` });
    }
    if (node.kind === "loop" && node.timeoutMs !== undefined && (!Number.isInteger(node.timeoutMs) || node.timeoutMs < 1)) errors.push({ code: "invalid-timeout", message: `Loop '${node.id}' timeoutMs must be positive.` });
    if (node.kind === "gate" && node.timeoutMs !== undefined && (!Number.isInteger(node.timeoutMs) || node.timeoutMs < 1)) errors.push({ code: "invalid-timeout", message: `Gate '${node.id}' timeoutMs must be positive.` });
    if (node.kind === "loop" && (!Number.isInteger(node.maxRounds) || node.maxRounds < 1 || node.maxRounds > limits.maxRounds)) errors.push({ code: "unbounded-loop", message: `Loop '${node.id}' maxRounds must be within campaign limits.` });
    if (node.kind === "gate") { if (!node.onFail?.action) errors.push({ code: "gate-failure", message: `Gate '${node.id}' requires explicit onFail behavior.` }); for (const [name, action] of [["onFail", node.onFail], ["onError", node.onError]] as const) if ((action.action === "retry" || action.action === "repair") && (!Number.isInteger(action.maxAttempts) || (action.maxAttempts ?? 0) < 1)) errors.push({ code: "unbounded-retry", message: `Gate '${node.id}' ${name} ${action.action} requires a positive maxAttempts bound.` }); }
    visitRefs(node, (reference) => {
      const root = reference.split(".")[0]!;
      if (root === "input" || root === "item" || root === "round") return;
      if (!ids.has(root)) { errors.push({ code: "missing-reference", message: `Node '${node.id}' references unknown node '${root}' via '${reference}'.` }); return; }
      const nodePosition = positions.get(node.id); const targetPosition = positions.get(root);
      const loopBodyReference = node.kind === "loop" && descendants(node.body, byId).has(root);
      if (!loopBodyReference && nodePosition !== undefined && targetPosition !== undefined && targetPosition >= nodePosition) errors.push({ code: "forward-reference", message: `Node '${node.id}' references '${root}' before it is available.` });
      const target = byId.get(root); const path = reference.split(".").slice(1).filter((part) => part !== "output");
      if (target?.kind === "agent-task" && target.outputSchema && !schemaAllowsPath(target.outputSchema, path)) errors.push({ code: "incompatible-reference", message: `Reference '${reference}' is incompatible with output schema of '${root}'.` });
    });
  }
  const estimate = estimateAgents(ir.root, byId, new Set());
  if (estimate > limits.maxAgents) errors.push({ code: "agent-limit", message: `Campaign may schedule ${estimate} agents, above declared maxAgents ${limits.maxAgents}.` });
  detectCycles(ir.root, byId, [], errors);
  return errors;
}
function validateNodeShape(node: CampaignNode, errors: CompileDiagnostic[]): void {
  const invalid = (code: string, message: string) => errors.push({ code, message });
  if (node.label !== undefined && typeof node.label !== "string") invalid("invalid-label", `Node '${node.id}' label must be a string.`);
  switch (node.kind) {
    case "agent-task":
      if (!node.agent || typeof node.agent !== "string") invalid("invalid-agent", `Task '${node.id}' requires an agent.`);
      if (!Array.isArray(node.capabilities) || node.capabilities.some((item) => typeof item !== "string")) invalid("invalid-capabilities", `Task '${node.id}' capabilities must be strings.`);
      if (!["safe-retry", "verify-before-retry", "restart-from-checkpoint", "manual"].includes(node.recovery)) invalid("invalid-recovery", `Task '${node.id}' recovery policy is invalid.`);
      if (node.thinking && !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(node.thinking)) invalid("invalid-thinking", `Task '${node.id}' thinking level is invalid.`);
      if (node.model !== undefined && typeof node.model !== "string") invalid("invalid-model", `Task '${node.id}' model must be a string.`);
      if (node.fallbackModels?.some((item) => typeof item !== "string")) invalid("invalid-fallbacks", `Task '${node.id}' fallbacks must be strings.`);
      validateExpression(node.prompt, `Task '${node.id}' prompt`, errors);
      validateJsonSchema(node.outputSchema, `task '${node.id}' output`, errors);
      break;
    case "sequence": if (!Array.isArray(node.children) || node.children.length === 0) invalid("invalid-children", `Sequence '${node.id}' requires at least one child.`); break;
    case "parallel": if (!Array.isArray(node.children) || node.children.length === 0) invalid("invalid-children", `Parallel '${node.id}' requires at least one child.`); break;
    case "map": if (!node.body) invalid("missing-child", `Map '${node.id}' requires a body.`); validateExpression(node.items, `Map '${node.id}' items`, errors); break;
    case "branch": validatePredicate(node.predicate, `Branch '${node.id}'`, errors); break;
    case "loop": validatePredicate(node.until, `Loop '${node.id}'`, errors); break;
    case "gate":
      validateGateCheck(node.check, node.id, errors);
      if (typeof node.overridable !== "boolean") invalid("invalid-gate", `Gate '${node.id}' overridable must be boolean.`);
      validateFailure(node.onFail, node.id, "onFail", errors);
      validateFailure(node.onError, node.id, "onError", errors);
      break;
    case "checkpoint": if (!node.name || typeof node.name !== "string") invalid("invalid-checkpoint", `Checkpoint '${node.id}' requires a name.`); break;
    case "emit": if (typeof node.final !== "boolean") invalid("invalid-emit", `Emit '${node.id}' final must be boolean.`); validateExpression(node.message, `Emit '${node.id}' message`, errors); break;
    case "aggregate":
      if (!Array.isArray(node.inputs) || !["array", "object", "concat"].includes(node.reducer)) invalid("invalid-aggregate", `Aggregate '${node.id}' is malformed.`);
      else node.inputs.forEach((input, index) => validateExpression(input, `Aggregate '${node.id}' input ${index}`, errors));
      validateJsonSchema(node.outputSchema, `aggregate '${node.id}' output`, errors);
      break;
  }
}

function validateFailure(action: { action?: unknown; maxAttempts?: unknown }, gateId: string, name: string, errors: CompileDiagnostic[]): void {
  if (!action || !["stop", "skip", "retry", "repair", "pause"].includes(String(action.action))) errors.push({ code: "invalid-failure", message: `Gate '${gateId}' ${name} action is invalid.` });
  if (action.maxAttempts !== undefined && (!Number.isInteger(action.maxAttempts) || Number(action.maxAttempts) < 1)) errors.push({ code: "invalid-failure", message: `Gate '${gateId}' ${name}.maxAttempts must be positive.` });
}

function validateGateCheck(check: GateCheck, gateId: string, errors: CompileDiagnostic[]): void {
  const invalid = (message: string) => errors.push({ code: "invalid-gate", message: `Gate '${gateId}' ${message}` });
  if (!check || typeof check !== "object" || typeof (check as { type?: unknown }).type !== "string") { invalid("check is malformed."); return; }
  const allowed: Record<string, string[]> = {
    command: ["type", "command", "cwd", "timeoutMs", "expectedExitCode", "outputIncludes"], schema: ["type", "value", "schema"],
    artifact: ["type", "path", "exists", "sha256", "maxBytes", "contentIncludes"], predicate: ["type", "predicate"], approval: ["type", "prompt"],
    review: ["type", "agent", "focus"], acceptance: ["type", "node"], safety: ["type", "prompt", "capabilities"],
    budget: ["type", "maxTokens", "maxCost", "maxElapsedMs", "maxAgents"],
  };
  const unknown = Object.keys(check).filter((key) => !(allowed[check.type] ?? []).includes(key));
  if (unknown.length) invalid(`check contains unsupported properties: ${unknown.join(", ")}.`);
  switch (check.type) {
    case "command":
      if (!check.command || typeof check.command !== "string") invalid("command check requires a command string.");
      if (check.cwd !== undefined && typeof check.cwd !== "string") invalid("command cwd must be a string.");
      if (check.timeoutMs !== undefined && (!Number.isInteger(check.timeoutMs) || check.timeoutMs < 1)) invalid("command timeoutMs must be positive.");
      if (check.expectedExitCode !== undefined && !Number.isInteger(check.expectedExitCode)) invalid("command expectedExitCode must be an integer.");
      if (check.outputIncludes !== undefined && typeof check.outputIncludes !== "string") invalid("command outputIncludes must be a string.");
      break;
    case "schema": if (!("value" in check)) invalid("schema check requires value."); else validateExpression(check.value, `Gate '${gateId}' schema value`, errors); if (!check.schema) invalid("schema check requires a schema."); else validateJsonSchema(check.schema, `gate '${gateId}' schema`, errors); break;
    case "artifact":
      if (!check.path || typeof check.path !== "string") invalid("artifact check requires a path.");
      if (check.exists !== undefined && typeof check.exists !== "boolean") invalid("artifact exists must be boolean.");
      if (check.sha256 !== undefined && (typeof check.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(check.sha256))) invalid("artifact sha256 must be a lowercase SHA-256 digest.");
      if (check.maxBytes !== undefined && (!Number.isInteger(check.maxBytes) || check.maxBytes < 0)) invalid("artifact maxBytes must be non-negative.");
      if (check.contentIncludes !== undefined && typeof check.contentIncludes !== "string") invalid("artifact contentIncludes must be a string.");
      break;
    case "predicate": validatePredicate(check.predicate, `Gate '${gateId}'`, errors); break;
    case "approval": if (!check.prompt || typeof check.prompt !== "string") invalid("approval check requires a prompt."); break;
    case "review": if (!check.focus || typeof check.focus !== "string" || (check.agent !== undefined && typeof check.agent !== "string")) invalid("review check is malformed."); break;
    case "acceptance": if (!check.node || typeof check.node !== "string") invalid("acceptance check requires a node id."); break;
    case "safety": if (!check.prompt || typeof check.prompt !== "string" || (check.capabilities && (!Array.isArray(check.capabilities) || check.capabilities.some((item) => typeof item !== "string")))) invalid("safety check is malformed."); break;
    case "budget": {
      const values = [check.maxTokens, check.maxCost, check.maxElapsedMs, check.maxAgents];
      if (values.every((value) => value === undefined) || values.some((value) => value !== undefined && (typeof value !== "number" || !Number.isFinite(value) || value < 0))) invalid("budget check requires non-negative finite bounds.");
      if (check.maxTokens !== undefined && !Number.isInteger(check.maxTokens) || check.maxElapsedMs !== undefined && !Number.isInteger(check.maxElapsedMs) || check.maxAgents !== undefined && !Number.isInteger(check.maxAgents)) invalid("budget token/time/agent bounds must be integers.");
      break;
    }
    default: invalid(`uses unknown check type '${String((check as { type?: unknown }).type)}'.`);
  }
}

function validatePredicate(predicate: Predicate, label: string, errors: CompileDiagnostic[]): void {
  if (!predicate || typeof predicate !== "object" || typeof (predicate as { op?: unknown }).op !== "string") { errors.push({ code: "invalid-predicate", message: `${label} predicate is malformed.` }); return; }
  const op = (predicate as { op: string }).op;
  const allowed: Record<string, string[]> = { truthy: ["op", "value"], not: ["op", "item"], and: ["op", "items"], or: ["op", "items"], eq: ["op", "left", "right"], ne: ["op", "left", "right"], lt: ["op", "left", "right"], lte: ["op", "left", "right"], gt: ["op", "left", "right"], gte: ["op", "left", "right"] };
  const unknown = Object.keys(predicate).filter((key) => !(allowed[op] ?? []).includes(key));
  if (unknown.length) errors.push({ code: "invalid-predicate", message: `${label} predicate contains unsupported properties: ${unknown.join(", ")}.` });
  switch (op) {
    case "truthy": if (!("value" in predicate)) errors.push({ code: "invalid-predicate", message: `${label} truthy predicate requires value.` }); else validateExpression(predicate.value, `${label} truthy value`, errors); break;
    case "not": validatePredicate((predicate as Extract<Predicate, { op: "not" }>).item, label, errors); break;
    case "and": case "or": { const items = (predicate as Extract<Predicate, { op: "and" | "or" }>).items; if (!Array.isArray(items) || items.length === 0) errors.push({ code: "invalid-predicate", message: `${label} ${op} predicate requires non-empty items.` }); else items.forEach((item) => validatePredicate(item, label, errors)); break; }
    case "eq": case "ne": case "lt": case "lte": case "gt": case "gte": if (!("left" in predicate) || !("right" in predicate)) errors.push({ code: "invalid-predicate", message: `${label} ${op} predicate requires left and right.` }); else { validateExpression(predicate.left, `${label} left operand`, errors); validateExpression(predicate.right, `${label} right operand`, errors); } break;
    default: errors.push({ code: "invalid-predicate", message: `${label} predicate op '${op}' is not allowed.` });
  }
}

function validateExpression(value: unknown, label: string, errors: CompileDiagnostic[]): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") { if (!Number.isFinite(value)) errors.push({ code: "invalid-expression", message: `${label} contains a non-finite number.` }); return; }
  if (Array.isArray(value)) { value.forEach((item, index) => validateExpression(item, `${label}[${index}]`, errors)); return; }
  if (!value || typeof value !== "object") { errors.push({ code: "invalid-expression", message: `${label} is not a JSON value, ref(...), or template(...).` }); return; }
  const object = value as Record<string, unknown>;
  if ("$ref" in object || "$template" in object) {
    const key = "$ref" in object ? "$ref" : "$template";
    if (Object.keys(object).length !== 1 || typeof object[key] !== "string" || !object[key]) errors.push({ code: "invalid-expression", message: `${label} has a malformed ${key === "$ref" ? "ref" : "template"} expression.` });
    else if (key === "$ref" && !/^[A-Za-z][A-Za-z0-9_.-]*$/.test(object[key] as string)) errors.push({ code: "invalid-expression", message: `${label} ref path '${object[key] as string}' is invalid.` });
    return;
  }
  for (const [key, child] of Object.entries(object)) validateExpression(child, `${label}.${key}`, errors);
}

function validateJsonSchema(schema: Record<string, unknown> | undefined, label: string, errors: CompileDiagnostic[]): void {
  if (schema === undefined) return;
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) { errors.push({ code: "invalid-schema", message: `${label} schema must be an object.` }); return; }
  try { new Ajv({ strict: false }).compile(schema); }
  catch (error) { errors.push({ code: "invalid-schema", message: `${label} schema is invalid: ${error instanceof Error ? error.message : String(error)}` }); }
}

function containsWriter(id: string, byId: Map<string, CampaignNode>, seen: Set<string>): boolean { if (seen.has(id)) return false; seen.add(id); const node = byId.get(id); if (!node) return false; if (node.kind === "agent-task") return node.capabilities.includes("code-write") || ["worker", "implementer"].includes(node.agent); return children(node).some((child) => containsWriter(child, byId, seen)); }
function estimateAgents(id: string, byId: Map<string, CampaignNode>, path: Set<string>): number {
  if (path.has(id)) return 0; const node = byId.get(id); if (!node) return 0; const next = new Set(path).add(id);
  switch (node.kind) {
    case "agent-task": return 1;
    case "gate": return node.check.type === "review" ? 1 : 0;
    case "sequence": case "parallel": return node.children.reduce((sum, child) => sum + estimateAgents(child, byId, next), 0);
    case "map": return node.maxItems * estimateAgents(node.body, byId, next);
    case "branch": return Math.max(estimateAgents(node.then, byId, next), node.else ? estimateAgents(node.else, byId, next) : 0);
    case "loop": return node.maxRounds * estimateAgents(node.body, byId, next);
    default: return 0;
  }
}
function executionOrder(root: string, byId: Map<string, CampaignNode>): string[] { const result: string[] = []; const walk = (id: string) => { const node = byId.get(id); if (!node) return; if (node.kind === "sequence" || node.kind === "parallel") { for (const child of node.children) walk(child); result.push(id); return; } if (node.kind === "map" || node.kind === "loop") { result.push(id); walk(node.body); return; } if (node.kind === "branch") { result.push(id); walk(node.then); if (node.else) walk(node.else); return; } result.push(id); }; walk(root); return result; }
function descendants(root: string, byId: Map<string, CampaignNode>): Set<string> { const result = new Set<string>(); const walk = (id: string) => { if (result.has(id)) return; result.add(id); const node = byId.get(id); if (node) children(node).forEach(walk); }; walk(root); return result; }
function schemaAllowsPath(schema: Record<string, unknown>, parts: string[]): boolean { let current: Record<string, unknown> | undefined = schema; for (const part of parts) { if (!current) return true; if (current.type === "array") { if (!/^\d+$/.test(part) && part !== "length") return false; current = typeof current.items === "object" && current.items ? current.items as Record<string, unknown> : undefined; continue; } const properties = current.properties; if (properties && typeof properties === "object" && Object.hasOwn(properties, part)) current = (properties as Record<string, Record<string, unknown>>)[part]; else if (current.additionalProperties === false) return false; else return true; } return true; }
function children(node: CampaignNode): string[] { switch (node.kind) { case "sequence": case "parallel": return node.children; case "map": case "loop": return [node.body]; case "branch": return [node.then, ...(node.else ? [node.else] : [])]; default: return []; } }
function detectCycles(id: string, byId: Map<string, CampaignNode>, stack: string[], errors: CompileDiagnostic[]): void {
  if (stack.includes(id)) { errors.push({ code: "cycle", message: `Illegal graph cycle: ${[...stack, id].join(" -> ")}. Use bounded repeatUntil instead.` }); return; }
  const node = byId.get(id); if (!node) return;
  for (const child of children(node)) detectCycles(child, byId, [...stack, id], errors);
}
function visitRefs(value: unknown, visit: (ref: string) => void): void {
  if (typeof value === "string") { for (const match of value.matchAll(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g)) visit(match[1]!); return; }
  if (!value || typeof value !== "object") return;
  if ("$ref" in (value as object) && typeof (value as { $ref?: unknown }).$ref === "string") { visit((value as { $ref: string }).$ref); return; }
  for (const child of Object.values(value as Record<string, unknown>)) visitRefs(child, visit);
}
