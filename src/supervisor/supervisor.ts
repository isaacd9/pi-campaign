import { join } from "node:path";
import { Ajv } from "ajv";
import type { CampaignKernel, KernelRun, KernelStatus } from "../adapters/kernel.ts";
import type { AgentTaskNode, CampaignIR, CampaignNode, GateNode, ThinkingLevel } from "../dsl/types.ts";
import { GateExecutor } from "../gates/index.ts";
import type { ModelDecision } from "../model-router/index.ts";
import { EventStore } from "../persistence/event-store.ts";
import type { CampaignState } from "../persistence/types.ts";
import { contentHash } from "../shared/json.ts";
import { evaluatePredicate, resolveExpression, type ExpressionContext } from "./expressions.ts";
export interface SupervisorOptions {
  pollMs?: number;
  input?: unknown;
  route?: (node: AgentTaskNode, instanceId: string) => Promise<ModelDecision>;
  emit?: (message: string, final: boolean) => void;
  maxTaskAttempts?: number;
  approveIsolationDowngrade?: (nodeId: string) => Promise<boolean>;
  withWriterLock?: <T>(work: () => Promise<T>) => Promise<T>;
}
export class CampaignSupervisor {
  private byId: Map<string, CampaignNode>;
  private stopped = false;
  private detached = false;
  private skipped = new Set<string>();
  private kernelStatusHashes = new Map<string, string>();
  private pauseWaiters: Array<() => void> = [];
  private ajv = new Ajv({ allErrors: true, strict: false });
  private activeGateAbort: AbortController | undefined;
  private approvedIsolationDowngrades = new Set<string>();
  constructor(public readonly ir: CampaignIR, public readonly store: EventStore, private kernel: CampaignKernel, private gates: GateExecutor, private options: SupervisorOptions = {}) { this.byId = new Map(ir.nodes.map((node) => [node.id, node])); }
  get state(): CampaignState { return this.store.state; }
  async recoverInterrupted(): Promise<void> {
    for (const node of Object.values(this.state.nodes)) {
      if (node.status !== "running" && node.status !== "scheduled") continue;
      if (node.status === "running" && node.kernelRunId) {
        try {
          const status = await this.kernel.status({ id: node.kernelRunId, ...(node.asyncDir ? { asyncDir: node.asyncDir } : {}), outputPath: this.outputPathFor(node.id) });
          if (status.state === "complete") {
            await this.recordUsage(node.kernelRunId, status);
            const definition = this.byId.get(baseNodeId(node.id));
            if (definition?.kind === "agent-task") await this.completeTask(definition, node.id, status);
            else await this.store.append("node.completed", { nodeId: node.id, output: status.output, outputKey: baseNodeId(node.id), recovered: true });
            continue;
          }
          if (status.state === "running" || status.state === "queued") continue;
          await this.recordUsage(node.kernelRunId, status);
        } catch { /* missing or incompatible artifacts remain uncertain */ }
      }
      await this.store.append("node.interrupted", { nodeId: node.id, error: node.kernelRunId ? "Pi stopped before the kernel result was persisted." : "Assignment was durably scheduled but kernel identity was not persisted; completion is uncertain." });
    }
  }
  async run(): Promise<CampaignState> {
    if (this.state.status === "created" || this.state.status === "failed" || (this.state.status === "completed" && Object.values(this.state.nodes).some((node) => node.status === "scheduled" || node.status === "pending"))) await this.store.append("run.started", { retry: this.state.status !== "created" }); else if (this.state.status === "paused") await this.store.append("run.resumed");
    try {
      this.assertWithinCampaignDeadline();
      await this.executeNode(this.ir.root, this.context());
      if (this.state.tokens > this.ir.limits.maxTokens) throw new Error(`Runtime maxTokens ${this.ir.limits.maxTokens} exceeded before completion.`);
      if (this.state.agentsStarted > this.ir.limits.maxAgents) throw new Error(`Runtime maxAgents ${this.ir.limits.maxAgents} exceeded before completion.`);
      if (!this.stopped && this.state.status !== "failed") await this.store.append("run.completed");
    }
    catch (error) { if (!this.stopped && !this.detached) await this.store.append("run.failed", { error: error instanceof Error ? error.message : String(error) }); }
    await this.store.flush(); return this.state;
  }
  detach(): void { this.detached = true; for (const wake of this.pauseWaiters.splice(0)) wake(); }
  async quiesceForRestart(): Promise<void> {
    this.activeGateAbort?.abort();
    const runs = Object.values(this.state.nodes).filter((node) => node.status === "running" && node.kernelRunId).map((node) => ({ id: node.kernelRunId!, ...(node.asyncDir ? { asyncDir: node.asyncDir } : {}), outputPath: this.outputPathFor(node.id) }));
    await Promise.all(runs.map(async (run) => { await this.kernel.stop(run).catch(() => undefined); await this.waitForTerminalAfterStop(run); }));
    this.detached = true;
    for (const wake of this.pauseWaiters.splice(0)) wake();
  }
  async markRestartPaused(reason = "session-shutdown"): Promise<void> {
    for (const node of Object.values(this.state.nodes)) if (["scheduled", "running", "failed"].includes(node.status) && node.kernelRunId) await this.store.append("node.interrupted", { nodeId: node.id, error: "Kernel work was quiesced during Pi session shutdown and requires recovery reconciliation." });
    await this.store.append("run.paused", { reason });
    await this.store.flush();
  }
  async pause(reason = "user"): Promise<void> { if (this.state.status === "running") { await this.store.append("run.paused", { reason }); this.activeGateAbort?.abort(); } }
  async resume(): Promise<void> { if (this.state.status === "paused") await this.store.append("run.resumed"); for (const wake of this.pauseWaiters.splice(0)) wake(); }
  async stop(reason = "user"): Promise<void> {
    this.stopped = true;
    this.activeGateAbort?.abort();
    const runs = Object.values(this.state.nodes).filter((node) => node.status === "running" && node.kernelRunId).map((node) => ({ id: node.kernelRunId!, ...(node.asyncDir ? { asyncDir: node.asyncDir } : {}), outputPath: this.outputPathFor(node.id) }));
    await Promise.all(runs.map(async (run) => { await this.kernel.stop(run).catch(() => undefined); await this.waitForTerminalAfterStop(run); }));
    await this.store.append("run.stopped", { reason });
    for (const wake of this.pauseWaiters.splice(0)) wake();
  }
  async retry(nodeId: string): Promise<void> {
    const state = this.state;
    const node = state.nodes[nodeId];
    if (!node || !["failed", "interrupted", "skipped"].includes(node.status)) throw new Error(`Node '${nodeId}' is not retryable.`);
    const invalidated = this.retryInvalidationSet(baseNodeId(nodeId));
    invalidated.add(nodeId);
    for (const id of invalidated) {
      if (state.nodes[id]?.status === "completed" || id === nodeId) {
        await this.store.append("node.invalidated", { nodeId: id, outputKey: baseNodeId(id), reason: `manual retry of ${nodeId}` });
        if (this.byId.get(baseNodeId(id))?.kind === "gate") await this.store.append("gate.override-invalidated", { gateId: baseNodeId(id), reason: `manual retry of ${nodeId}` });
      }
    }
    await this.store.append("node.scheduled", { nodeId, attempt: 0, priorAttempts: node.attempts, manualRetry: true });
  }
  async skip(nodeId: string, reason = "user"): Promise<void> {
    const node = this.state.nodes[nodeId];
    if (node?.status === "completed") throw new Error("Completed nodes cannot be skipped.");
    this.skipped.add(nodeId);
    if (node?.status === "running" && node.kernelRunId) {
      const run = { id: node.kernelRunId, ...(node.asyncDir ? { asyncDir: node.asyncDir } : {}), outputPath: this.outputPathFor(node.id) };
      await this.kernel.stop(run).catch(() => undefined);
      await this.waitForTerminalAfterStop(run);
    }
    await this.store.append("node.skipped", { nodeId, reason });
  }
  async editPendingPrompt(nodeId: string, prompt: string): Promise<void> { const node = this.state.nodes[nodeId]; if (node && !["pending", "failed", "interrupted", "scheduled"].includes(node.status)) throw new Error("Only pending or retryable prompts can be edited."); if (this.byId.get(baseNodeId(nodeId))?.kind !== "agent-task") throw new Error("Only agent-task prompts are editable."); await this.store.append("node.prompt-edited", { nodeId, prompt }); }
  async overrideModel(nodeId: string, model: string, thinking?: ThinkingLevel): Promise<void> { const node = this.state.nodes[nodeId]; if (node?.status === "running" || node?.status === "completed") throw new Error("Model overrides apply only before a node runs."); await this.store.append("node.model-overridden", { nodeId, model, ...(thinking ? { thinking } : {}) }); }
  async overrideGate(gateId: string, reason?: string): Promise<void> {
    const gate = this.byId.get(gateId);
    if (gate?.kind !== "gate") throw new Error(`Unknown gate '${gateId}'.`);
    if (gate.check.type === "safety" && !reason?.trim()) throw new Error("Safety checkpoint overrides require an explicit reason.");
    const prior = this.state.gates.filter((record) => record.gateId === gateId && record.outcome !== "overridden").at(-1);
    await this.store.append("gate.recorded", { gateId, outcome: "overridden", timestamp: Date.now(), attempt: prior?.attempt, evidence: prior?.evidence, evidenceHash: prior?.evidenceHash, active: true, ...(reason?.trim() ? { reason: reason.trim() } : {}) });
  }
  private async executeNode(id: string, ctx: ExpressionContext, instanceId = id): Promise<unknown> {
    ctx = { ...ctx, outputs: { ...this.state.outputs, ...ctx.outputs } };
    this.assertWithinCampaignDeadline();
    await this.awaitRunnable(); const existing = this.state.nodes[instanceId]; if (existing?.status === "completed" || existing?.status === "skipped") return existing.output; const node = this.byId.get(id); if (!node) throw new Error(`Missing node '${id}'.`);
    switch (node.kind) {
      case "sequence": {
        let output: unknown;
        let local = { ...ctx, outputs: { ...ctx.outputs } };
        for (const child of node.children) {
          output = await this.executeNode(child, local, scopedInstanceId(child, id, instanceId));
          local = { ...local, outputs: { ...local.outputs, [child]: output } };
        }
        return this.localComplete(instanceId, output);
      }
      case "parallel": {
        const hasWriters = node.children.some((child) => this.isWriterNode(child));
        if (hasWriters && node.concurrency > 1 && node.isolation === "worktree" && !this.kernel.worktreeIsolation) await this.requireIsolationDowngrade(node.id);
        const concurrency = hasWriters && !this.kernel.worktreeIsolation ? 1 : node.concurrency;
        const output = await mapConcurrent(node.children, concurrency, (child) => this.executeNode(child, { ...ctx, outputs: { ...ctx.outputs } }, scopedInstanceId(child, id, instanceId)));
        return this.localComplete(instanceId, output);
      }
      case "map": {
        const raw = resolveExpression(node.items, ctx);
        if (!Array.isArray(raw)) throw new Error(`Map '${id}' items did not resolve to an array.`);
        if (raw.length > node.maxItems) throw new Error(`Map '${id}' resolved ${raw.length} items, above maxItems ${node.maxItems}.`);
        const writer = this.isWriterNode(node.body);
        if (writer && node.concurrency > 1 && node.isolation === "worktree" && !this.kernel.worktreeIsolation) await this.requireIsolationDowngrade(node.id);
        const concurrency = writer && !this.kernel.worktreeIsolation ? 1 : node.concurrency;
        const output = await mapConcurrent(raw, concurrency, (item, index) => this.executeNode(node.body, { ...ctx, item, outputs: { ...ctx.outputs } }, scopedInstanceId(node.body, id, instanceId, `[${index}]`)));
        await this.store.append("node.completed", { nodeId: instanceId, output, outputKey: id });
        return output;
      }
      case "branch": { const selected = evaluatePredicate(node.predicate, ctx) ? node.then : node.else; const output = selected ? await this.executeNode(selected, ctx, scopedInstanceId(selected, id, instanceId)) : undefined; return this.localComplete(instanceId, output); }
      case "loop": {
        const started = Date.now();
        const loopState = this.state.nodes[instanceId];
        if (loopState?.loopPassed) { await this.store.append("node.completed", { nodeId: instanceId, output: loopState.loopOutput }); return loopState.loopOutput; }
        const hashes = loopState?.roundHashes ?? [];
        if (node.noProgress && hashes.length >= 2 && hashes.at(-1) === hashes.at(-2)) throw new Error(`Loop '${id}' stopped after no progress at round ${loopState?.rounds ?? hashes.length}.`);
        let previous = hashes.at(-1);
        let output = loopState?.loopOutput;
        const firstRound = (loopState?.rounds ?? 0) + 1;
        for (let round = firstRound; round <= node.maxRounds; round++) {
          if (node.timeoutMs && Date.now() - started > node.timeoutMs) throw new Error(`Loop '${id}' timed out.`);
          output = await this.executeNode(node.body, { ...ctx, round, outputs: { ...ctx.outputs } }, scopedInstanceId(node.body, id, instanceId, `[round-${round}]`));
          const roundOutputs = { ...this.state.outputs, [node.body]: output };
          const passed = evaluatePredicate(node.until, { ...ctx, outputs: roundOutputs, round });
          const hash = contentHash(output);
          await this.store.append("loop.round-completed", { nodeId: instanceId, round, output, outputHash: hash, passed });
          if (passed) { await this.store.append("node.completed", { nodeId: instanceId, output }); return output; }
          if (node.noProgress && previous === hash) throw new Error(`Loop '${id}' stopped after no progress at round ${round}.`);
          previous = hash;
        }
        throw new Error(`Loop '${id}' exhausted maxRounds ${node.maxRounds}.`);
      }
      case "agent-task": return this.executeTask(node, ctx, instanceId);
      case "gate": return this.executeGate(node, ctx, instanceId);
      case "checkpoint": await this.store.append("checkpoint.reached", { name: node.name, nodeId: instanceId }); return this.localComplete(instanceId, { checkpoint: node.name });
      case "emit": { const message = String(resolveExpression(node.message, ctx)); await this.store.append("milestone.emitted", { nodeId: instanceId, message, final: node.final }); this.options.emit?.(message, node.final); return this.localComplete(instanceId, message); }
      case "aggregate": { const values = node.inputs.map((input) => resolveExpression(input, ctx)); const output = node.reducer === "concat" ? values.map(String).join("") : node.reducer === "object" ? Object.fromEntries(values.map((value, index) => [String(index), value])) : values; if (node.outputSchema) { const validate = this.ajv.compile(node.outputSchema); if (!validate(output)) throw new Error(`Aggregate '${id}' output failed schema: ${this.ajv.errorsText(validate.errors)}`); } return this.localComplete(instanceId, output); }
    }
  }
  private async executeTask(node: AgentTaskNode, ctx: ExpressionContext, instanceId: string): Promise<unknown> {
    const active = this.state.nodes[instanceId];
    if (active?.status === "running" && active.kernelRunId) {
      const status = await this.waitForKernel({ id: active.kernelRunId, ...(active.asyncDir ? { asyncDir: active.asyncDir } : {}), outputPath: this.outputPathFor(instanceId) }, instanceId);
      await this.recordUsage(active.kernelRunId, status);
      if (status.state === "complete") return this.completeTask(node, instanceId, status);
      await this.store.append("node.interrupted", { nodeId: instanceId, error: status.error ?? `Recovered kernel run is ${status.state}.` });
    }
    const interrupted = this.state.nodes[instanceId]?.status === "interrupted";
    if (interrupted && (node.recovery === "manual" || node.recovery === "restart-from-checkpoint")) throw new Error(`Task '${node.id}' was interrupted and requires explicit user retry from a checkpoint.`);
    if (interrupted && node.recovery === "verify-before-retry") {
      const verified = await this.verifyInterruptedTask(node, ctx, instanceId);
      if (verified.verified) return verified.output;
    }

    const max = this.options.maxTaskAttempts ?? 3;
    let lastError = "Task failed";
    for (let attempt = Math.max(1, (this.state.nodes[instanceId]?.attempts ?? 0) + 1); attempt <= max; attempt++) {
      await this.store.append("node.scheduled", { nodeId: instanceId, attempt });
      const override = this.state.nodes[instanceId]?.modelOverride;
      let decision: ModelDecision | undefined;
      try { decision = override ? undefined : await this.options.route?.(node, instanceId); }
      catch (error) { await this.store.append("node.failed", { nodeId: instanceId, error: `Model routing failed: ${error instanceof Error ? error.message : String(error)}` }); throw error; }
      const prompt = this.state.nodes[instanceId]?.promptOverride ?? String(resolveExpression(node.prompt, ctx));
      if (this.state.tokens >= this.ir.limits.maxTokens) throw new Error(`Runtime maxTokens ${this.ir.limits.maxTokens} reached before '${node.id}'.`);
      if (this.state.agentsStarted >= this.ir.limits.maxAgents) throw new Error(`Runtime maxAgents ${this.ir.limits.maxAgents} reached before '${node.id}'.`);
      const modelCandidates = override ? [override.model] : node.model ? [node.model, ...(node.fallbackModels ?? [])] : decision ? [decision.model, ...decision.fallbackModels] : [];
      const selectedModel = modelCandidates[Math.min(attempt - 1, Math.max(0, modelCandidates.length - 1))];
      const selectedThinking = override?.thinking ?? node.thinking ?? decision?.thinking;
      const writer = node.capabilities.includes("code-write") || ["worker", "implementer"].includes(node.agent);
      if (writer && node.isolation === "worktree" && !this.kernel.worktreeIsolation) await this.requireIsolationDowngrade(node.id);
      const perform = async () => {
        this.assertWithinCampaignDeadline();
        const assignmentTimeout = this.remainingCampaignMs();
        const run = await this.kernel.spawn({ agent: node.agent, task: prompt, cwd: this.state.cwd, phase: node.label ?? node.id, label: node.id, capabilities: node.capabilities, ...(selectedModel ? { model: selectedModel } : {}), ...(selectedThinking ? { thinking: selectedThinking } : {}), worktree: node.isolation === "worktree", outputPath: join(this.store.runDir, "assignments", `${fileId(instanceId)}.txt`), ...(assignmentTimeout !== undefined ? { timeoutMs: assignmentTimeout } : {}), ...(node.outputSchema ? { outputSchema: node.outputSchema } : {}), acceptance: node.acceptance ?? { level: "none", reason: "Campaign captures assignment output and validates it with first-class campaign gates." } });
        await this.store.append("node.started", { nodeId: instanceId, kernelRunId: run.id, asyncDir: run.asyncDir });
        const status = await this.waitForKernel(run, instanceId);
        await this.recordUsage(run.id, status);
        return status;
      };
      const needsActiveWorktreeLock = writer && !(node.isolation === "worktree" && this.kernel.worktreeIsolation);
      let status: KernelStatus;
      try { status = needsActiveWorktreeLock && this.options.withWriterLock ? await this.options.withWriterLock(perform) : await perform(); }
      catch (error) {
        await this.store.append("node.interrupted", { nodeId: instanceId, error: `Kernel submission/status became uncertain: ${error instanceof Error ? error.message : String(error)}` });
        throw error;
      }
      if (this.skipped.has(instanceId) || this.state.nodes[instanceId]?.status === "skipped") return undefined;
      if (status.state === "complete") {
        try { return await this.completeTask(node, instanceId, status); }
        catch (error) { lastError = error instanceof Error ? error.message : String(error); await this.store.append("node.failed", { nodeId: instanceId, error: lastError }); continue; }
      }
      lastError = status.error ?? `Kernel run ${status.state}`;
      await this.store.append(status.state === "paused" ? "node.interrupted" : "node.failed", { nodeId: instanceId, error: lastError });
      if (node.recovery === "manual" || node.recovery === "restart-from-checkpoint") break;
    }
    throw new Error(`Task '${node.id}' failed: ${lastError}`);
  }

