import { matchesKey, type Component, type Focusable } from "@earendil-works/pi-tui";
import type { CampaignState } from "../persistence/types.ts";
import type { CampaignService } from "../commands/service.ts";
import { columns, fit } from "./layout.ts";
import { ControlInput } from "./input.ts";
interface InspectorOptions { service: CampaignService; runId: string; initial: CampaignState; tui: { requestRender(): void }; theme: { fg(name: string, value: string): string; bold(value: string): string }; confirm(title: string, message: string): Promise<boolean>; inputReason(title: string, placeholder: string): Promise<string | undefined>; done(): void }
export class CampaignInspector implements Component, Focusable {
  private state: CampaignState; private selected = 0; private timeline: string[] = []; private filter: "all" | "active" | "failed" = "all"; private pane = 0; private timer: NodeJS.Timeout; private unregister: (() => void) | undefined; private disposed = false; private input: ControlInput; private _focused = true;
  get focused(): boolean { return this._focused; } set focused(value: boolean) { this._focused = value; this.input.focused = value; }
  constructor(private options: InspectorOptions) { this.state = options.initial; this.input = new ControlInput((value) => void this.submit(value)); this.timer = setInterval(() => void this.refresh(), 750); this.timer.unref(); this.unregister = options.service.registerUiDisposer(() => this.dispose()); }
  render(width: number): string[] {
    const theme = this.options.theme; const elapsed = formatDuration((this.state.status === "running" || this.state.status === "paused" ? Date.now() : this.state.updatedAt) - this.state.createdAt); const header = fit(`${theme.bold(this.state.goal)} | ${status(theme, this.state.status)} | ${elapsed} | ${this.state.tokens} tok | $${this.state.cost.toFixed(4)} | pane ${this.pane + 1}/2`, width);
    const nodes = this.filteredNodes(); if (this.selected >= nodes.length) this.selected = Math.max(0, nodes.length - 1); const left = nodes.length ? nodes.map((node, index) => `${index === this.selected ? "▶" : " "} ${icon(node.status)} ${node.id}  ${node.status}`) : ["  No nodes match filter"];
    const selected = nodes[this.selected]; const irNode = selected ? this.state.ir?.nodes.find((node) => node.id === baseId(selected.id)) : undefined; const right = selected ? [`Node: ${selected.id}`, `kind: ${irNode?.kind ?? "runtime"}`, `state: ${selected.status} · attempts ${selected.attempts}`, ...(irNode?.kind === "agent-task" ? [`agent: ${irNode.agent}`, `model: ${selected.modelOverride?.model ?? selected.routing?.model ?? irNode.model ?? "automatic"}`, `thinking: ${selected.modelOverride?.thinking ?? selected.routing?.thinking ?? irNode.thinking ?? "automatic"}`, ...(selected.routing ? [`route: ${selected.routing.source} · confidence ${selected.routing.confidence.toFixed(2)}`, `fallbacks: ${selected.routing.fallbackModels.join(", ") || "none"}`] : [])] : []), ...(selected.kernelRunId ? [`kernel: ${selected.kernelRunId}`] : []), ...(selected.kernel?.currentTool ? [`tool: ${selected.kernel.currentTool}${selected.kernel.currentPath ? ` · ${selected.kernel.currentPath}` : ""}`] : []), ...(selected.kernel?.recentOutput?.length ? ["Recent output:", ...selected.kernel.recentOutput.slice(-5)] : []), ...(selected.error ? [theme.fg("error", `error: ${selected.error}`)] : []), ...(selected.output !== undefined ? ["", "Output:", ...JSON.stringify(selected.output, null, 2).split("\n").slice(0, 12)] : [])] : ["Select a node for details."];
    const body = columns(left, right, width); const timeline = ["", theme.fg("accent", "Timeline / campaign control"), ...this.timeline.slice(-4).map((line) => fit(line, width)), ...this.input.render(width), theme.fg("dim", "↑↓/jk navigate · x stop selected agent · X stop campaign · p pause/resume · r retry · s skip/override · q close")];
    return [header, "─".repeat(Math.max(1, width)), ...body, ...timeline].map((line) => fit(line, width));
  }
  handleInput(data: string): void {
    if (this.input.text || data === "/") { if (data === "/" && !this.input.text) this.input.setText("/"); else this.input.handleInput(data); this.options.tui.requestRender(); return; }
    const nodes = this.filteredNodes(); const selected = nodes[this.selected];
    if (matchesKey(data, "up") || data === "k") this.selected = Math.max(0, this.selected - 1);
    else if (matchesKey(data, "down") || data === "j") this.selected = Math.min(Math.max(0, nodes.length - 1), this.selected + 1);
    else if (matchesKey(data, "tab")) this.pane = (this.pane + 1) % 2;
    else if (data === "f") this.filter = this.filter === "all" ? "active" : this.filter === "active" ? "failed" : "all";
    else if (data === "p") void this.action(this.state.status === "paused" ? this.options.service.resume(this.options.runId) : this.options.service.pause(this.options.runId), this.state.status === "paused" ? "resume requested" : "pause requested");
    else if (data === "x" && selected) void this.confirmStopNode(selected.id);
    else if (data === "X") void this.confirmStopCampaign();
    else if (data === "r" && selected) void this.action(this.options.service.retry(this.options.runId, selected.id), `retry ${selected.id}`);
    else if (data === "s" && selected) void this.confirmSkipOrOverride(selected.id);
    else if (data === "e" && selected) this.input.setText(`/edit ${selected.id} `);
    else if (data === "m" && selected) this.input.setText(`/model ${selected.id} `);
    else if (data === "q" || matchesKey(data, "escape")) { this.dispose(); this.options.done(); return; }
    this.options.tui.requestRender();
  }
  invalidate(): void {}
  dispose(): void { if (this.disposed) return; this.disposed = true; clearInterval(this.timer); this.unregister?.(); this.unregister = undefined; }
  private filteredNodes() { const values = Object.values(this.state.nodes); if (this.filter === "active") return values.filter((node) => ["scheduled", "running", "paused", "interrupted"].includes(node.status)); if (this.filter === "failed") return values.filter((node) => node.status === "failed" || node.status === "interrupted"); return values; }
  private async refresh(): Promise<void> { try { this.state = await this.options.service.getState(this.options.runId); this.options.tui.requestRender(); } catch { /* run can disappear during shutdown */ } }
  private async confirmStopNode(nodeId: string): Promise<void> {
    const node = this.state.nodes[nodeId];
    if (!node || !["scheduled", "running", "paused", "interrupted"].includes(node.status)) { this.timeline.push(`! ${nodeId} is not active`); this.options.tui.requestRender(); return; }
    if (!await this.options.confirm("Stop selected campaign agent?", `${nodeId}${node.kernelRunId ? `\n\nAsync run: ${node.kernelRunId}` : ""}`)) { this.timeline.push("· agent stop cancelled"); this.options.tui.requestRender(); return; }
    await this.action(this.options.service.stopNode(this.options.runId, nodeId), `stopped ${nodeId}`);
  }
  private async confirmStopCampaign(): Promise<void> {
    if (!await this.options.confirm("Stop entire campaign?", this.options.runId)) { this.timeline.push("· campaign stop cancelled"); this.options.tui.requestRender(); return; }
    await this.action(this.options.service.stop(this.options.runId), "campaign stop requested");
  }
  private async confirmSkipOrOverride(nodeId: string, suppliedReason?: string): Promise<void> {
    const gate = this.state.ir?.nodes.find((node) => node.id === baseId(nodeId));
    const evidence = gate?.kind === "gate" ? this.state.gates.filter((record) => record.gateId === gate.id).at(-1)?.evidence : this.state.nodes[nodeId]?.output;
    const action = gate?.kind === "gate" ? "Override checkpoint" : "Skip campaign node";
    const confirmed = await this.options.confirm(action, `${nodeId}\n\nCurrent evidence:\n${JSON.stringify(evidence ?? null, null, 2)}`);
    if (!confirmed) { this.timeline.push(`· ${action.toLowerCase()} cancelled`); this.options.tui.requestRender(); return; }
    if (gate?.kind === "gate") {
      let reason = suppliedReason?.trim();
      if (gate.check.type === "safety" && !reason) reason = (await this.options.inputReason("Safety override reason", "Explain why this risk is accepted"))?.trim();
      if (gate.check.type === "safety" && !reason) { this.timeline.push("! safety override cancelled: a reason is required"); this.options.tui.requestRender(); return; }
      await this.action(this.options.service.overrideGate(this.options.runId, gate.id, reason), `override ${gate.id}`);
    } else await this.action(this.options.service.skip(this.options.runId, nodeId), `skip ${nodeId}`);
  }
  private async submit(value: string): Promise<void> {
    const [command, ...args] = value.split(/\s+/);
    try {
      switch (command) {
        case "/pause": await this.options.service.pause(this.options.runId); break;
        case "/resume": await this.options.service.resume(this.options.runId); break;
        case "/stop": await this.options.service.stop(this.options.runId); break;
        case "/stop-agent": await this.options.service.stopNode(this.options.runId, args[0]!); break;
        case "/retry": await this.options.service.retry(this.options.runId, args[0]!); break;
        case "/skip": await this.confirmSkipOrOverride(args[0]!); return;
        case "/override": await this.confirmSkipOrOverride(args[0]!, args.slice(1).join(" ")); return;
        case "/edit": await this.options.service.editPrompt(this.options.runId, args[0]!, args.slice(1).join(" ")); break;
        case "/model": await this.options.service.overrideModel(this.options.runId, args[0]!, args[1]!, args[2] as never); break;
        default: throw new Error("Campaign controller model chat is not enabled in RPC v1; use /pause, /resume, /stop-agent, /retry, /skip, /override, /edit, /model, or /stop.");
      }
      this.timeline.push(`✓ ${value}`);
    } catch (error) { this.timeline.push(`! ${error instanceof Error ? error.message : String(error)}`); }
    await this.refresh();
  }
  private async action(promise: Promise<void>, label: string): Promise<void> { try { await promise; this.timeline.push(`✓ ${label}`); } catch (error) { this.timeline.push(`! ${error instanceof Error ? error.message : String(error)}`); } await this.refresh(); }
}
function icon(value: string): string { return value === "completed" ? "✓" : value === "running" ? "▶" : value === "failed" ? "✗" : value === "skipped" ? "↷" : "○"; }
function status(theme: InspectorOptions["theme"], value: string): string { return theme.fg(value === "completed" ? "success" : value === "failed" ? "error" : value === "paused" ? "warning" : "accent", value); }
function baseId(value: string): string { return value.replace(/\[(?:round-)?\d+\]$/, "").replace(/:repair:\d+$/, ""); }
function formatDuration(ms: number): string { const seconds = Math.max(0, Math.floor(ms / 1000)); return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m${seconds % 60}s`; }
