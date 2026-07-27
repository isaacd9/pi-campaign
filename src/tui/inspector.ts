import { matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component, type Focusable, type TUI } from "@earendil-works/pi-tui";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CampaignState, NodeState } from "../persistence/types.ts";
import type { CampaignService } from "../commands/service.ts";
import type { CampaignOrchestratorSession, OrchestratorLine } from "../orchestrator/session.ts";
import { readSubagentStatus } from "../adapters/subagents-artifacts-v2.ts";
import { ControlInput } from "./input.ts";

const REFRESH_MS = 750;
const TRANSCRIPT_LINES = 300;
type Theme = ExtensionContext["ui"]["theme"];
interface InspectorOptions {
  service: CampaignService;
  orchestrator: CampaignOrchestratorSession;
  runId: string;
  initial: CampaignState;
  tui: TUI;
  theme: Theme;
  confirm(title: string, message: string): Promise<boolean>;
  inputReason(title: string, placeholder: string): Promise<string | undefined>;
  done(): void;
}

export class CampaignInspector implements Component, Focusable {
  private state: CampaignState;
  private selected = 0;
  private selectedKey: string | undefined;
  private detailLines: string[] = [];
  private detailScroll = 0;
  private detailAutoFollow = true;
  private chatScroll = 0;
  private chatAutoFollow = true;
  private bodyHeight = 8;
  private chatHeight = 6;
  private panel: "campaign" | "chat" = "chat";
  private notices: string[] = [];
  private timer: NodeJS.Timeout;
  private unregister: (() => void) | undefined;
  private unsubscribeOrchestrator: (() => void) | undefined;
  private disposed = false;
  private refreshing = false;
  private input: ControlInput;
  private _focused = true;

  get focused(): boolean { return this._focused; }
  set focused(value: boolean) { this._focused = value; this.input.focused = value && this.panel === "chat"; }

