import { contentHash } from "../shared/json.ts";
import type { CampaignEvent, CampaignState, GateRecord, NodeState } from "../persistence/types.ts";

export function initialState(runId: string, goal: string, cwd: string, now = Date.now()): CampaignState {
  return {
    stateVersion: 1,
    runId,
    goal,
    cwd,
    status: "created",
    createdAt: now,
    updatedAt: now,
    nodes: {},
    outputs: {},
    gates: [],
    checkpoints: [],
    emitted: [],
    tokens: 0,
    cost: 0,
    agentsStarted: 0,
    usageRecorded: [],
  };
}

export function reduceEvent(state: CampaignState, event: CampaignEvent): CampaignState {
  if (event.runId !== state.runId) throw new Error(`Event run ${event.runId} does not match ${state.runId}`);
  const next: CampaignState = structuredClone(state);
  next.usageRecorded ??= [];
  next.updatedAt = event.timestamp;
  const data = event.data as Record<string, unknown>;

  switch (event.type) {
    case "run.created":
      if (data.ir) next.ir = data.ir as NonNullable<CampaignState["ir"]>;
      if (typeof data.summary === "string") next.summary = data.summary;
      if (data.input !== undefined) next.input = data.input;
      break;
    case "run.started": next.status = "running"; delete next.error; delete next.pauseReason; break;
    case "run.paused": next.status = "paused"; next.pauseReason = typeof data.reason === "string" ? data.reason : "paused"; break;
    case "run.resumed": next.status = "running"; delete next.pauseReason; break;
    case "run.completed": next.status = "completed"; break;
    case "run.failed": next.status = "failed"; next.error = String(data.error ?? "Campaign failed"); break;
    case "run.stopped": next.status = "stopped"; break;
    case "node.scheduled": patchNode(next, data, { status: "scheduled", attempts: Number(data.attempt ?? 1) }); delete next.nodes[String(data.nodeId)]!.error; break;
    case "node.started":
      patchNode(next, data, {
        status: "running",
        startedAt: event.timestamp,
        ...(typeof data.kernelRunId === "string" ? { kernelRunId: data.kernelRunId } : {}),
        ...(typeof data.asyncDir === "string" ? { asyncDir: data.asyncDir } : {}),
      });
      if (data.countAgent !== false) next.agentsStarted++;
      break;
    case "node.completed": {
      const id = String(data.nodeId);
      patchNode(next, data, { status: "completed", endedAt: event.timestamp, output: data.output, outputHash: contentHash(data.output) });
      delete next.nodes[id]!.error;
      next.outputs[typeof data.outputKey === "string" ? data.outputKey : id] = data.output;
      break;
    }
    case "node.invalidated": {
      const id = String(data.nodeId);
      const prior = next.nodes[id];
      next.nodes[id] = { id, status: "pending", attempts: prior?.attempts ?? 0, ...(prior?.promptOverride ? { promptOverride: prior.promptOverride } : {}), ...(prior?.modelOverride ? { modelOverride: prior.modelOverride } : {}) };
      const outputKey = typeof data.outputKey === "string" ? data.outputKey : id;
      delete next.outputs[outputKey];
      break;
    }
    case "loop.round-completed": {
      const id = String(data.nodeId);
      const current = next.nodes[id] ?? { id, status: "running" as const, attempts: 1 };
      const hashes = [...(current.roundHashes ?? [])];
      const round = Number(data.round);
      hashes[round - 1] = String(data.outputHash);
      next.nodes[id] = { ...current, rounds: Math.max(current.rounds ?? 0, round), roundHashes: hashes, loopPassed: data.passed === true, loopOutput: data.output };
      break;
    }
    case "model.routed": patchNode(next, data, { routing: data.decision as NonNullable<NodeState["routing"]> }); break;
    case "kernel.status": patchNode(next, data, { kernel: data.status as NonNullable<NodeState["kernel"]> }); break;
    case "node.failed": patchNode(next, data, { status: "failed", endedAt: event.timestamp, error: String(data.error ?? "Node failed") }); break;
    case "node.skipped": patchNode(next, data, { status: "skipped", endedAt: event.timestamp }); break;
    case "node.interrupted": patchNode(next, data, { status: "interrupted", error: String(data.error ?? "Interrupted") }); break;
    case "node.prompt-edited": patchNode(next, data, { promptOverride: String(data.prompt) }); break;
    case "node.model-overridden": patchNode(next, data, { modelOverride: { model: String(data.model), ...(typeof data.thinking === "string" ? { thinking: data.thinking as never } : {}) } }); break;
    case "gate.recorded": next.gates.push(data as unknown as GateRecord); break;
    case "gate.override-invalidated": {
      const gateId = String(data.gateId);
      let index = -1;
      for (let candidate = next.gates.length - 1; candidate >= 0; candidate--) {
        const record = next.gates[candidate]!;
        if (record.gateId === gateId && record.outcome === "overridden" && record.active !== false) { index = candidate; break; }
      }
      if (index >= 0) next.gates[index] = { ...next.gates[index]!, active: false };
      break;
    }
    case "checkpoint.reached": next.checkpoints.push(String(data.name)); break;
    case "milestone.emitted": next.emitted.push(String(data.message)); break;
    case "usage.recorded": {
      const key = typeof data.kernelRunId === "string" ? data.kernelRunId : undefined;
      if (key && next.usageRecorded.includes(key)) break;
      if (key) next.usageRecorded.push(key);
      next.tokens += Number(data.tokens ?? 0);
      next.cost += Number(data.cost ?? 0);
      break;
    }
  }
  return next;
}

function patchNode(state: CampaignState, data: Record<string, unknown>, patch: Partial<NodeState>): void {
  const id = String(data.nodeId);
  state.nodes[id] = { id, status: "pending", attempts: 0, ...state.nodes[id], ...patch };
}

export function replay(initial: CampaignState, events: readonly CampaignEvent[]): CampaignState {
  return events.reduce(reduceEvent, initial);
}
