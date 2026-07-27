import type { CampaignLimits, CampaignMeta, GateCheck, Predicate, RecoveryPolicy, ThinkingLevel, ValueExpression } from "./types.ts";
export * from "./types.ts";

export interface CampaignDefinition { meta: CampaignMeta; limits: CampaignLimits; inputSchema?: Record<string, unknown>; program: DslNode }
export interface DslNode { readonly __campaignDsl: string; readonly config: Record<string, unknown> }
const node = (kind: string, config: Record<string, unknown>): DslNode => Object.freeze({ __campaignDsl: kind, config: Object.freeze(config) });
export const defineCampaign = (definition: CampaignDefinition): CampaignDefinition => Object.freeze(definition);
export const sequence = (children: DslNode[]): DslNode => node("sequence", { children });
export const parallel = (config: { id: string; children: DslNode[]; concurrency?: number; isolation?: "none" | "worktree" } | DslNode[]): DslNode => Array.isArray(config) ? node("parallel", { children: config }) : node("parallel", config as unknown as Record<string, unknown>);
export const task = (config: { id: string; agent: string; prompt: ValueExpression; output?: Record<string, unknown>; capabilities?: string[]; recovery?: RecoveryPolicy; model?: string; fallbackModels?: string[]; thinking?: ThinkingLevel; isolation?: "none" | "worktree" }): DslNode => node("task", config as unknown as Record<string, unknown>);
export const map = (config: { id: string; items: ValueExpression; body: DslNode; maxItems: number; concurrency?: number; isolation?: "none" | "worktree" }): DslNode => node("map", config as unknown as Record<string, unknown>);
export const branch = (config: { id: string; predicate: Predicate; then: DslNode; else?: DslNode }): DslNode => node("branch", config as unknown as Record<string, unknown>);
export const repeatUntil = (config: { id: string; body: DslNode; until: Predicate; maxRounds: number; timeoutMs?: number; noProgress?: boolean }): DslNode => node("repeatUntil", config as unknown as Record<string, unknown>);
export const gate = (config: { id: string; check: GateCheck; overridable: boolean; timeoutMs?: number; onFail: Record<string, unknown>; onError?: Record<string, unknown> }): DslNode => node("gate", config as unknown as Record<string, unknown>);
export const checkpoint = (config: { id: string; name?: string } | string): DslNode => typeof config === "string" ? node("checkpoint", { id: config }) : node("checkpoint", config);
export const emit = (config: { id: string; message: ValueExpression; final?: boolean }): DslNode => node("emit", config as unknown as Record<string, unknown>);
export const aggregate = (config: { id: string; inputs: ValueExpression[]; reducer: "array" | "object" | "concat"; output?: Record<string, unknown> }): DslNode => node("aggregate", config as unknown as Record<string, unknown>);
export const ref = (path: string): ValueExpression => ({ $ref: path });
export const template = (text: string): ValueExpression => ({ $template: text });
export const commandGate = (config: Omit<Extract<GateCheck, { type: "command" }>, "type">): GateCheck => ({ type: "command", ...config });
export const schemaGate = (config: Omit<Extract<GateCheck, { type: "schema" }>, "type">): GateCheck => ({ type: "schema", ...config });
export const artifactGate = (config: Omit<Extract<GateCheck, { type: "artifact" }>, "type">): GateCheck => ({ type: "artifact", ...config });
export const predicateGate = (predicate: Predicate): GateCheck => ({ type: "predicate", predicate });
export const approvalGate = (config: Omit<Extract<GateCheck, { type: "approval" }>, "type">): GateCheck => ({ type: "approval", ...config });
export const reviewGate = (config: Omit<Extract<GateCheck, { type: "review" }>, "type">): GateCheck => ({ type: "review", ...config });
export const acceptanceGate = (config: Omit<Extract<GateCheck, { type: "acceptance" }>, "type">): GateCheck => ({ type: "acceptance", ...config });
export const safetyGate = (config: Omit<Extract<GateCheck, { type: "safety" }>, "type">): GateCheck => ({ type: "safety", ...config });
export const budgetGate = (config: Omit<Extract<GateCheck, { type: "budget" }>, "type">): GateCheck => ({ type: "budget", ...config });
