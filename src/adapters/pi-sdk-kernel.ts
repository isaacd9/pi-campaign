import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { writeAtomic } from "../persistence/event-store.ts";
import type { CampaignKernel, KernelAssignment, KernelRun, KernelStatus } from "./kernel.ts";
import { readKernelStatus } from "./kernel-artifacts.ts";

export const CAMPAIGN_LIFECYCLE_ARTIFACT_VERSION = 1;

interface NativeRun {
  id: string;
  asyncDir: string;
  outputPath: string;
  state: KernelStatus["state"];
  assignment: KernelAssignment;
  session?: AgentSession;
  promise: Promise<void>;
  writeQueue: Promise<void>;
  outputText: string;
  output?: unknown;
  error?: string;
  currentTool?: string;
  currentPath?: string;
  recentOutput: string[];
  tokens: number;
  cost: number;
  sessionFile?: string;
  stopRequested: boolean;
  timedOut: boolean;
  turnBudgetExceeded: boolean;
  toolCalls: number;
  turns: number;
  lastProgressWrite: number;
}

let sharedModelRuntime: Promise<ModelRuntime> | undefined;

/**
 * Campaign-native assignment runtime. Campaign owns scheduling and recovery;
 * this kernel runs exactly one Pi SDK session per assignment and never sends
 * messages or completion notifications to the parent Pi conversation.
 */
export class PiSdkKernel implements CampaignKernel {
  readonly worktreeIsolation = false;
  private runs = new Map<string, NativeRun>();
  private disposed = false;

  constructor(private defaultModel?: string) {}

  async ping(): Promise<{ version: number; methods: string[] }> {
    await this.modelRuntime();
    return { version: 1, methods: ["spawn", "status", "interrupt", "stop"] };
  }

  async spawn(assignment: KernelAssignment): Promise<KernelRun> {
    if (this.disposed) throw new Error("Campaign Pi SDK kernel is disposed.");
    const id = `campaign-native-${randomUUID()}`;
    const outputPath = assignment.outputPath ?? join(assignment.cwd, ".pi", "campaign-runs", `${id}.txt`);
    const asyncDir = join(dirname(outputPath), `.runtime-${id}`);
    await mkdir(asyncDir, { recursive: true, mode: 0o700 });
    await mkdir(dirname(outputPath), { recursive: true, mode: 0o700 });
    const run: NativeRun = {
      id,
      asyncDir,
      outputPath,
      state: "queued",
      assignment,
      promise: Promise.resolve(),
      writeQueue: Promise.resolve(),
      outputText: "",
      recentOutput: [],
      tokens: 0,
      cost: 0,
      stopRequested: false,
      timedOut: false,
      turnBudgetExceeded: false,
      toolCalls: 0,
      turns: 0,
      lastProgressWrite: 0,
    };
    this.runs.set(id, run);
    await this.persist(run);
    run.promise = this.execute(run).catch(async (error) => {
      if (run.state === "complete" || run.state === "failed" || run.state === "stopped") return;
      run.state = run.stopRequested ? "stopped" : "failed";
      run.error = error instanceof Error ? error.message : String(error);
      await this.persist(run);
    });
    return { id, asyncDir, outputPath };
  }

  async status(run: KernelRun): Promise<KernelStatus> {
    const current = this.runs.get(run.id);
    if (current) return this.project(current);
    if (!run.asyncDir) return { state: "failed", error: `Unknown Campaign native run '${run.id}'.` };
    const persisted = await readKernelStatus(run.asyncDir, run.outputPath);
    if (persisted.state === "queued" || persisted.state === "running") return { ...persisted, state: "failed", error: "Campaign native SDK execution was interrupted with its owning Pi process." };
    return persisted;
  }

  async interrupt(run: KernelRun): Promise<void> { await this.stop(run); }

