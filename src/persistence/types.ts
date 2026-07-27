import type { CampaignIR, ThinkingLevel } from "../dsl/types.ts";

export type RunStatus = "created" | "running" | "paused" | "completed" | "failed" | "stopped";
export type NodeStatus = "pending" | "scheduled" | "running" | "completed" | "failed" | "skipped" | "interrupted" | "paused";

export interface NodeState {
  id: string;
  status: NodeStatus;
  attempts: number;
  startedAt?: number;
  endedAt?: number;
  kernelRunId?: string;
  asyncDir?: string;
  output?: unknown;
  outputHash?: string;
  error?: string;
  promptOverride?: string;
  modelOverride?: { model: string; thinking?: ThinkingLevel };
  routing?: { model: string; thinking: ThinkingLevel; fallbackModels: string[]; confidence: number; reasons: string[]; source: string };
  kernel?: { state: string; currentTool?: string; currentPath?: string; recentOutput?: string[]; model?: string; thinking?: string; tokens?: number; cost?: number };
  rounds?: number;
  roundHashes?: string[];
  loopPassed?: boolean;
  loopOutput?: unknown;
}

export interface GateRecord {
  gateId: string;
  outcome: "passed" | "failed" | "errored" | "overridden" | "skipped" | "timed-out";
  timestamp: number;
  attempt?: number;
  evidence?: unknown;
  evidenceHash?: string;
  reason?: string;
  active?: boolean;
}

export interface CampaignState {
  stateVersion: 1;
  runId: string;
  goal: string;
  cwd: string;
  status: RunStatus;
  ir?: CampaignIR;
  /** Deterministic compiler summary shown by the inspector. */
  summary?: string;
  input?: unknown;
  createdAt: number;
  updatedAt: number;
  nodes: Record<string, NodeState>;
  outputs: Record<string, unknown>;
  gates: GateRecord[];
  checkpoints: string[];
  emitted: string[];
  error?: string;
  pauseReason?: string;
  tokens: number;
  cost: number;
  agentsStarted: number;
  usageRecorded: string[];
}

export interface CampaignEvent<T = unknown> {
  eventVersion: 1;
  seq: number;
  id: string;
  runId: string;
  type: string;
  timestamp: number;
  data: T;
}
