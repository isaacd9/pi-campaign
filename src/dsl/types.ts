import type { JsonSchema, JsonValue } from "../shared/json.ts";

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type RecoveryPolicy = "safe-retry" | "verify-before-retry" | "restart-from-checkpoint" | "manual";
export type Capability = "read" | "code-write" | "tests" | "network" | "shell" | string;

export interface CampaignLimits {
  maxAgents: number;
  maxConcurrency: number;
  maxRounds: number;
  maxTokens: number;
  timeoutMs?: number;
}
export interface CampaignMeta { name: string; description?: string; version: number }
export interface RefExpression { $ref: string }
export interface TemplateExpression { $template: string }
export type ValueExpression = JsonValue | RefExpression | TemplateExpression;
export interface OutputDeclaration { schema?: JsonSchema; nodeId: string }

export type GateCheck =
  | { type: "command"; command: string; cwd?: string; timeoutMs?: number; expectedExitCode?: number; outputIncludes?: string }
  | { type: "schema"; value: ValueExpression; schema: JsonSchema }
  | { type: "artifact"; path: string; exists?: boolean; sha256?: string; maxBytes?: number; contentIncludes?: string }
  | { type: "predicate"; predicate: Predicate }
  | { type: "approval"; prompt: string }
  | { type: "review"; agent?: string; focus: string }
  | { type: "acceptance"; node: string }
  | { type: "safety"; prompt: string; capabilities?: string[] }
  | { type: "budget"; maxTokens?: number; maxCost?: number; maxElapsedMs?: number; maxAgents?: number };

export type Predicate =
  | { op: "eq" | "ne" | "lt" | "lte" | "gt" | "gte"; left: ValueExpression; right: ValueExpression }
  | { op: "and" | "or"; items: Predicate[] }
  | { op: "not"; item: Predicate }
  | { op: "truthy"; value: ValueExpression };

export type FailureAction = { action: "stop" | "skip" | "retry" | "repair" | "pause"; maxAttempts?: number };
interface BaseNode { id: string; label?: string }
export interface AgentTaskNode extends BaseNode {
  kind: "agent-task"; agent: string; prompt: ValueExpression; outputSchema?: JsonSchema;
  capabilities: string[]; recovery: RecoveryPolicy; model?: string; fallbackModels?: string[]; thinking?: ThinkingLevel;
  acceptance?: Record<string, unknown>; isolation?: "none" | "worktree";
}
export interface SequenceNode extends BaseNode { kind: "sequence"; children: string[] }
export interface ParallelNode extends BaseNode { kind: "parallel"; children: string[]; concurrency: number; isolation: "none" | "worktree" }
export interface MapNode extends BaseNode { kind: "map"; items: ValueExpression; body: string; maxItems: number; concurrency: number; isolation: "none" | "worktree" }
export interface BranchNode extends BaseNode { kind: "branch"; predicate: Predicate; then: string; else?: string }
export interface LoopNode extends BaseNode { kind: "loop"; body: string; until: Predicate; maxRounds: number; timeoutMs?: number; noProgress?: boolean }
export interface GateNode extends BaseNode { kind: "gate"; check: GateCheck; overridable: boolean; timeoutMs?: number; onFail: FailureAction; onError: FailureAction }
export interface CheckpointNode extends BaseNode { kind: "checkpoint"; name: string }
export interface EmitNode extends BaseNode { kind: "emit"; message: ValueExpression; final: boolean }
export interface AggregateNode extends BaseNode { kind: "aggregate"; inputs: ValueExpression[]; reducer: "array" | "object" | "concat"; outputSchema?: JsonSchema }
export type CampaignNode = AgentTaskNode | SequenceNode | ParallelNode | MapNode | BranchNode | LoopNode | GateNode | CheckpointNode | EmitNode | AggregateNode;

export interface CampaignEdge { from: string; to: string; type: "child" | "then" | "else" | "body" }
export interface CampaignIR {
  irVersion: 1; sourceHash: string; meta: CampaignMeta; inputSchema?: JsonSchema; limits: CampaignLimits;
  root: string; nodes: CampaignNode[]; edges: CampaignEdge[]; outputs: Record<string, OutputDeclaration>;
}

export interface HardCaps extends CampaignLimits {}
export const DEFAULT_HARD_CAPS: HardCaps = { maxAgents: 100, maxConcurrency: 8, maxRounds: 10, maxTokens: 2_000_000, timeoutMs: 86_400_000 };