  private async completeTask(node: AgentTaskNode, instanceId: string, status: KernelStatus): Promise<unknown> {
    let output = status.output;
    if (typeof output === "string" && node.outputSchema) output = parseStructuredOutput(output);
    if (node.outputSchema) {
      const validate = this.ajv.compile(node.outputSchema);
      if (!validate(output)) throw new Error(`Output schema failed: ${this.ajv.errorsText(validate.errors)}`);
    }
    await this.store.append("node.completed", { nodeId: instanceId, output, outputKey: node.id });
    if (this.state.tokens > this.ir.limits.maxTokens) throw new Error(`Runtime maxTokens ${this.ir.limits.maxTokens} exceeded by '${node.id}'.`);
    return output;
  }
  private async verifyInterruptedTask(node: AgentTaskNode, ctx: ExpressionContext, instanceId: string): Promise<{ verified: boolean; output?: unknown }> {
    if (this.state.agentsStarted >= this.ir.limits.maxAgents) throw new Error(`Cannot safely verify interrupted '${node.id}': runtime maxAgents reached.`);
    const verifyId = `${instanceId}:verify`;
    await this.store.append("node.scheduled", { nodeId: verifyId, attempt: 1 });
    const originalPrompt = this.state.nodes[instanceId]?.promptOverride ?? String(resolveExpression(node.prompt, ctx));
    const task = `Verify whether this interrupted assignment already completed successfully without making changes. Assignment:\n${originalPrompt}\nReturn JSON only: {"complete": boolean, "output": any, "evidence": string}.`;
    const decision = await this.routeSupport("reviewer", task, verifyId, []);
    const run = await this.kernel.spawn({ agent: "reviewer", task, cwd: this.state.cwd, phase: `Recover ${node.id}`, label: verifyId, ...(decision ? { model: decision.model, thinking: decision.thinking } : {}), outputSchema: { type: "object", required: ["complete", "evidence"] }, outputPath: join(this.store.runDir, "assignments", `${fileId(verifyId)}.txt`) });
    await this.store.append("node.started", { nodeId: verifyId, kernelRunId: run.id, asyncDir: run.asyncDir });
    const status = await this.waitForKernel(run, verifyId);
    await this.recordUsage(run.id, status);
    if (status.state !== "complete") throw new Error(`Verification for interrupted '${node.id}' failed; refusing a blind retry.`);
    let verdict = status.output;
    if (typeof verdict === "string") {
      const json = verdict.match(/\{[\s\S]*\}/)?.[0];
      try { verdict = json ? JSON.parse(json) : undefined; } catch { verdict = undefined; }
    }
    if (!verdict || typeof verdict !== "object" || typeof (verdict as { complete?: unknown }).complete !== "boolean") throw new Error(`Verification for interrupted '${node.id}' was invalid; refusing a blind retry.`);
    await this.store.append("node.completed", { nodeId: verifyId, output: verdict });
    if ((verdict as { complete: boolean }).complete) {
      const output = (verdict as { output?: unknown }).output ?? { recovered: true, evidence: (verdict as { evidence?: unknown }).evidence };
      await this.store.append("node.completed", { nodeId: instanceId, output, outputKey: node.id, recovered: true });
      return { verified: true, output };
    }
    return { verified: false };
  }
  private async executeGate(node: GateNode, ctx: ExpressionContext, instanceId: string, attempt = 1): Promise<unknown> {
    const override = this.currentGateOverride(node.id);
    if (override) {
      const output = { outcome: "overridden", reason: override.reason, evidence: override.evidence };
      await this.store.append("node.completed", { nodeId: instanceId, output });
      return output;
    }
    if (node.check.type === "command" && this.state.nodes[instanceId]?.status === "interrupted") {
      await this.pause(`uncertain-command-gate:${node.id}`);
      await this.awaitRunnable();
      if (this.currentGateOverride(node.id)) return this.executeGate(node, ctx, instanceId, attempt);
      if (!this.wasManuallyRetried(instanceId)) throw new Error(`Command gate '${node.id}' was interrupted after scheduling; explicit retry or override is required before its shell command can run again.`);
    }
    await this.store.append("node.scheduled", { nodeId: instanceId, attempt });
    const abort = new AbortController();
    this.activeGateAbort = abort;
    const remaining = this.remainingCampaignMs();
    const gateTimeout = remaining === undefined ? node.timeoutMs : node.timeoutMs === undefined ? remaining : Math.min(remaining, node.timeoutMs);
    const result = await this.gates.execute(node.check, this.state, ctx, gateTimeout, abort.signal);
    if ((this.remainingCampaignMs() ?? 1) <= 0) throw new Error(`Campaign timeout ${this.ir.limits.timeoutMs}ms exceeded at gate '${node.id}'.`);
    if (this.activeGateAbort === abort) this.activeGateAbort = undefined;
    if (abort.signal.aborted && this.state.status === "paused") { await this.awaitRunnable(); return this.executeGate(node, ctx, instanceId, attempt); }
    if (abort.signal.aborted && this.stopped) throw new Error("Campaign stopped");
    const evidenceHash = contentHash(result.evidence ?? result.error ?? null);
    await this.store.append("gate.recorded", { gateId: node.id, outcome: result.outcome, timestamp: Date.now(), attempt, evidence: result.evidence, evidenceHash, error: result.error });
    if (result.outcome === "passed") { await this.store.append("node.completed", { nodeId: instanceId, output: result }); return result; }
    const action = result.outcome === "errored" || result.outcome === "timed-out" ? node.onError : node.onFail;
    if (action.action === "skip") { await this.store.append("node.skipped", { nodeId: instanceId, reason: result }); return result; }
    if (action.action === "pause") { await this.pause(`gate:${node.id}`); await this.awaitRunnable(); return this.executeGate(node, ctx, instanceId, attempt + 1); }
    if ((action.action === "retry" || action.action === "repair") && attempt <= (action.maxAttempts ?? 1)) {
      if (action.action === "repair") {
        if (this.state.agentsStarted >= this.ir.limits.maxAgents) throw new Error(`Runtime maxAgents ${this.ir.limits.maxAgents} reached before gate repair.`);
        const repairId = `${instanceId}:repair:${attempt}`;
        await this.store.append("node.scheduled", { nodeId: repairId, attempt: 1 });
        const repairTask = `Repair the failed campaign checkpoint '${node.id}'. Evidence:\n${JSON.stringify(result.evidence ?? result.error)}`;
        const decision = await this.routeSupport("worker", repairTask, repairId, ["code-write", "tests"]);
        const perform = async () => {
          const run = await this.kernel.spawn({ agent: "worker", task: repairTask, cwd: this.state.cwd, phase: `Repair ${node.id}`, label: repairId, capabilities: ["code-write", "tests"], ...(decision ? { model: decision.model, thinking: decision.thinking } : {}), outputPath: join(this.store.runDir, "assignments", `${fileId(repairId)}.txt`) });
          await this.store.append("node.started", { nodeId: repairId, kernelRunId: run.id, asyncDir: run.asyncDir });
          const repair = await this.waitForKernel(run, repairId);
          await this.recordUsage(run.id, repair);
          return repair;
        };
        const repair = this.options.withWriterLock ? await this.options.withWriterLock(perform) : await perform();
        if (repair.state !== "complete") throw new Error(`Repair for gate '${node.id}' failed: ${repair.error ?? repair.state}`);
        await this.store.append("node.completed", { nodeId: repairId, output: repair.output });
      }
      return this.executeGate(node, ctx, instanceId, attempt + 1);
    }
    await this.store.append("node.failed", { nodeId: instanceId, error: `Gate ${result.outcome} (${action.action})` });
    throw new Error(`Gate '${node.id}' ${result.outcome} (${action.action}).`);
  }
  private async routeSupport(agent: string, prompt: string, instanceId: string, capabilities: string[]): Promise<ModelDecision | undefined> {
    return this.options.route?.({ id: instanceId, kind: "agent-task", agent, prompt, capabilities, recovery: capabilities.includes("code-write") ? "verify-before-retry" : "safe-retry" }, instanceId);
  }
  private async waitForKernel(run: KernelRun, nodeId: string) {
    while (true) {
      if (this.stopped || this.state.status === "stopped") return this.waitForTerminalAfterStop(run);
      if ((this.remainingCampaignMs() ?? 1) <= 0) {
        await this.kernel.stop(run).catch(() => undefined);
        await this.waitForTerminalAfterStop(run);
        throw new Error(`Campaign timeout ${this.ir.limits.timeoutMs}ms exceeded while running '${nodeId}'.`);
      }
      await this.awaitRunnable();
      const status = await this.kernel.status(run);
      const projected = projectKernelStatus(status);
      const hash = contentHash(projected);
      if (this.kernelStatusHashes.get(nodeId) !== hash) { this.kernelStatusHashes.set(nodeId, hash); await this.store.append("kernel.status", { nodeId, status: projected }); }
      if (status.state !== "queued" && status.state !== "running") return status;
      await delay(Math.min(this.options.pollMs ?? 250, this.remainingCampaignMs() ?? Number.POSITIVE_INFINITY));
    }
  }
  private async waitForTerminalAfterStop(run: KernelRun): Promise<KernelStatus> {
    while (true) {
      const status = await this.kernel.status(run);
      if (status.state !== "queued" && status.state !== "running") return status;
      await delay(this.options.pollMs ?? 250);
    }
  }
  private async localComplete(nodeId: string, output: unknown): Promise<unknown> { await this.store.append("node.completed", { nodeId, output }); return output; }
  private outputPathFor(nodeId: string): string { return join(this.store.runDir, "assignments", `${fileId(nodeId)}.txt`); }
  private wasManuallyRetried(nodeId: string): boolean { return this.store.state.nodes[nodeId]?.status === "scheduled"; }
  private remainingCampaignMs(): number | undefined { return this.ir.limits.timeoutMs === undefined ? undefined : Math.max(0, this.state.createdAt + this.ir.limits.timeoutMs - Date.now()); }
  private assertWithinCampaignDeadline(): void { if ((this.remainingCampaignMs() ?? 1) <= 0) throw new Error(`Campaign timeout ${this.ir.limits.timeoutMs}ms exceeded.`); }
  private context(extra: Partial<ExpressionContext> = {}): ExpressionContext { return { input: this.options.input, ...extra, outputs: this.state.outputs }; }
  private isWriterNode(id: string): boolean { const node = this.byId.get(id); if (!node) return false; if (node.kind === "agent-task") return node.capabilities.includes("code-write") || ["worker", "implementer"].includes(node.agent); if (node.kind === "sequence" || node.kind === "parallel") return node.children.some((child) => this.isWriterNode(child)); if (node.kind === "map" || node.kind === "loop") return this.isWriterNode(node.body); if (node.kind === "branch") return this.isWriterNode(node.then) || Boolean(node.else && this.isWriterNode(node.else)); return false; }