  async stop(run: KernelRun): Promise<void> {
    const current = this.runs.get(run.id);
    if (!current) return;
    current.stopRequested = true;
    if (current.session?.isStreaming) await current.session.abort().catch(() => undefined);
    await current.promise.catch(() => undefined);
    if (current.state === "queued" || current.state === "running") {
      current.state = "stopped";
      current.error = "Campaign assignment stopped.";
      await this.persist(current);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const run of this.runs.values()) {
      run.stopRequested = true;
      if (run.session?.isStreaming) void run.session.abort().catch(() => undefined);
      run.session?.dispose();
    }
    this.runs.clear();
  }

  private async execute(run: NativeRun): Promise<void> {
    const assignment = run.assignment;
    const runtime = await this.modelRuntime();
    if (run.stopRequested || this.disposed) { run.state = "stopped"; await this.persist(run); return; }
    const model = await resolveModel(runtime, assignment.model ?? this.defaultModel);
    const sessionDirectory = join(run.asyncDir, "session");
    await mkdir(sessionDirectory, { recursive: true, mode: 0o700 });
    const loader = new DefaultResourceLoader({
      cwd: assignment.cwd,
      agentDir: getAgentDir(),
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      systemPromptOverride: () => assignmentSystemPrompt(assignment),
      appendSystemPromptOverride: () => [],
    });
    await loader.reload();
    const tools = toolsFor(assignment);
    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: true },
      retry: { enabled: true, maxRetries: 2 },
    });
    const { session } = await createAgentSession({
      cwd: assignment.cwd,
      agentDir: getAgentDir(),
      modelRuntime: runtime,
      resourceLoader: loader,
      settingsManager,
      sessionManager: SessionManager.create(assignment.cwd, sessionDirectory),
      tools,
      ...(model ? { model } : {}),
      ...(assignment.thinking ? { thinkingLevel: assignment.thinking as ThinkingLevel } : {}),
    });
    run.session = session;
    if (session.sessionFile) run.sessionFile = session.sessionFile;
    run.state = "running";
    const unsubscribe = session.subscribe((event) => this.onEvent(run, event));
    const timeout = assignment.timeoutMs === undefined ? undefined : setTimeout(() => {
      run.timedOut = true;
      void session.abort().catch(() => undefined);
    }, assignment.timeoutMs);
    timeout?.unref();
    await this.persist(run);
    try {
      if (run.stopRequested || this.disposed) { run.state = "stopped"; return; }
      await session.prompt(assignment.task, { source: "extension" });
      this.updateUsage(run, session.messages);
      if (run.stopRequested || this.disposed) {
        run.state = "stopped";
        run.error = "Campaign assignment stopped.";
      } else if (run.timedOut) {
        run.state = "failed";
        run.error = `Campaign assignment timed out after ${assignment.timeoutMs}ms.`;
      } else if (run.turnBudgetExceeded) {
        run.state = "failed";
        run.error = "Campaign assignment exceeded its turn budget.";
      } else {
        const last = lastAssistant(session.messages);
        if (!last) throw new Error("Campaign assignment produced no assistant response.");
        if (last.stopReason === "error" || last.errorMessage) throw new Error(last.errorMessage ?? "Campaign assignment model failed.");
        const text = assistantText(last.content).trim();
        if (!text) throw new Error("Campaign assignment produced an empty final response.");
        run.output = assignment.outputSchema ? parseStructuredOutput(text) : text;
        const persistedOutput = typeof run.output === "string" ? run.output : `${JSON.stringify(run.output, null, 2)}\n`;
        await writeFile(run.outputPath, persistedOutput, { mode: 0o600 });
        run.state = "complete";
      }
    } catch (error) {
      run.state = run.stopRequested ? "stopped" : "failed";
      run.error = error instanceof Error ? error.message : String(error);
    } finally {
      if (timeout) clearTimeout(timeout);
      unsubscribe();
      delete run.currentTool;
      delete run.currentPath;
      this.updateUsage(run, session.messages);
      await this.persist(run);
      session.dispose();
      delete run.session;
    }
  }

  private onEvent(run: NativeRun, event: AgentSessionEvent): void {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      run.outputText += event.assistantMessageEvent.delta;
      run.recentOutput = run.outputText.split(/\r?\n/).slice(-20);
      this.persistProgress(run);
      return;
    }
    if (event.type === "tool_execution_start") {
      run.toolCalls++;
      run.currentTool = event.toolName;
      const currentPath = toolPath(event.args);
      if (currentPath) run.currentPath = currentPath; else delete run.currentPath;
      this.applyToolBudget(run);
      this.persistProgress(run, true);
      return;
    }
    if (event.type === "tool_execution_end") {
      delete run.currentTool;
      delete run.currentPath;
      this.persistProgress(run, true);
      return;
    }
    if (event.type === "turn_end") {
      run.turns++;
      const message = event.message as { role?: string; stopReason?: string };
      this.applyTurnBudget(run, message.role === "assistant" && message.stopReason === "toolUse");
      this.persistProgress(run, true);
    }
  }

  private applyToolBudget(run: NativeRun): void {
    const budget = run.assignment.toolBudget;
    if (!budget || run.toolCalls < budget.hard || !run.session) return;
    const blocked = budget.block ?? ["read", "grep", "find", "ls"];
    run.session.agent.state.tools = blocked === "*" ? [] : run.session.agent.state.tools.filter((tool) => !blocked.includes(tool.name));
  }

  private applyTurnBudget(run: NativeRun, needsAnotherTurn: boolean): void {
    const budget = run.assignment.turnBudget;
    if (!budget || !run.session) return;
    if (run.turns === budget.maxTurns && needsAnotherTurn && run.session.isStreaming) void run.session.steer("Turn budget reached. Stop using tools and return your complete final answer now.").catch(() => undefined);
    if (run.turns > budget.maxTurns + (budget.graceTurns ?? 0)) {
      run.turnBudgetExceeded = true;
      void run.session.abort().catch(() => undefined);
    }
  }

  private persistProgress(run: NativeRun, force = false): void {
    const now = Date.now();
    if (!force && now - run.lastProgressWrite < 200) return;
    run.lastProgressWrite = now;
    void this.persist(run).catch(() => undefined);
  }

  private persist(run: NativeRun): Promise<void> {
    const artifact = {
      campaignLifecycleArtifactVersion: CAMPAIGN_LIFECYCLE_ARTIFACT_VERSION,
      runId: run.id,
      state: run.state,
      outputFile: run.outputPath,
      ...(run.output !== undefined && typeof run.output !== "string" ? { output: run.output } : {}),
      ...(run.error ? { error: run.error } : {}),
      ...(run.currentTool ? { currentTool: run.currentTool } : {}),
      ...(run.currentPath ? { currentPath: run.currentPath } : {}),
      recentOutput: run.recentOutput,
      model: run.assignment.model,
      thinking: run.assignment.thinking,
      phase: run.assignment.phase,
      label: run.assignment.label,
      tokens: run.tokens,
      cost: run.cost,
      turns: run.turns,
      toolCalls: run.toolCalls,
      sessionFile: run.sessionFile,
      updatedAt: Date.now(),
    };
    const next = run.writeQueue.then(() => writeAtomic(join(run.asyncDir, "status.json"), artifact));
    run.writeQueue = next.catch(() => undefined);
    return next;
  }

  private project(run: NativeRun): KernelStatus {
    return {
      state: run.state,
      ...(run.output !== undefined ? { output: run.output } : {}),
      ...(run.error ? { error: run.error } : {}),
      tokens: run.tokens,
      cost: run.cost,
      raw: {
        campaignLifecycleArtifactVersion: CAMPAIGN_LIFECYCLE_ARTIFACT_VERSION,
        currentTool: run.currentTool,
        currentPath: run.currentPath,
        tokens: run.tokens,
        cost: run.cost,
        steps: [{ recentOutput: run.recentOutput, model: run.assignment.model, thinking: run.assignment.thinking }],
      },
    };
  }

  private updateUsage(run: NativeRun, messages: readonly unknown[]): void {
    let tokens = 0;
    let cost = 0;
    for (const raw of messages) {
      const message = raw as { role?: string; usage?: { totalTokens?: number; cost?: { total?: number } } };
      if (message.role !== "assistant") continue;
      tokens += message.usage?.totalTokens ?? 0;
      cost += message.usage?.cost?.total ?? 0;
    }
    run.tokens = tokens;
    run.cost = cost;
  }

  private modelRuntime(): Promise<ModelRuntime> { return sharedModelRuntime ??= ModelRuntime.create(); }
}

