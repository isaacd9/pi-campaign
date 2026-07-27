import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Ajv } from "ajv";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { compileCampaign } from "../compiler/index.ts";
import { DEFAULT_HARD_CAPS, type CampaignIR, type HardCaps, type ThinkingLevel } from "../dsl/types.ts";
import { GateExecutor } from "../gates/index.ts";
import { extractCampaignCandidate, extractCampaignSource, generatorPrompt, repairPrompt } from "../generator/index.ts";
import { ModelRouter, type AvailableModel } from "../model-router/index.ts";
import { EventStore } from "../persistence/event-store.ts";
import { RunLease } from "../persistence/lease.ts";
import { loadSavedCampaign, runDir, runRoot, saveCampaign } from "../persistence/paths.ts";
import type { CampaignState } from "../persistence/types.ts";
import { createId, safeName } from "../shared/ids.ts";
import type { CampaignKernel, KernelRun, KernelStatus } from "../adapters/kernel.ts";
import { PiSdkKernel } from "../adapters/pi-sdk-kernel.ts";
import { CampaignSupervisor } from "../supervisor/supervisor.ts";
import { withCwdWriterLock } from "../supervisor/writer-lock.ts";
import { CampaignOrchestratorSession } from "../orchestrator/session.ts";
export interface CampaignConfig { launchPolicy: "always" | "smart" | "never"; ultracode: boolean; hardCaps: HardCaps; pollMs: number }
export const DEFAULT_CONFIG: CampaignConfig = { launchPolicy: "smart", ultracode: true, hardCaps: DEFAULT_HARD_CAPS, pollMs: 500 };
interface ActiveRun { supervisor: CampaignSupervisor; kernel: CampaignKernel; lease: RunLease; promise?: Promise<CampaignState>; dormant: boolean }
interface BootstrapRun { kernel: CampaignKernel; store: EventStore; currentRun?: KernelRun; currentNodeId?: string }
export class CampaignService {
  private active = new Map<string, ActiveRun>(); private bootstrapRuns = new Map<string, BootstrapRun>(); private bootstrapKernels = new Set<CampaignKernel>(); private bootstrapLeases = new Set<RunLease>(); private orchestrators = new Map<string, CampaignOrchestratorSession>(); private uiDisposers = new Set<() => void>(); private statusStates = new Map<string, CampaignState>(); private statusUnsubscribers = new Map<string, () => void>(); private context?: ExtensionContext; private disposed = false;
  constructor(private pi: ExtensionAPI, public config: CampaignConfig = DEFAULT_CONFIG) {}
  setContext(ctx: ExtensionContext): void { this.context = ctx; }
  registerUiDisposer(disposer: () => void): () => void { this.uiDisposers.add(disposer); return () => this.uiDisposers.delete(disposer); }
  async startGoal(goal: string, ctx: ExtensionContext): Promise<string> {
    const runId = createId("campaign"); const sessionId = ctx.sessionManager.getSessionId() ?? "ephemeral"; const dir = runDir(sessionId, runId); await mkdir(dir, { recursive: true, mode: 0o700 });
    const store = await EventStore.create(dir, runId, goal, ctx.cwd); this.watchStore(store, ctx); await store.append("run.started", { bootstrap: true }); this.pi.appendEntry("campaign-run", { runId, status: "generating", runDir: dir });
    void this.generateAndLaunch(goal, ctx, store).catch(async (error) => { if (this.disposed || store.state.status === "stopped") return; await store.append("run.failed", { error: error instanceof Error ? error.message : String(error) }); });
    return runId;
  }
  async runSource(source: string, goal: string, ctx: ExtensionContext, existing?: EventStore, input?: unknown): Promise<string> {
    const authenticatedModels = await this.availableModels(ctx);
    const compiled = compileCampaign(source, { hardCaps: this.config.hardCaps, availableModels: authenticatedModels.map((model) => `${model.provider}/${model.id}`) }); const sessionId = ctx.sessionManager.getSessionId() ?? "ephemeral"; const runId = existing?.state.runId ?? createId("campaign"); const dir = existing?.runDir ?? runDir(sessionId, runId); await mkdir(join(dir, "assignments"), { recursive: true, mode: 0o700 }); await writeFile(join(dir, "source.campaign.ts"), source, { mode: 0o600 }); await writeFile(join(dir, "campaign.ir.json"), `${JSON.stringify(compiled.ir, null, 2)}\n`, { mode: 0o600 }); if (compiled.ir.inputSchema) { const validate = new Ajv({ allErrors: true, strict: false }).compile(compiled.ir.inputSchema); if (!validate(input)) throw new Error(`Campaign input failed schema: ${new Ajv().errorsText(validate.errors)}`); } const store = existing ?? await EventStore.create(dir, runId, goal, ctx.cwd); this.watchStore(store, ctx); await store.append("run.created", { ir: compiled.ir, summary: compiled.summary, irHash: compiled.irHash, ...(input !== undefined ? { input } : {}) }); this.pi.appendEntry("campaign-run", { runId, status: "compiled", sourceHash: compiled.ir.sourceHash, irHash: compiled.irHash });
    const approval = this.config.launchPolicy === "always" || (this.config.launchPolicy === "smart" && requiresLaunchApproval(compiled.ir));
    if (approval) {
      // Background generation must never interrupt the parent editor with a
      // late modal. The inspector is the explicit control plane: `p` resumes
      // this durably paused run and therefore approves launch.
      await store.append("run.paused", { reason: "launch approval required; open /campaign-inspect and press p to launch" });
      return runId;
    }
    await this.launch(compiled.ir, store, ctx, input); return runId;
  }
  async runSaved(name: string, input: unknown, ctx: ExtensionCommandContext): Promise<string> { const { source } = await loadSavedCampaign(ctx.cwd, ctx.isProjectTrusted(), name); return this.runSource(source, `saved:${name}`, ctx, undefined, input); }
  async save(runId: string, name: string | undefined, scope: "personal" | "project", ctx: ExtensionCommandContext): Promise<string> { const state = await this.getState(runId, ctx); if (!state.ir) throw new Error("Run has no compiled campaign source yet."); const source = await readFile(join(runDir(ctx.sessionManager.getSessionId() ?? "ephemeral", runId), "source.campaign.ts"), "utf8"); return saveCampaign(name ?? state.ir.meta.name, source, ctx.cwd, scope); }
  async list(ctx: ExtensionContext): Promise<CampaignState[]> {
    const root = runRoot(ctx.sessionManager.getSessionId() ?? "ephemeral");
    try {
      const ids = await readdir(root);
      const states = await Promise.all(ids.map(async (id) => {
        try { return (await EventStore.open(join(root, id))).store.state; }
        catch { return undefined; }
      }));
      return states.filter((state): state is CampaignState => Boolean(state)).sort((a, b) => b.updatedAt - a.updatedAt);
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  }
  async getState(runId: string, ctx = this.context): Promise<CampaignState> { if (!ctx) throw new Error("No active Campaign context."); const active = this.active.get(runId); if (active) return active.supervisor.state; const { store } = await EventStore.open(runDir(ctx.sessionManager.getSessionId() ?? "ephemeral", safeName(runId))); return store.state; }
  async getOrchestrator(runId: string, ctx: ExtensionContext): Promise<CampaignOrchestratorSession> {
    const existing = this.orchestrators.get(runId);
    if (existing) return existing;
    const state = await this.getState(runId, ctx);
    const directory = runDir(ctx.sessionManager.getSessionId() ?? "ephemeral", safeName(runId));
    const orchestrator = await CampaignOrchestratorSession.create(runId, directory, state.cwd, ctx, this);
    this.orchestrators.set(runId, orchestrator);
    return orchestrator;
  }
  async stop(runId: string): Promise<void> {
    const run = this.active.get(runId);
    if (run) { await run.supervisor.stop(); return; }
    const bootstrap = this.bootstrapRuns.get(runId);
    if (!bootstrap) {
      const ctx = this.context;
      if (!ctx) throw new Error(`Campaign '${runId}' is not active.`);
      const { store } = await EventStore.open(runDir(ctx.sessionManager.getSessionId() ?? "ephemeral", safeName(runId)));
      this.watchStore(store, ctx);
      if (store.state.status !== "paused") throw new Error(`Campaign '${runId}' is not active.`);
      await store.append("run.stopped", { reason: "user" });
      return;
    }
    if (bootstrap.currentRun) await bootstrap.kernel.stop(bootstrap.currentRun).catch(() => undefined);
    if (bootstrap.currentNodeId && ["scheduled", "running"].includes(bootstrap.store.state.nodes[bootstrap.currentNodeId]?.status ?? "")) await bootstrap.store.append("node.interrupted", { nodeId: bootstrap.currentNodeId, error: "Generator stopped from Campaign inspector." });
    await bootstrap.store.append("run.stopped", { reason: "user" });
  }
  async stopNode(runId: string, nodeId: string): Promise<void> {
    const bootstrap = this.bootstrapRuns.get(runId);
    if (bootstrap?.currentNodeId === nodeId) { await this.stop(runId); return; }
    const run = this.active.get(runId);
    if (!run) throw new Error(`Campaign '${runId}' is not active.`);
    await run.supervisor.skip(nodeId, "agent stopped from Campaign inspector");
  }
  async pause(runId: string): Promise<void> { const run = this.requireActive(runId); await run.supervisor.pause(); }
  async resume(runId: string): Promise<void> { let run = this.active.get(runId); if (!run) run = await this.activatePersisted(runId); await run.supervisor.resume(); if (run.dormant) { run.dormant = false; run.promise = run.supervisor.run().finally(() => this.cleanup(runId)); } }
  async retry(runId: string, nodeId: string): Promise<void> { let run = this.active.get(runId); if (!run) run = await this.activatePersisted(runId); await run.supervisor.retry(nodeId); if (run.dormant) { run.dormant = false; run.promise = run.supervisor.run().finally(() => this.cleanup(runId)); } }
  async skip(runId: string, nodeId: string): Promise<void> { let run = this.active.get(runId); if (!run) run = await this.activatePersisted(runId); await run.supervisor.skip(nodeId); if (run.dormant) { run.dormant = false; run.promise = run.supervisor.run().finally(() => this.cleanup(runId)); } }
  async editPrompt(runId: string, nodeId: string, prompt: string): Promise<void> { let run = this.active.get(runId); if (!run) run = await this.activatePersisted(runId); await run.supervisor.editPendingPrompt(nodeId, prompt); }
  async overrideModel(runId: string, nodeId: string, model: string, thinking?: ThinkingLevel): Promise<void> { const ctx = this.context; if (!ctx) throw new Error("No active Campaign context."); const catalog = await this.availableModels(ctx); const selected = catalog.find((item) => `${item.provider}/${item.id}` === model); if (!selected) throw new Error(`Model '${model}' is not authenticated or available.`); if (thinking && !(["off", "minimal", "low", "medium", "high", "xhigh", "max"] as string[]).includes(thinking)) throw new Error(`Invalid thinking level '${thinking}'.`); const effectiveThinking = clampOverrideThinking(selected, thinking ?? "medium"); let run = this.active.get(runId); if (!run) run = await this.activatePersisted(runId); await run.supervisor.overrideModel(nodeId, model, effectiveThinking); }
  async overrideGate(runId: string, gateId: string, reason?: string): Promise<void> { let run = this.active.get(runId); if (!run) run = await this.activatePersisted(runId); await run.supervisor.overrideGate(gateId, reason); if (run.dormant) { run.dormant = false; run.promise = run.supervisor.run().finally(() => this.cleanup(runId)); } }
  async restore(ctx: ExtensionContext): Promise<void> {
    for (const listed of await this.list(ctx)) {
      if (this.active.has(listed.runId)) continue;
      try {
        const { store } = await EventStore.open(runDir(ctx.sessionManager.getSessionId() ?? "ephemeral", listed.runId));
        this.watchStore(store, ctx);
        const state = store.state; // snapshot list entries are hints; replayed log state decides restoration
        if (!shouldRestoreState(state)) continue;
        if (!state.ir) {
          await store.append("node.interrupted", { nodeId: "campaign-generator", error: "Generator was interrupted before compilation; safe read-only generation will restart." });
          void this.generateAndLaunch(state.goal, ctx, store).catch(async (error) => { if (!this.disposed) await store.append("run.failed", { error: error instanceof Error ? error.message : String(error) }); });
          continue;
        }
        const kernel = new PiSdkKernel(activeModelKey(ctx));
        const lease = await RunLease.acquire(store.runDir, createId("restore"));
        const supervisor = this.makeSupervisor(state.ir, store, kernel, ctx, state.input);
        await supervisor.recoverInterrupted();
        const dormant = store.state.status === "paused";
        const promise = dormant ? undefined : supervisor.run().finally(() => this.cleanup(state.runId));
        this.active.set(state.runId, { supervisor, kernel, lease, ...(promise ? { promise } : {}), dormant });
      } catch (error) { this.notify(ctx, `Could not restore ${listed.runId}: ${error instanceof Error ? error.message : String(error)}`, "warning"); }
    }
    this.updateStatus(ctx);
  }
  async doctor(ctx: ExtensionContext): Promise<string> { const lines = ["Campaign doctor", `storage: ${runRoot(ctx.sessionManager.getSessionId() ?? "ephemeral")}`]; try { await import("typebox/compile"); lines.push("typebox/compile: ok"); } catch (error) { lines.push(`typebox/compile: MISSING (${error instanceof Error ? error.message : String(error)})`, "remediation: install typebox at the Pi package root, then /reload"); } try { const kernel = new PiSdkKernel(); const ping = await kernel.ping(); kernel.dispose(); lines.push(`Campaign Pi SDK kernel: v${ping.version} (${ping.methods.join(", ")})`); } catch (error) { lines.push(`Campaign Pi SDK kernel: unavailable (${error instanceof Error ? error.message : String(error)})`); } try { const models = await ctx.modelRegistry.getAvailable(); lines.push(`authenticated models: ${models.length}`); } catch (error) { lines.push(`authenticated models: error (${String(error)})`); } try { const probe = join(runRoot(ctx.sessionManager.getSessionId() ?? "ephemeral"), `.doctor-${process.pid}`); await mkdir(probe, { recursive: true }); await writeFile(join(probe, "probe"), "ok"); await import("node:fs/promises").then(({ rm }) => rm(probe, { recursive: true, force: true })); lines.push("storage probe: ok"); } catch (error) { lines.push(`storage probe: failed (${String(error)})`); } lines.push("Campaign owns assignment sessions directly through Pi's public SDK; interrupted sessions use persisted campaign-level recovery."); return lines.join("\n"); }
  async dispose(): Promise<void> {
    this.disposed = true;
    for (const orchestrator of this.orchestrators.values()) { if (orchestrator.isStreaming) await orchestrator.abort().catch(() => undefined); orchestrator.dispose(); }
    this.orchestrators.clear();
    for (const unsubscribe of this.statusUnsubscribers.values()) unsubscribe();
    this.statusUnsubscribers.clear();
    this.statusStates.clear();
    for (const dispose of [...this.uiDisposers]) dispose();
    this.uiDisposers.clear();
    for (const [runId, bootstrap] of this.bootstrapRuns) {
      if (bootstrap.currentRun) await bootstrap.kernel.stop(bootstrap.currentRun).catch(() => undefined);
      if (bootstrap.currentNodeId && ["scheduled", "running"].includes(bootstrap.store.state.nodes[bootstrap.currentNodeId]?.status ?? "")) await bootstrap.store.append("node.interrupted", { nodeId: bootstrap.currentNodeId, error: "Generator quiesced during Pi session shutdown." });
      await bootstrap.store.append("run.paused", { reason: "session-shutdown" });
      bootstrap.kernel.dispose();
      this.bootstrapRuns.delete(runId);
    }
    for (const kernel of this.bootstrapKernels) kernel.dispose();
    this.bootstrapKernels.clear();
    for (const lease of this.bootstrapLeases) await lease.release();
    this.bootstrapLeases.clear();
    for (const [id, run] of [...this.active]) {
      await run.supervisor.quiesceForRestart().catch(() => undefined);
      await run.promise?.catch(() => undefined);
      await run.supervisor.markRestartPaused();
      run.kernel.dispose();
      await run.lease.release();
      this.active.delete(id);
    }
    if (this.context) this.context.ui.setStatus("campaign", undefined);
  }
  private async generateAndLaunch(goal: string, ctx: ExtensionContext, store: EventStore): Promise<void> {
    const models = await this.availableModels(ctx); const decision = new ModelRouter(models).routeSync({ taskClass: "generation", prompt: goal, risk: "medium" }); await mkdir(join(store.runDir, "router"), { recursive: true }); await mkdir(join(store.runDir, "assignments"), { recursive: true, mode: 0o700 }); await writeFile(join(store.runDir, "router", "generation.json"), `${JSON.stringify(decision, null, 2)}\n`, { mode: 0o600 }); const bootstrapLease = await RunLease.acquire(store.runDir, createId("generator")); this.bootstrapLeases.add(bootstrapLease); const kernel = new PiSdkKernel(activeModelKey(ctx)); this.bootstrapKernels.add(kernel); const bootstrap: BootstrapRun = { kernel, store }; this.bootstrapRuns.set(store.state.runId, bootstrap); this.updateStatus(ctx); let prompt = generatorPrompt(goal, this.config.hardCaps); let source = "";
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        const nodeId = attempt === 0 ? "campaign-generator" : `campaign-generator-repair-${attempt}`;
        await store.append("node.scheduled", { nodeId, attempt: attempt + 1 });
        const run = await kernel.spawn({ agent: "scout", task: prompt, cwd: ctx.cwd, model: decision.model, phase: "Generate", label: `generator-${attempt + 1}`, outputPath: join(store.runDir, "assignments", `${nodeId}.txt`), acceptance: { level: "none", reason: "Generator output is validated by the restricted Campaign compiler." }, turnBudget: { maxTurns: 2, graceTurns: 1 }, toolBudget: { hard: 1, block: "*" } });
        bootstrap.currentRun = run; bootstrap.currentNodeId = nodeId;
        await store.append("node.started", { nodeId, kernelRunId: run.id, asyncDir: run.asyncDir, countAgent: false });
        const status = await this.wait(run, kernel);
        await this.recordUsage(store, run.id, status);
        if (status.state !== "complete") { const error = status.error ?? `Generator kernel ${status.state}`; await store.append("node.failed", { nodeId, error }); throw new Error(error); }
        const output = status.output;
        await store.append("node.completed", { nodeId, output });
        const candidate = extractCampaignCandidate(output);
        try { source = extractCampaignSource(output); compileCampaign(source, { hardCaps: this.config.hardCaps }); break; }
        catch (error) { if (attempt === 2) throw error; prompt = repairPrompt(candidate, error); }
      }
    } finally { this.bootstrapRuns.delete(store.state.runId); this.bootstrapKernels.delete(kernel); kernel.dispose(); this.bootstrapLeases.delete(bootstrapLease); await bootstrapLease.release(); this.updateStatus(ctx); }
    if (this.disposed) return; await this.runSource(source, goal, ctx, store);
  }
  private async launch(ir: CampaignIR, store: EventStore, ctx: ExtensionContext, input?: unknown): Promise<void> { if (this.disposed) throw new Error("Campaign service disposed"); const kernel = new PiSdkKernel(activeModelKey(ctx)); await kernel.ping(); const lease = await RunLease.acquire(store.runDir, createId("owner")); const supervisor = this.makeSupervisor(ir, store, kernel, ctx, input); const promise = supervisor.run().then((state) => { if (!this.disposed) this.pi.appendEntry("campaign-run", { runId: state.runId, status: state.status, updatedAt: state.updatedAt }); return state; }).finally(() => this.cleanup(store.state.runId)); this.active.set(store.state.runId, { supervisor, kernel, lease, promise, dormant: false }); this.updateStatus(ctx); }
  private makeSupervisor(ir: CampaignIR, store: EventStore, kernel: CampaignKernel, ctx: ExtensionContext, input?: unknown): CampaignSupervisor {
    const routerPromise = this.availableModels(ctx).then((models) => new ModelRouter(models));
    const gates = new GateExecutor(ctx.cwd, {
      approve: (prompt) => ctx.hasUI ? ctx.ui.confirm("Campaign checkpoint", prompt) : Promise.resolve(false),
      safety: (prompt, capabilities) => ctx.hasUI ? ctx.ui.confirm("Campaign safety checkpoint", `${prompt}\nCapabilities: ${capabilities.join(", ")}`) : Promise.resolve(false),
      review: async (focus, agent = "reviewer") => {
        if (store.state.agentsStarted >= ir.limits.maxAgents) throw new Error(`Runtime maxAgents ${ir.limits.maxAgents} reached before review gate.`);
        const reviewId = `review-gate-${store.state.gates.length + 1}`;
        const task = `Independently review the campaign work. Focus: ${focus}. Return JSON only: {\"verdict\": \"pass\" | \"fail\", \"evidence\": string, \"findings\": string[]}.`;
        await store.append("node.scheduled", { nodeId: reviewId, attempt: 1 });
        const decision = await (await routerPromise).route({ taskClass: "review", prompt: task, risk: "medium" });
        await store.append("model.routed", { nodeId: reviewId, decision });
        const run = await kernel.spawn({ agent, task, cwd: ctx.cwd, phase: "Review", label: "review-gate", model: decision.model, thinking: decision.thinking, outputSchema: { type: "object", required: ["verdict", "evidence", "findings"] }, outputPath: join(store.runDir, "assignments", `${reviewId}.txt`) });
        await store.append("node.started", { nodeId: reviewId, kernelRunId: run.id, asyncDir: run.asyncDir });
        const status = await this.wait(run, kernel);
        await this.recordUsage(store, run.id, status);
        if (status.state !== "complete") throw new Error(status.error ?? `Review kernel ${status.state}`);
        const output = status.output;
        await store.append("node.completed", { nodeId: reviewId, output });
        let verdict: unknown = output;
        if (typeof output === "string") { const json = output.match(/\{[\s\S]*\}/)?.[0]; try { verdict = json ? JSON.parse(json) : output; } catch { verdict = output; } }
        const passed = typeof verdict === "object" && verdict !== null ? String((verdict as { verdict?: unknown }).verdict).toLowerCase() === "pass" : /^\s*PASS\b/i.test(String(verdict));
        return { passed, evidence: verdict };
      },
      acceptance: async (node) => ({ passed: store.state.nodes[node]?.status === "completed", evidence: store.state.nodes[node] }),
    });
    return new CampaignSupervisor(ir, store, kernel, gates, {
      pollMs: this.config.pollMs,
      ...(input !== undefined ? { input } : {}),
      approveIsolationDowngrade: async (nodeId) => ctx.hasUI && ctx.ui.confirm("Worktree isolation unavailable", `Campaign node '${nodeId}' requires concurrent isolated writers, but the Campaign Pi SDK kernel does not yet provide worktrees for these launches. Serialize the writers in the active worktree instead?`),
      withWriterLock: (work) => withCwdWriterLock(ctx.cwd, work),
      route: async (node, instanceId) => {
        const writer = node.capabilities.includes("code-write") || ["worker", "implementer"].includes(node.agent);
        const decision = await (await routerPromise).route({ taskClass: writer ? "implementation" : node.agent === "reviewer" ? "review" : node.agent === "architect" ? "synthesis" : "scout", prompt: typeof node.prompt === "string" ? node.prompt : JSON.stringify(node.prompt), writer, risk: writer ? "medium" : "low" });
        await mkdir(join(store.runDir, "router"), { recursive: true, mode: 0o700 });
        await writeFile(join(store.runDir, "router", `${instanceId.replace(/[^A-Za-z0-9._-]/g, "_")}.json`), `${JSON.stringify(decision, null, 2)}\n`, { mode: 0o600 });
        await store.append("model.routed", { nodeId: instanceId, decision });
        return decision;
      },
      // Milestones stay in the durable campaign log and inspector. They never
      // inject messages into the parent Pi conversation.
      emit: () => undefined,
    });
  }
  private async wait(run: KernelRun, kernel: CampaignKernel): Promise<KernelStatus> {
    while (true) {
      const status = await kernel.status(run);
      if (status.state === "complete") return status;
      if (["failed", "paused", "stopped"].includes(status.state)) return status;
      await new Promise((resolve) => setTimeout(resolve, this.config.pollMs));
    }
  }
  private async recordUsage(store: EventStore, kernelRunId: string, status: KernelStatus): Promise<void> {
    if (status.tokens === undefined && status.cost === undefined) return;
    await store.append("usage.recorded", { kernelRunId, tokens: status.tokens ?? 0, cost: status.cost ?? 0, state: status.state });
  }
  private async availableModels(ctx: ExtensionContext): Promise<AvailableModel[]> { const models = await ctx.modelRegistry.getAvailable(); return models.map((model) => ({ provider: model.provider, id: model.id, name: model.name, reasoning: model.reasoning, ...(model.thinkingLevelMap ? { thinkingLevelMap: model.thinkingLevelMap as NonNullable<AvailableModel["thinkingLevelMap"]> } : {}), input: [...model.input], contextWindow: model.contextWindow, maxTokens: model.maxTokens, cost: model.cost })); }
  private async activatePersisted(id: string): Promise<ActiveRun> { const ctx = this.context; if (!ctx) throw new Error("No active Campaign context."); const { store } = await EventStore.open(runDir(ctx.sessionManager.getSessionId() ?? "ephemeral", id)); this.watchStore(store, ctx); if (!store.state.ir) throw new Error(`Campaign '${id}' has no compiled IR.`); const kernel = new PiSdkKernel(activeModelKey(ctx)); await kernel.ping(); const lease = await RunLease.acquire(store.runDir, createId("retry")); const supervisor = this.makeSupervisor(store.state.ir, store, kernel, ctx, store.state.input); const run: ActiveRun = { supervisor, kernel, lease, dormant: true }; this.active.set(id, run); this.updateStatus(ctx); return run; }
  private requireActive(id: string): ActiveRun { const run = this.active.get(id); if (!run) throw new Error(`Campaign '${id}' is not active.`); return run; }
  private cleanup(id: string): void { const run = this.active.get(id); if (!run) return; run.kernel.dispose(); void run.lease.release(); this.active.delete(id); if (this.context) this.updateStatus(this.context); }
  private watchStore(store: EventStore, ctx: ExtensionContext): void {
    const runId = store.state.runId;
    this.statusUnsubscribers.get(runId)?.();
    const update = (state: CampaignState) => { this.statusStates.set(runId, state); this.updateStatus(ctx); };
    update(store.state);
    this.statusUnsubscribers.set(runId, store.subscribe((state) => update(state)));
  }
  private updateStatus(ctx: ExtensionContext): void {
    const states = [...this.statusStates.values()];
    const latest = states.sort((a, b) => b.updatedAt - a.updatedAt)[0];
    if (!latest) { ctx.ui.setStatus("campaign", undefined); return; }
    const activeCount = states.filter((state) => state.status === "running" || state.status === "paused").length;
    const status = !latest.ir && latest.status === "running" ? "generating" : latest.status;
    const nodes = Object.values(latest.nodes);
    const done = nodes.filter((node) => ["completed", "skipped"].includes(node.status)).length;
    const progress = nodes.length ? ` · ${done}/${nodes.length}` : "";
    const multiple = activeCount > 1 ? ` · ${activeCount} active` : "";
    const timestamp = new Date(latest.updatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    const color = status === "failed" ? "error" : status === "paused" || status === "stopped" ? "warning" : status === "completed" ? "success" : "accent";
    ctx.ui.setStatus("campaign", ctx.ui.theme.fg(color, `campaign ${status}${progress}${multiple} · ${timestamp}`));
  }
  private notify(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error"): void { if (ctx.hasUI) ctx.ui.notify(message, level); else console.error(message); }
}
function clampOverrideThinking(model: AvailableModel, requested: ThinkingLevel): ThinkingLevel { if (!model.reasoning) return "off"; const levels: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"]; const map = model.thinkingLevelMap; const start = levels.indexOf(requested); for (let distance = 0; distance < levels.length; distance++) for (const index of [start - distance, start + distance]) { const level = levels[index]; if (!level || map?.[level] === null || ((level === "xhigh" || level === "max") && map?.[level] === undefined)) continue; return level; } return "off"; }
export function shouldRestoreState(state: CampaignState): boolean {
  const hasInterruptedWork = Object.values(state.nodes).some((node) => node.status === "interrupted" || node.status === "scheduled" || node.status === "running");
  // Generation is read-only and can be started explicitly again. A failed
  // pre-IR generator must not become a permanent reload-triggered respawner.
  if (!state.ir && state.status === "failed") return false;
  return ["running", "paused"].includes(state.status) || (state.status === "failed" && hasInterruptedWork);
}
function activeModelKey(ctx: ExtensionContext): string | undefined { return ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined; }
function requiresLaunchApproval(ir: CampaignIR): boolean { const agentTasks = ir.nodes.filter((node) => node.kind === "agent-task"); const writers = agentTasks.filter((node) => node.capabilities.includes("code-write") || ["worker", "implementer"].includes(node.agent)); const riskyGate = ir.nodes.some((node) => node.kind === "gate" && ["command", "safety"].includes(node.check.type)); return ir.limits.maxAgents > 25 || ir.limits.maxTokens > 1_500_000 || writers.length > 1 || riskyGate; }
