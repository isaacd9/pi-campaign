import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  SessionManager,
  type AgentSession,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { CampaignState } from "../persistence/types.ts";
import { agentDir } from "../persistence/paths.ts";

export interface CampaignControlService {
  getState(runId: string, ctx?: ExtensionContext): Promise<CampaignState>;
  pause(runId: string): Promise<void>;
  resume(runId: string): Promise<void>;
  stop(runId: string): Promise<void>;
  stopNode(runId: string, nodeId: string): Promise<void>;
  retry(runId: string, nodeId: string): Promise<void>;
}

export interface OrchestratorLine { role: "user" | "assistant" | "system"; text: string }

export class CampaignOrchestratorSession {
  private listeners = new Set<() => void>();
  private lines: OrchestratorLine[] = [];
  private streamingLine = -1;
  private unsubscribe: (() => void) | undefined;
  private disposed = false;

  private constructor(private session: AgentSession) {
    this.lines = messagesToLines(session.messages);
    this.unsubscribe = session.subscribe((event) => {
      if (event.type === "message_start" && event.message.role === "assistant") {
        this.lines.push({ role: "assistant", text: "" });
        this.streamingLine = this.lines.length - 1;
        this.emit();
      } else if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
        if (this.streamingLine < 0) { this.lines.push({ role: "assistant", text: "" }); this.streamingLine = this.lines.length - 1; }
        this.lines[this.streamingLine]!.text += event.assistantMessageEvent.delta;
        this.emit();
      } else if (event.type === "tool_execution_start") {
        this.lines.push({ role: "system", text: `tool: ${event.toolName}` });
        this.emit();
      } else if (event.type === "message_end" && event.message.role === "assistant") {
        this.streamingLine = -1;
        this.emit();
      }
    });
  }

  static async create(runId: string, runDirectory: string, cwd: string, ctx: ExtensionContext, service: CampaignControlService): Promise<CampaignOrchestratorSession> {
    const sessionDir = join(runDirectory, "orchestrator");
    await mkdir(sessionDir, { recursive: true, mode: 0o700 });
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir: agentDir(),
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPrompt: orchestratorPrompt(runId),
    });
    await resourceLoader.reload();
    const customTools = campaignTools(runId, ctx, service);
    const { session } = await createAgentSession({
      cwd,
      agentDir: agentDir(),
      sessionManager: SessionManager.continueRecent(cwd, sessionDir),
      resourceLoader,
      customTools,
      tools: customTools.map((tool) => tool.name),
      ...(ctx.model ? { model: ctx.model } : {}),
    });
    return new CampaignOrchestratorSession(session);
  }

  get transcript(): readonly OrchestratorLine[] { return this.lines; }
  get isStreaming(): boolean { return this.session.isStreaming; }
  get sessionFile(): string | undefined { return this.session.sessionFile; }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }

  async send(text: string): Promise<void> {
    if (this.disposed) throw new Error("Campaign orchestrator session is closed.");
    const prompt = text.trim();
    if (!prompt) return;
    this.lines.push({ role: "user", text: prompt });
    this.emit();
    if (this.session.isStreaming) await this.session.steer(prompt);
    else await this.session.prompt(prompt, { source: "interactive" });
  }

  async abort(): Promise<void> { await this.session.abort(); }
  dispose(): void { if (this.disposed) return; this.disposed = true; this.unsubscribe?.(); this.unsubscribe = undefined; this.listeners.clear(); this.session.dispose(); }
  private emit(): void { for (const listener of this.listeners) listener(); }
}

function campaignTools(runId: string, ctx: ExtensionContext, service: CampaignControlService) {
  const status = defineTool({
    name: "campaign_status",
    label: "Campaign status",
    description: "Read the authoritative current campaign state, nodes, gates, outputs, and usage.",
    parameters: Type.Object({}),
    execute: async () => {
      const state = await service.getState(runId, ctx);
      return textResult(JSON.stringify(state, null, 2));
    },
  });
  const control = defineTool({
    name: "campaign_control",
    label: "Campaign control",
    description: "Pause, resume, or stop the campaign; stop one selected agent; or retry a campaign node. Mutations are auditable campaign actions.",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("pause"), Type.Literal("resume"), Type.Literal("stop"), Type.Literal("stop-agent"), Type.Literal("retry")]),
      nodeId: Type.Optional(Type.String()),
    }),
    execute: async (_toolCallId, params) => {
      if ((params.action === "stop-agent" || params.action === "retry") && !params.nodeId) throw new Error(`${params.action} requires nodeId.`);
      if (params.action === "pause") await service.pause(runId);
      else if (params.action === "resume") await service.resume(runId);
      else if (params.action === "stop") await service.stop(runId);
      else if (params.action === "stop-agent") await service.stopNode(runId, params.nodeId!);
      else await service.retry(runId, params.nodeId!);
      return textResult(`${params.action}${params.nodeId ? ` ${params.nodeId}` : ""} completed.`);
    },
  });
  return [status, control];
}

function textResult(text: string) { return { content: [{ type: "text" as const, text }], details: {} }; }
function orchestratorPrompt(runId: string): string {
  return `You are the dedicated control-plane orchestrator for Campaign ${runId}. The campaign—not the repository—is the first-class object in this conversation. Help the user understand live progress, failures, checkpoints, outputs, and next actions. Call campaign_status before making claims about current state. Use campaign_control only when the user explicitly asks for a mutation. Never edit repository files or run shell commands. Do not claim that pi-subagents RPC v1 supports native child steering, resume, or append-step; Campaign supports campaign-level pause, retry, stop-agent, and stop. Be concise and operational.`;
}

function messagesToLines(messages: readonly unknown[]): OrchestratorLine[] {
  const lines: OrchestratorLine[] = [];
  for (const raw of messages) {
    const message = raw as { role?: string; content?: unknown };
    if (message.role !== "user" && message.role !== "assistant") continue;
    const text = messageText(message.content);
    if (text) lines.push({ role: message.role, text });
  }
  return lines;
}
function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => part && typeof part === "object" && (part as { type?: string }).type === "text" ? String((part as { text?: unknown }).text ?? "") : "").filter(Boolean).join("\n");
}