async function resolveModel(runtime: ModelRuntime, key: string | undefined) {
  const available = await runtime.getAvailable();
  if (!key) return available[0];
  const slash = key.indexOf("/");
  if (slash < 1) throw new Error(`Campaign model '${key}' must use provider/model syntax.`);
  const provider = key.slice(0, slash);
  const id = key.slice(slash + 1);
  const model = available.find((candidate) => candidate.provider === provider && candidate.id === id);
  if (!model) throw new Error(`Campaign model '${key}' is not authenticated or available.`);
  return model;
}

function toolsFor(assignment: KernelAssignment): string[] {
  const writer = assignment.capabilities?.includes("code-write") || ["worker", "implementer"].includes(assignment.agent);
  const shell = writer || assignment.capabilities?.includes("shell") || assignment.capabilities?.includes("tests");
  return ["read", "grep", "find", "ls", ...(shell ? ["bash"] : []), ...(writer ? ["edit", "write"] : [])];
}

function assignmentSystemPrompt(assignment: KernelAssignment): string {
  const tools = toolsFor(assignment);
  const budget = assignment.turnBudget ? `You have ${assignment.turnBudget.maxTurns} normal assistant turns and ${assignment.turnBudget.graceTurns ?? 0} grace turns.` : "";
  const toolBudget = assignment.toolBudget ? `You may make at most ${assignment.toolBudget.hard} tool calls before tools are restricted.` : "";
  const schema = assignment.outputSchema ? `Your final response must be JSON only and satisfy this schema: ${JSON.stringify(assignment.outputSchema)}` : "Return the requested result directly in your final response.";
  return `You are the '${assignment.agent}' agent for one isolated Campaign assignment${assignment.phase ? ` in phase '${assignment.phase}'` : ""}. Complete only the supplied assignment. Do not create plans for unrelated work, spawn other agents, or communicate with the parent Pi conversation. Available tools: ${tools.join(", ") || "none"}. Do not create acceptance reports or ancillary files unless the assignment explicitly requires them. ${schema} ${budget} ${toolBudget}`;
}

function toolPath(args: unknown): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  const value = args as Record<string, unknown>;
  for (const key of ["path", "file_path", "cwd", "command"]) if (typeof value[key] === "string") return String(value[key]).slice(0, 500);
  return undefined;
}

function lastAssistant(messages: readonly unknown[]): { content?: unknown; stopReason?: string; errorMessage?: string } | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index] as { role?: string; content?: unknown; stopReason?: string; errorMessage?: string };
    if (message.role === "assistant") return message;
  }
  return undefined;
}

function assistantText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.flatMap((part) => part && typeof part === "object" && (part as { type?: string }).type === "text" ? [String((part as { text?: unknown }).text ?? "")] : []).join("\n");
}

function parseStructuredOutput(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*\n([\s\S]*?)```/i)?.[1];
  for (const candidate of [fenced, text, text.match(/(?:\{[\s\S]*\}|\[[\s\S]*\])/)?.[0]]) {
    if (!candidate) continue;
    try { return JSON.parse(candidate); } catch { /* try the next bounded representation */ }
  }
  return text;
}