  private async requireIsolationDowngrade(nodeId: string): Promise<void> {
    if (this.approvedIsolationDowngrades.has(nodeId)) return;
    const approved = await this.options.approveIsolationDowngrade?.(nodeId) ?? false;
    if (!approved) throw new Error(`Node '${nodeId}' requires worktree isolation, but the active Campaign kernel cannot provide it.`);
    this.approvedIsolationDowngrades.add(nodeId);
  }

  private currentGateOverride(gateId: string) {
    const records = this.state.gates;
    for (let index = records.length - 1; index >= 0; index--) {
      const record = records[index]!;
      if (record.gateId === gateId && record.outcome === "overridden" && record.active !== false) return record;
    }
    return undefined;
  }

  private async recordUsage(kernelRunId: string, status: KernelStatus): Promise<void> {
    if (status.tokens === undefined && status.cost === undefined) return;
    await this.store.append("usage.recorded", { kernelRunId, tokens: status.tokens ?? 0, cost: status.cost ?? 0, state: status.state });
  }

  private retryInvalidationSet(target: string): Set<string> {
    const result = new Set<string>();
    const parents = new Map<string, string[]>();
    for (const edge of this.ir.edges) parents.set(edge.to, [...(parents.get(edge.to) ?? []), edge.from]);
    const queue = [target];
    const affected = new Set(queue);
    while (queue.length) {
      const child = queue.shift()!;
      for (const parent of parents.get(child) ?? []) {
        if (!affected.has(parent)) { affected.add(parent); result.add(parent); queue.push(parent); }
        const container = this.byId.get(parent);
        if (container?.kind === "sequence") {
          const index = container.children.indexOf(child);
          if (index >= 0) for (const later of container.children.slice(index + 1)) collectTree(later, this.byId, result);
        }
      }
    }
    for (const node of this.ir.nodes) if (node.id !== target && referencesNode(node, target)) result.add(node.id);
    return result;
  }