  constructor(private options: InspectorOptions) {
    this.state = options.initial;
    this.input = new ControlInput((value) => void this.submit(value));
    this.input.focused = true;
    this.unregister = options.service.registerUiDisposer(() => this.dispose());
    this.unsubscribeOrchestrator = options.orchestrator.subscribe(() => { this.chatAutoFollow = true; options.tui.requestRender(); });
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), REFRESH_MS);
    this.timer.unref();
  }

  render(width: number): string[] {
    if (width < 44) return [truncateToWidth("Campaign workspace needs at least 44 columns. Esc closes.", width)];
    const theme = this.options.theme;
    const innerWidth = width - 2;
    const rows = this.options.tui.terminal?.rows ?? 32;
    const usable = Math.max(12, rows - 10);
    this.bodyHeight = Math.max(5, Math.floor(usable * 0.52));
    this.chatHeight = Math.max(4, usable - this.bodyHeight);
    const rosterWidth = Math.max(24, Math.min(48, Math.floor((innerWidth - 1) * 0.38)));
    const detailWidth = Math.max(1, innerWidth - rosterWidth - 1);
    const nodes = this.nodes();
    if (this.selected >= nodes.length) this.selected = Math.max(0, nodes.length - 1);
    const roster = this.rosterLines(nodes, rosterWidth);
    const detail = this.wrappedDetail(nodes[this.selected], detailWidth);
    const maxDetailScroll = Math.max(0, detail.length - this.bodyHeight);
    if (this.detailAutoFollow) this.detailScroll = maxDetailScroll;
    else this.detailScroll = Math.min(this.detailScroll, maxDetailScroll);
    const visibleDetail = detail.slice(this.detailScroll, this.detailScroll + this.bodyHeight);
    const chat = this.wrappedChat(innerWidth);
    const maxChatScroll = Math.max(0, chat.length - this.chatHeight);
    if (this.chatAutoFollow) this.chatScroll = maxChatScroll;
    else this.chatScroll = Math.min(this.chatScroll, maxChatScroll);
    const visibleChat = chat.slice(this.chatScroll, this.chatScroll + this.chatHeight);
    const elapsed = formatDuration(((this.state.status === "running" || this.state.status === "paused") ? Date.now() : this.state.updatedAt) - this.state.createdAt);
    const lines = [theme.fg("border", `╭${"─".repeat(innerWidth)}╮`)];
    lines.push(theme.fg("border", "│") + fit(` ${theme.bold("Campaign")} ${this.options.runId} · ${statusText(theme, this.state.status)} · ${elapsed} · ${this.state.tokens} tok · $${this.state.cost.toFixed(4)}`, innerWidth) + theme.fg("border", "│"));
    lines.push(theme.fg("border", `├${"─".repeat(rosterWidth)}┬${"─".repeat(detailWidth)}┤`));
    for (let index = 0; index < this.bodyHeight; index++) lines.push(theme.fg("border", "│") + fit(roster[index] ?? "", rosterWidth) + theme.fg("border", "│") + fit(visibleDetail[index] ?? "", detailWidth) + theme.fg("border", "│"));
    lines.push(theme.fg("border", `├${"─".repeat(innerWidth)}┤`));
    lines.push(theme.fg("border", "│") + fit(` ${theme.bold("Orchestrator")} ${theme.fg("dim", `· Pi session${this.options.orchestrator.isStreaming ? " · thinking" : ""}`)}`, innerWidth) + theme.fg("border", "│"));
    for (let index = 0; index < this.chatHeight; index++) lines.push(theme.fg("border", "│") + fit(visibleChat[index] ?? "", innerWidth) + theme.fg("border", "│"));
    lines.push(theme.fg("border", "│") + fit(this.input.render(innerWidth)[0] ?? "", innerWidth) + theme.fg("border", "│"));
    lines.push(theme.fg("border", `├${"─".repeat(innerWidth)}┤`));
    const focus = this.panel === "chat" ? "chat" : "campaign";
    lines.push(theme.fg("border", "│") + fit(theme.fg("dim", ` Tab focus (${focus}) · ↑↓/jk node · PgUp/PgDn scroll · x stop agent · X stop campaign · p pause · Esc close`), innerWidth) + theme.fg("border", "│"));
    lines.push(theme.fg("border", `╰${"─".repeat(innerWidth)}╯`));
    return lines.map((line) => truncateToWidth(line, width));
  }

  handleInput(data: string): void {
    if (matchesKey(data, "tab")) { this.panel = this.panel === "chat" ? "campaign" : "chat"; this.input.focused = this.focused && this.panel === "chat"; this.options.tui.requestRender(); return; }
    if (this.panel === "chat") {
      if (matchesKey(data, "ctrl+c")) { if (this.options.orchestrator.isStreaming) void this.options.orchestrator.abort(); else { this.dispose(); this.options.done(); } return; }
      if (matchesKey(data, "escape") && !this.input.text) { this.dispose(); this.options.done(); return; }
      if (matchesKey(data, "pageUp")) { this.chatAutoFollow = false; this.chatScroll = Math.max(0, this.chatScroll - this.chatHeight); }
      else if (matchesKey(data, "pageDown")) { this.chatScroll += this.chatHeight; this.chatAutoFollow = true; }
      else this.input.handleInput(data);
      this.options.tui.requestRender();
      return;
    }
    const nodes = this.nodes();
    const selected = nodes[this.selected];
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || data === "q") { this.dispose(); this.options.done(); return; }
    if (matchesKey(data, "up") || data === "k") this.moveSelection(-1, nodes.length);
    else if (matchesKey(data, "down") || data === "j") this.moveSelection(1, nodes.length);
    else if (matchesKey(data, "home")) this.moveSelection(-nodes.length, nodes.length);
    else if (matchesKey(data, "end")) this.moveSelection(nodes.length, nodes.length);
    else if (matchesKey(data, "pageUp")) { this.detailAutoFollow = false; this.detailScroll = Math.max(0, this.detailScroll - this.bodyHeight); }
    else if (matchesKey(data, "pageDown")) { this.detailScroll += this.bodyHeight; this.detailAutoFollow = true; }
    else if (data === "x" && selected) void this.confirmStopNode(selected);
    else if (data === "X") void this.confirmStopCampaign();
    else if (data === "p") void this.action(this.state.status === "paused" ? this.options.service.resume(this.options.runId) : this.options.service.pause(this.options.runId), this.state.status === "paused" ? "resume requested" : "pause requested");
    else if (data === "r" && selected) void this.action(this.options.service.retry(this.options.runId, selected.id), `retry ${selected.id}`);
    else if (data === "s" && selected) void this.confirmSkipOrOverride(selected.id);
    else if (data === "c" || data === "i" || data === "/") { this.panel = "chat"; this.input.focused = this.focused; if (data === "/") this.input.setText("/"); }
    this.options.tui.requestRender();
  }

  invalidate(): void {}
  dispose(): void { if (this.disposed) return; this.disposed = true; clearInterval(this.timer); this.unregister?.(); this.unsubscribeOrchestrator?.(); this.unregister = undefined; this.unsubscribeOrchestrator = undefined; }

  private nodes(): NodeState[] { return Object.values(this.state.nodes); }
  private moveSelection(delta: number, count: number): void { if (!count) return; this.selected = Math.max(0, Math.min(count - 1, this.selected + delta)); this.selectedKey = this.nodes()[this.selected]?.id; this.detailAutoFollow = true; void this.refreshDetail(); }

  private rosterLines(nodes: NodeState[], width: number): string[] {
    if (!nodes.length) return [this.options.theme.fg("dim", " No campaign nodes yet")];
    const start = Math.max(0, Math.min(this.selected - this.bodyHeight + 1, Math.max(0, nodes.length - this.bodyHeight)));
    return nodes.slice(start, start + this.bodyHeight).map((node, offset) => {
      const index = start + offset;
      const marker = index === this.selected ? this.options.theme.fg("accent", "›") : " ";
      const left = `${marker} ${glyph(node.status, this.options.theme)} ${node.id}`;
      return rightAligned(left, this.options.theme.fg("dim", node.status), width);
    });
  }

  private wrappedDetail(node: NodeState | undefined, width: number): string[] {
    if (!node) return [this.options.theme.fg("dim", "Waiting for the generator to publish its first campaign node…")];
    const irNode = this.state.ir?.nodes.find((candidate) => candidate.id === baseId(node.id));
    const raw = [
      `Node: ${node.id}`,
      `State: ${node.status}`,
      `Kind: ${irNode?.kind ?? "generator/runtime"}`,
      `Attempts: ${node.attempts}`,
      ...(irNode?.kind === "agent-task" ? [`Agent: ${irNode.agent}`, `Model: ${node.modelOverride?.model ?? node.routing?.model ?? irNode.model ?? "automatic"}`] : []),
      ...(node.kernelRunId ? [`Async run: ${node.kernelRunId}`] : []),
      ...(node.error ? [`Error: ${node.error}`] : []),
      "",
      this.options.theme.fg("accent", "Transcript / output"),
      ...(this.detailLines.length ? this.detailLines : node.output !== undefined ? JSON.stringify(node.output, null, 2).split("\n") : ["(waiting for output)"]),
    ];
    return raw.flatMap((line) => wrapTextWithAnsi(styleDetail(line, this.options.theme), Math.max(1, width)) || [""]);
  }

  private wrappedChat(width: number): string[] {
    const transcript = this.options.orchestrator.transcript;
    const raw: OrchestratorLine[] = transcript.length ? [...transcript] : [{ role: "system", text: "Ask about progress, failures, checkpoints, or tell the orchestrator to pause, retry, or stop an agent." }];
    for (const notice of this.notices.slice(-3)) raw.push({ role: "system", text: notice });
    return raw.flatMap((line) => {
      const label = line.role === "user" ? this.options.theme.fg("accent", "you › ") : line.role === "assistant" ? this.options.theme.fg("success", "orchestrator › ") : this.options.theme.fg("dim", "· ");
      const pieces = line.text.split(/\r?\n/);
      return pieces.flatMap((piece, index) => wrapTextWithAnsi(`${index === 0 ? label : "  "}${piece}`, Math.max(1, width)) || [""]);
    });
  }

  private async refresh(): Promise<void> {
    if (this.disposed || this.refreshing) return;
    this.refreshing = true;
    try {
      const previous = this.nodes()[this.selected]?.id ?? this.selectedKey;
      this.state = await this.options.service.getState(this.options.runId);
      const nodes = this.nodes();
      const preserved = previous ? nodes.findIndex((node) => node.id === previous) : -1;
      this.selected = preserved >= 0 ? preserved : Math.min(this.selected, Math.max(0, nodes.length - 1));
      this.selectedKey = nodes[this.selected]?.id;
      await this.refreshDetail();
      this.options.tui.requestRender();
    } catch (error) { this.notices.push(`refresh failed: ${error instanceof Error ? error.message : String(error)}`); }
    finally { this.refreshing = false; }
  }

  private async refreshDetail(): Promise<void> {
    const node = this.nodes()[this.selected];
    if (!node?.asyncDir) { this.detailLines = []; return; }
    try {
      const status = await readSubagentStatus(node.asyncDir);
      const text = typeof status.output === "string" ? status.output : status.output === undefined ? "" : JSON.stringify(status.output, null, 2);
      this.detailLines = text.split(/\r?\n/).slice(-TRANSCRIPT_LINES);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.detailLines = [`status unavailable: ${error instanceof Error ? error.message : String(error)}`];
    }
  }

  private async confirmStopNode(node: NodeState): Promise<void> {
    if (!["scheduled", "running", "paused", "interrupted"].includes(node.status)) { this.notices.push(`${node.id} is not active`); this.options.tui.requestRender(); return; }
    if (!await this.options.confirm("Stop selected campaign agent?", `${node.id}${node.kernelRunId ? `\n\nAsync run: ${node.kernelRunId}` : ""}`)) return;
    await this.action(this.options.service.stopNode(this.options.runId, node.id), `stopped ${node.id}`);
  }
  private async confirmStopCampaign(): Promise<void> { if (await this.options.confirm("Stop entire campaign?", this.options.runId)) await this.action(this.options.service.stop(this.options.runId), "campaign stop requested"); }
  private async confirmSkipOrOverride(nodeId: string, suppliedReason?: string): Promise<void> {
    const gate = this.state.ir?.nodes.find((node) => node.id === baseId(nodeId));
    const evidence = gate?.kind === "gate" ? this.state.gates.filter((record) => record.gateId === gate.id).at(-1)?.evidence : this.state.nodes[nodeId]?.output;
    const action = gate?.kind === "gate" ? "Override checkpoint" : "Skip campaign node";
    if (!await this.options.confirm(action, `${nodeId}\n\nCurrent evidence:\n${JSON.stringify(evidence ?? null, null, 2)}`)) return;
    if (gate?.kind === "gate") {
      let reason = suppliedReason?.trim();
      if (gate.check.type === "safety" && !reason) reason = (await this.options.inputReason("Safety override reason", "Explain why this risk is accepted"))?.trim();
      if (gate.check.type === "safety" && !reason) { this.notices.push("safety override requires a reason"); return; }
      await this.action(this.options.service.overrideGate(this.options.runId, gate.id, reason), `override ${gate.id}`);
    } else await this.action(this.options.service.skip(this.options.runId, nodeId), `skip ${nodeId}`);
  }

  private async submit(value: string): Promise<void> {
    try {
      const [command, ...args] = value.split(/\s+/);
      if (command === "/pause") await this.options.service.pause(this.options.runId);
      else if (command === "/resume") await this.options.service.resume(this.options.runId);
      else if (command === "/stop") await this.options.service.stop(this.options.runId);
      else if (command === "/stop-agent") await this.options.service.stopNode(this.options.runId, args[0]!);
      else if (command === "/retry") await this.options.service.retry(this.options.runId, args[0]!);
      else await this.options.orchestrator.send(value);
    } catch (error) { this.notices.push(error instanceof Error ? error.message : String(error)); }
    this.chatAutoFollow = true;
    await this.refresh();
  }
  private async action(promise: Promise<void>, label: string): Promise<void> { try { await promise; this.notices.push(label); } catch (error) { this.notices.push(error instanceof Error ? error.message : String(error)); } await this.refresh(); }
}

