import { matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component, type Focusable, type TUI } from "@earendil-works/pi-tui";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CampaignState, NodeState, NodeStatus } from "../persistence/types.ts";
import type { CampaignNode } from "../dsl/types.ts";
import type { CampaignService } from "../commands/service.ts";
import type { CampaignOrchestratorSession, OrchestratorLine } from "../orchestrator/session.ts";
import { readSubagentStatus } from "../adapters/subagents-artifacts-v2.ts";
import { ControlInput } from "./input.ts";

const REFRESH_MS = 1_000;
const RENDER_THROTTLE_MS = 120;
const TRANSCRIPT_LINES = 300;
type Theme = ExtensionContext["ui"]["theme"];
interface TreeRow {
  key: string;
  node: NodeState;
  irNode?: CampaignNode;
  depth: number;
  last: boolean;
  phase: string;
  title: string;
  structural: boolean;
}
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
  private detailAutoFollow = false;
  private chatScroll = 0;
  private chatAutoFollow = true;
  private bodyHeight = 8;
  private chatHeight = 6;
  private panel: "campaign" | "chat" = "chat";
  private notices: string[] = [];
  private timer: NodeJS.Timeout;
  private renderTimer: NodeJS.Timeout | undefined;
  private lastRenderAt = 0;
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
    const initialRows = this.treeRows();
    const preferred = initialRows.findIndex((row) => !row.structural && (row.node.status === "running" || row.node.status === "scheduled"));
    this.selected = preferred >= 0 ? preferred : 0;
    this.selectedKey = initialRows[this.selected]?.key;
    this.input = new ControlInput((value) => void this.submit(value));
    this.input.focused = true;
    this.unregister = options.service.registerUiDisposer(() => this.dispose());
    this.unsubscribeOrchestrator = options.orchestrator.subscribe(() => { this.chatAutoFollow = true; this.scheduleRender(); });
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), REFRESH_MS);
    this.timer.unref();
  }

  render(width: number): string[] {
    if (width < 44) return [truncateToWidth("Campaign workspace needs at least 44 columns. Esc closes.", width)];
    const theme = this.options.theme;
    const innerWidth = width - 2;
    const terminalRows = this.options.tui.terminal?.rows ?? 32;
    // Leave room for Pi/tmux chrome. Filling the physical terminal exactly
    // makes the final row wrap and forces a visible full-screen repaint.
    const workspaceRows = Math.max(12, terminalRows - 6);
    const usable = Math.max(4, workspaceRows - 12);
    this.bodyHeight = Math.max(2, Math.floor(usable * 0.52));
    this.chatHeight = Math.max(2, usable - this.bodyHeight);
    const rosterWidth = Math.max(24, Math.min(48, Math.floor((innerWidth - 1) * 0.38)));
    const detailWidth = Math.max(1, innerWidth - rosterWidth - 1);
    const rows = this.treeRows();
    if (this.selected >= rows.length) this.selected = Math.max(0, rows.length - 1);
    const roster = this.rosterLines(rows, rosterWidth);
    const detail = this.wrappedDetail(rows[this.selected], detailWidth);
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
    lines.push(theme.fg("border", "│") + fit(` ${theme.bold("Campaign")} ${this.options.runId} · ${theme.bold("STATUS")} ${statusText(theme, this.state.status)} · ${elapsed} · ${this.state.tokens} tok · $${this.state.cost.toFixed(4)}`, innerWidth) + theme.fg("border", "│"));
    lines.push(theme.fg("border", "│") + fit(` ${theme.bold("Summary:")} ${campaignEnglishSummary(this.state)}`, innerWidth) + theme.fg("border", "│"));
    lines.push(theme.fg("border", "│") + fit(` ${theme.bold("Timestamp:")} updated ${formatTimestamp(this.state.updatedAt)} · started ${formatTimestamp(this.state.createdAt)}`, innerWidth) + theme.fg("border", "│"));
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
    const rows = this.treeRows();
    const selected = rows[this.selected]?.node;
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || data === "q") { this.dispose(); this.options.done(); return; }
    if (matchesKey(data, "up") || data === "k") this.moveSelection(-1, rows.length);
    else if (matchesKey(data, "down") || data === "j") this.moveSelection(1, rows.length);
    else if (matchesKey(data, "home")) this.moveSelection(-rows.length, rows.length);
    else if (matchesKey(data, "end")) this.moveSelection(rows.length, rows.length);
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
  dispose(): void { if (this.disposed) return; this.disposed = true; clearInterval(this.timer); if (this.renderTimer) clearTimeout(this.renderTimer); this.renderTimer = undefined; this.unregister?.(); this.unsubscribeOrchestrator?.(); this.unregister = undefined; this.unsubscribeOrchestrator = undefined; }

  private treeRows(): TreeRow[] {
    const runtime = Object.values(this.state.nodes);
    if (!this.state.ir) return runtime.map((node, index) => ({ key: node.id, node, depth: 0, last: index === runtime.length - 1, phase: "Generation", title: node.id, structural: false }));
    const byId = new Map(this.state.ir.nodes.map((node) => [node.id, node]));
    const rows: TreeRow[] = [];
    const claimed = new Set<string>();
    const generator = runtime.filter((node) => node.id.startsWith("campaign-generator"));
    generator.forEach((node, index) => { claimed.add(node.id); rows.push({ key: node.id, node, depth: 0, last: index === generator.length - 1, phase: "Generation", title: `Generation · ${node.id}`, structural: false }); });
    const descendantCache = new Map<string, Set<string>>();
    const descendants = (id: string): Set<string> => {
      const cached = descendantCache.get(id); if (cached) return cached;
      const result = new Set([id]); descendantCache.set(id, result);
      const definition = byId.get(id);
      for (const child of definition ? childIds(definition) : []) for (const nested of descendants(child)) result.add(nested);
      return result;
    };
    const visit = (id: string, depth: number, last: boolean, inheritedPhase: string): void => {
      const irNode = byId.get(id); if (!irNode) return;
      const direct = runtime.filter((node) => baseId(node.id) === id);
      direct.forEach((node) => claimed.add(node.id));
      const subtree = descendants(id);
      const related = runtime.filter((node) => subtree.has(baseId(node.id)));
      const exact = direct.find((node) => node.id === id);
      const node = exact ?? syntheticNode(id, related);
      const title = irNode.label ?? (id === this.state.ir!.root ? this.state.ir!.meta.name : `${kindLabel(irNode.kind)} · ${id}`);
      const phase = id === this.state.ir!.root ? this.state.ir!.meta.name : (isComposite(irNode) ? title : inheritedPhase);
      rows.push({ key: id, node, irNode, depth, last, phase, title, structural: irNode.kind !== "agent-task" });
      const children = childIds(irNode);
      children.forEach((child, index) => visit(child, depth + 1, index === children.length - 1 && direct.length <= (exact ? 1 : 0), phase));
      const instances = direct.filter((candidate) => candidate.id !== id);
      instances.forEach((instance, index) => rows.push({ key: instance.id, node: instance, irNode, depth: depth + 1, last: index === instances.length - 1, phase, title: instance.id, structural: false }));
    };
    visit(this.state.ir.root, 0, true, this.state.ir.meta.name);
    const extra = runtime.filter((node) => !claimed.has(node.id));
    extra.forEach((node, index) => rows.push({ key: node.id, node, ...(byId.get(baseId(node.id)) ? { irNode: byId.get(baseId(node.id))! } : {}), depth: 1, last: index === extra.length - 1, phase: "Runtime support", title: node.id, structural: false }));
    return rows;
  }
  private moveSelection(delta: number, count: number): void { if (!count) return; this.selected = Math.max(0, Math.min(count - 1, this.selected + delta)); this.selectedKey = this.treeRows()[this.selected]?.key; this.detailAutoFollow = false; this.detailScroll = 0; void this.refreshDetail().then((changed) => { if (changed) this.scheduleRender(); }); }

  private rosterLines(rows: TreeRow[], width: number): string[] {
    if (!rows.length) return [this.options.theme.fg("dim", " No campaign nodes yet")];
    const start = Math.max(0, Math.min(this.selected - this.bodyHeight + 1, Math.max(0, rows.length - this.bodyHeight)));
    return rows.slice(start, start + this.bodyHeight).map((row, offset) => {
      const index = start + offset;
      const marker = index === this.selected ? this.options.theme.fg("accent", "›") : " ";
      const branch = row.depth ? `${"  ".repeat(Math.max(0, row.depth - 1))}${row.last ? "└─" : "├─"}` : "";
      const title = row.structural ? this.options.theme.bold(row.title) : row.title;
      const left = `${marker} ${glyph(row.node.status, this.options.theme)} ${branch}${title}`;
      return rightAligned(left, this.options.theme.fg("dim", row.node.status), width);
    });
  }

  private wrappedDetail(row: TreeRow | undefined, width: number): string[] {
    if (!row) return [this.options.theme.fg("dim", "Waiting for the generator to publish its first campaign node…")];
    const { node, irNode } = row;
    const prompt = node.promptOverride ?? (irNode?.kind === "agent-task" ? printable(irNode.prompt) : undefined);
    const raw = [
      `Node: ${node.id}`,
      `Phase: ${row.phase}`,
      `Label: ${irNode?.label ?? row.title}`,
      `State: ${node.status}`,
      `Kind: ${irNode?.kind ?? "generator/runtime"}`,
      ...(irNode?.kind === "agent-task" ? [`Agent: ${irNode.agent}`] : []),
      ...(prompt ? [this.options.theme.fg("accent", "Prompt:"), ...prompt.split("\n"), ""] : []),
      `Attempts: ${node.attempts}`,
      ...(irNode?.kind === "agent-task" ? [
        `Model: ${node.modelOverride?.model ?? node.routing?.model ?? irNode.model ?? "automatic"}`,
        `Thinking: ${node.modelOverride?.thinking ?? node.routing?.thinking ?? irNode.thinking ?? node.kernel?.thinking ?? "automatic"}`,
        `Recovery: ${irNode.recovery}`,
        `Capabilities: ${irNode.capabilities.length ? irNode.capabilities.join(", ") : "read-only/default"}`,
      ] : []),
      ...(node.startedAt ? [`Started: ${formatTimestamp(node.startedAt)}`] : []),
      ...(node.endedAt ? [`Ended: ${formatTimestamp(node.endedAt)}`] : []),
      ...(node.kernel?.currentTool ? [`Current tool: ${node.kernel.currentTool}`] : []),
      ...(node.kernel?.currentPath ? [`Current path: ${node.kernel.currentPath}`] : []),
      ...(node.kernel?.tokens !== undefined ? [`Tokens: ${node.kernel.tokens}`] : []),
      ...(node.kernel?.cost !== undefined ? [`Cost: $${node.kernel.cost.toFixed(4)}`] : []),
      ...(node.kernelRunId ? [`Async run: ${node.kernelRunId}`] : []),
      ...(node.error ? [`Error: ${node.error}`] : []),
      "",
      this.options.theme.fg("accent", "Transcript / output"),
      ...(this.detailLines.length ? this.detailLines : node.output !== undefined ? printable(node.output).split("\n") : row.structural ? ["(phase metadata; select a child agent for its live transcript)"] : ["(waiting for output)"]),
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
      const previous = this.treeRows()[this.selected]?.key ?? this.selectedKey;
      const priorUpdatedAt = this.state.updatedAt;
      const priorStatus = this.state.status;
      this.state = await this.options.service.getState(this.options.runId);
      const rows = this.treeRows();
      const preserved = previous ? rows.findIndex((row) => row.key === previous) : -1;
      this.selected = preserved >= 0 ? preserved : Math.min(this.selected, Math.max(0, rows.length - 1));
      this.selectedKey = rows[this.selected]?.key;
      const detailChanged = await this.refreshDetail();
      if (detailChanged || priorUpdatedAt !== this.state.updatedAt || priorStatus !== this.state.status) this.scheduleRender();
    } catch (error) { this.notices.push(`refresh failed: ${error instanceof Error ? error.message : String(error)}`); this.scheduleRender(); }
    finally { this.refreshing = false; }
  }

  private async refreshDetail(): Promise<boolean> {
    const previous = this.detailLines.join("\n");
    const node = this.treeRows()[this.selected]?.node;
    if (!node?.asyncDir) { this.detailLines = []; return previous !== ""; }
    try {
      const status = await readSubagentStatus(node.asyncDir);
      const text = typeof status.output === "string" ? status.output : status.output === undefined ? "" : JSON.stringify(status.output, null, 2);
      this.detailLines = text.split(/\r?\n/).slice(-TRANSCRIPT_LINES);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.detailLines = [`status unavailable: ${error instanceof Error ? error.message : String(error)}`];
    }
    return previous !== this.detailLines.join("\n");
  }

  private scheduleRender(): void {
    if (this.disposed || this.renderTimer) return;
    const wait = Math.max(0, RENDER_THROTTLE_MS - (Date.now() - this.lastRenderAt));
    this.renderTimer = setTimeout(() => {
      this.renderTimer = undefined;
      if (this.disposed) return;
      this.lastRenderAt = Date.now();
      this.options.tui.requestRender();
    }, wait);
    this.renderTimer.unref();
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

function childIds(node: CampaignNode): string[] {
  if (node.kind === "sequence" || node.kind === "parallel") return node.children;
  if (node.kind === "map" || node.kind === "loop") return [node.body];
  if (node.kind === "branch") return [node.then, ...(node.else ? [node.else] : [])];
  return [];
}
function isComposite(node: CampaignNode): boolean { return ["sequence", "parallel", "map", "branch", "loop"].includes(node.kind); }
function kindLabel(kind: CampaignNode["kind"]): string { return kind === "agent-task" ? "Agent" : kind.charAt(0).toUpperCase() + kind.slice(1); }
function syntheticNode(id: string, related: NodeState[]): NodeState {
  const statuses = related.map((node) => node.status);
  let status: NodeStatus = "pending";
  if (statuses.includes("failed")) status = "failed";
  else if (statuses.includes("interrupted")) status = "interrupted";
  else if (statuses.includes("running")) status = "running";
  else if (statuses.includes("paused")) status = "paused";
  else if (statuses.includes("scheduled")) status = "scheduled";
  else if (statuses.length && statuses.every((value) => value === "completed" || value === "skipped")) status = "completed";
  return { id, status, attempts: 0 };
}
function printable(value: unknown): string { if (typeof value === "string") return value; const json = JSON.stringify(value, null, 2); return json ?? String(value); }
function glyph(value: string, theme: Theme): string { if (value === "running") return theme.fg("accent", "●"); if (value === "scheduled" || value === "pending") return theme.fg("muted", "◦"); if (value === "completed") return theme.fg("success", "✓"); if (value === "paused" || value === "stopped" || value === "skipped") return theme.fg("warning", "■"); return theme.fg("error", "✗"); }
function statusText(theme: Theme, value: string): string { return theme.fg(value === "completed" ? "success" : value === "failed" ? "error" : value === "paused" ? "warning" : "accent", value); }
function styleDetail(line: string, theme: Theme): string { if (/^(Node|Phase|Label|State|Kind|Prompt|Attempts|Agent|Model|Thinking|Recovery|Capabilities|Started|Ended|Current tool|Current path|Tokens|Cost|Async run):/.test(line)) return theme.bold(line); if (/^Error:/.test(line)) return theme.fg("error", line); return line; }
function baseId(value: string): string { return value.replace(/\[(?:round-)?\d+\]/g, "").replace(/:(?:verify|repair)(?::\d+)?$/, ""); }
function fit(text: string, width: number): string { const clipped = truncateToWidth(text, Math.max(0, width)); return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped))); }
function rightAligned(left: string, right: string, width: number): string { const rightWidth = visibleWidth(right); const leftWidth = Math.max(0, width - rightWidth - 1); return fit(left, leftWidth) + " ".repeat(Math.max(1, width - leftWidth - rightWidth)) + fit(right, rightWidth); }
function formatDuration(ms: number): string { const seconds = Math.max(0, Math.floor(ms / 1000)); return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m${seconds % 60}s`; }
function formatTimestamp(value: number): string { return new Date(value).toLocaleString(); }
export function campaignEnglishSummary(state: CampaignState): string {
  const nodes = Object.values(state.nodes);
  const completed = nodes.filter((node) => node.status === "completed" || node.status === "skipped").length;
  const active = nodes.filter((node) => node.status === "running" || node.status === "scheduled").length;
  const failed = nodes.filter((node) => node.status === "failed" || node.status === "interrupted").length;
  if (!state.ir) {
    if (state.status === "failed") return `Workflow generation failed${state.error ? `: ${state.error}` : "."}`;
    if (state.status === "stopped") return `Workflow generation was stopped. Goal: ${state.goal}`;
    return `Generating a workflow for: ${state.goal}`;
  }
  const name = state.ir.meta.name;
  const progress = `${completed} finished, ${active} active${failed ? `, ${failed} failed or interrupted` : ""}`;
  if (state.status === "completed") return `${name} completed successfully (${progress}). Goal: ${state.goal}`;
  if (state.status === "failed") return `${name} failed (${progress})${state.error ? `: ${state.error}` : "."}`;
  if (state.status === "paused") return `${name} is paused (${progress}). ${state.pauseReason ? `Reason: ${state.pauseReason}. ` : ""}Goal: ${state.goal}`;
  if (state.status === "stopped") return `${name} was stopped (${progress}). Goal: ${state.goal}`;
  return `${name} is running (${progress}). Goal: ${state.goal}`;
}