  private async awaitRunnable(): Promise<void> { if (this.detached) throw new Error("Campaign supervisor detached"); if (this.stopped || this.state.status === "stopped") throw new Error("Campaign stopped"); if (this.state.status !== "paused") return; await new Promise<void>((resolve) => this.pauseWaiters.push(resolve)); if (this.stopped) throw new Error("Campaign stopped"); }
}
function projectKernelStatus(status: KernelStatus): NonNullable<CampaignState["nodes"][string]["kernel"]> { const raw = status.raw as { currentTool?: string; currentPath?: string; totalTokens?: { total?: number }; totalCost?: { total?: number }; currentStep?: number; steps?: Array<{ currentTool?: string; currentPath?: string; recentOutput?: string[]; model?: string; thinking?: string }> } | undefined; const step = raw?.steps?.[raw.currentStep ?? Math.max(0, (raw.steps?.length ?? 1) - 1)]; const currentTool = raw?.currentTool ?? step?.currentTool; const currentPath = raw?.currentPath ?? step?.currentPath; return { state: status.state, ...(currentTool ? { currentTool } : {}), ...(currentPath ? { currentPath } : {}), ...(step?.recentOutput ? { recentOutput: step.recentOutput.slice(-20) } : {}), ...(step?.model ? { model: step.model } : {}), ...(step?.thinking ? { thinking: step.thinking } : {}), ...(status.tokens !== undefined ? { tokens: status.tokens } : {}), ...(status.cost !== undefined ? { cost: status.cost } : {}) }; }
async function mapConcurrent<T, R>(items: readonly T[], concurrency: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]> { const result = new Array<R>(items.length); let cursor = 0; const runners = Array.from({ length: Math.min(Math.max(1, concurrency), items.length) }, async () => { while (true) { const index = cursor++; if (index >= items.length) return; result[index] = await worker(items[index]!, index); } }); await Promise.all(runners); return result; }
function parseStructuredOutput(text: string): unknown { const fenced = text.match(/```(?:json)?\s*\n([\s\S]*?)```/i)?.[1]; for (const candidate of [fenced, text, text.match(/(?:\{[\s\S]*\}|\[[\s\S]*\])/ )?.[0]]) { if (!candidate) continue; try { return JSON.parse(candidate); } catch { /* try next bounded extraction */ } } return text; }
function fileId(id: string): string { return id.replace(/[^A-Za-z0-9._-]/g, "_"); }
function baseNodeId(id: string): string { return id.replace(/\[(?:round-)?\d+\]/g, "").replace(/:(?:verify|repair)(?::\d+)?$/, ""); }
function scopedInstanceId(childId: string, parentId: string, parentInstanceId: string, extra = ""): string {
  const suffix = parentInstanceId.startsWith(parentId) ? parentInstanceId.slice(parentId.length) : "";
  return `${childId}${suffix}${extra}`;
}
function referencesNode(node: CampaignNode, target: string): boolean {
  let found = false;
  const walk = (value: unknown) => {
    if (found || value === null || value === undefined) return;
    if (typeof value === "string") { if ([...value.matchAll(/\{\{\s*([A-Za-z0-9_.-]+)/g)].some((match) => match[1]?.split(".")[0] === target)) found = true; return; }
    if (typeof value !== "object") return;
    if ("$ref" in value && typeof (value as { $ref?: unknown }).$ref === "string" && (value as { $ref: string }).$ref.split(".")[0] === target) { found = true; return; }
    Object.values(value as Record<string, unknown>).forEach(walk);
  };
  walk(node);
  return found;
}
function collectTree(id: string, byId: Map<string, CampaignNode>, output: Set<string>): void {
  if (output.has(id)) return;
  output.add(id);
  const node = byId.get(id);
  if (!node) return;
  if (node.kind === "sequence" || node.kind === "parallel") node.children.forEach((child) => collectTree(child, byId, output));
  else if (node.kind === "map" || node.kind === "loop") collectTree(node.body, byId, output);
  else if (node.kind === "branch") { collectTree(node.then, byId, output); if (node.else) collectTree(node.else, byId, output); }
}
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