function glyph(value: string, theme: Theme): string { if (value === "running") return theme.fg("accent", "●"); if (value === "scheduled" || value === "pending") return theme.fg("muted", "◦"); if (value === "completed") return theme.fg("success", "✓"); if (value === "paused" || value === "stopped" || value === "skipped") return theme.fg("warning", "■"); return theme.fg("error", "✗"); }
function statusText(theme: Theme, value: string): string { return theme.fg(value === "completed" ? "success" : value === "failed" ? "error" : value === "paused" ? "warning" : "accent", value); }
function styleDetail(line: string, theme: Theme): string { if (/^(Node|State|Kind|Attempts|Agent|Model|Async run):/.test(line)) return theme.bold(line); if (/^Error:/.test(line)) return theme.fg("error", line); return line; }
function baseId(value: string): string { return value.replace(/\[(?:round-)?\d+\]/g, "").replace(/:(?:verify|repair)(?::\d+)?$/, ""); }
function fit(text: string, width: number): string { const clipped = truncateToWidth(text, Math.max(0, width)); return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped))); }
function rightAligned(left: string, right: string, width: number): string { const rightWidth = visibleWidth(right); const leftWidth = Math.max(0, width - rightWidth - 1); return fit(left, leftWidth) + " ".repeat(Math.max(1, width - leftWidth - rightWidth)) + fit(right, rightWidth); }
function formatDuration(ms: number): string { const seconds = Math.max(0, Math.floor(ms / 1000)); return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m${seconds % 60}s`; }
