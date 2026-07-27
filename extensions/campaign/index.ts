import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { CampaignService, DEFAULT_CONFIG, type CampaignConfig } from "../../src/commands/service.ts";
import { agentDir } from "../../src/persistence/paths.ts";
import { CampaignInspector } from "../../src/tui/inspector.ts";
export default async function campaignExtension(pi: ExtensionAPI) {
  const config = await loadConfig(); const service = new CampaignService(pi, config);
  pi.registerMessageRenderer("campaign-milestone", (message, _options, theme) => new Text(theme.fg("accent", `Campaign: ${message.content}`), 0, 0));
  pi.on("session_start", async (_event, ctx) => { service.setContext(ctx); await service.restore(ctx); });
  pi.on("session_shutdown", async () => { await service.dispose(); });
  pi.on("input", async (event, ctx) => {
    if (!service.config.ultracode || event.source !== "interactive" || event.streamingBehavior || !/^ultracode:\s*/i.test(event.text)) return { action: "continue" as const };
    const goal = event.text.replace(/^ultracode:\s*/i, "").trim();
    if (!goal) { ctx.ui.notify("Usage: ultracode: <goal>", "warning"); return { action: "handled" as const }; }
    const runId = await service.startGoal(goal, ctx);
    if (ctx.mode === "tui") await openCampaignWorkspace(service, runId, ctx);
    return { action: "handled" as const };
  });
  pi.registerCommand("campaign", { description: "Generate and run a deterministic campaign", handler: async (args, ctx) => { const goal = args.trim(); if (!goal) { ctx.ui.notify("Usage: /campaign <goal>", "warning"); return; } const runId = await service.startGoal(goal, ctx); if (ctx.mode === "tui") await openCampaignWorkspace(service, runId, ctx); } });
  pi.registerCommand("campaign-list", { description: "List active and recent campaigns", handler: async (_args, ctx) => { const states = await service.list(ctx); const text = states.length ? states.map((state) => `${state.runId} | ${state.status} | ${state.ir?.meta.name ?? "generating"} | ${new Date(state.updatedAt).toLocaleString()}`).join("\n") : "No campaigns for this Pi session."; if (ctx.hasUI) ctx.ui.notify(text, "info"); else console.log(text); } });
  pi.registerCommand("campaign-inspect", { description: "Open the Campaign workspace", handler: async (args, ctx) => { const states = await service.list(ctx); let runId = args.trim(); if (!runId && states.length) runId = ctx.mode === "tui" ? (await ctx.ui.select("Open campaign workspace", states.map((state) => state.runId))) ?? "" : states[0]!.runId; if (!runId) { ctx.ui.notify("No campaign selected.", "warning"); return; } await openCampaignWorkspace(service, runId, ctx); } });
  pi.registerCommand("campaign-run", { description: "Run a saved campaign", getArgumentCompletions: () => null, handler: async (args, ctx) => { const [name, ...rest] = args.trim().split(/\s+/); if (!name) { ctx.ui.notify("Usage: /campaign-run <name> [json-input]", "warning"); return; } try { const input = rest.length ? JSON.parse(rest.join(" ")) : undefined; const id = await service.runSaved(name, input, ctx); ctx.ui.notify(`Started ${id}.`, "info"); if (ctx.mode === "tui") await openCampaignWorkspace(service, id, ctx); } catch (error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"); } } });
  pi.registerCommand("campaign-save", { description: "Save generated campaign source", handler: async (args, ctx) => { const parts = args.trim().split(/\s+/).filter(Boolean); const project = parts.includes("--project"); const clean = parts.filter((part) => part !== "--project"); if (!clean[0]) { ctx.ui.notify("Usage: /campaign-save <run-id> [name] [--project]", "warning"); return; } if (project && !ctx.isProjectTrusted()) { ctx.ui.notify("Project campaigns require a trusted project.", "error"); return; } try { const path = await service.save(clean[0], clean[1], project ? "project" : "personal", ctx); ctx.ui.notify(`Saved ${path}`, "info"); } catch (error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"); } } });
  pi.registerCommand("campaign-stop", { description: "Stop an active campaign", handler: async (args, ctx) => { try { await service.stop(args.trim()); ctx.ui.notify("Stop requested.", "info"); } catch (error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"); } } });
  pi.registerCommand("campaign-doctor", { description: "Diagnose Campaign dependencies and RPC", handler: async (_args, ctx) => { const report = await service.doctor(ctx); if (ctx.hasUI) ctx.ui.notify(report, report.includes("MISSING") ? "warning" : "info"); else console.log(report); } });
  pi.registerCommand("campaign-config", { description: "Show or update Campaign configuration as JSON", handler: async (args, ctx) => { if (!args.trim()) { const text = JSON.stringify(service.config, null, 2); if (ctx.mode === "tui") ctx.ui.setEditorText(`/campaign-config ${text}`); else console.log(text); return; } try { const patch = JSON.parse(args) as Partial<CampaignConfig>; service.config = validateConfig({ ...service.config, ...patch, hardCaps: { ...service.config.hardCaps, ...patch.hardCaps } }); await saveConfig(service.config); ctx.ui.notify("Campaign configuration saved. Changes to active runs are not retroactive.", "info"); } catch (error) { ctx.ui.notify(`Invalid config: ${error instanceof Error ? error.message : String(error)}`, "error"); } } });
}
async function openCampaignWorkspace(service: CampaignService, runId: string, ctx: ExtensionContext): Promise<void> {
  const state = await service.getState(runId, ctx);
  if (ctx.mode !== "tui") {
    const text = JSON.stringify(state, null, 2);
    if (ctx.hasUI) ctx.ui.notify(text, "info"); else console.log(text);
    return;
  }
  const orchestrator = await service.getOrchestrator(runId, ctx);
  await ctx.ui.custom<void>((tui, theme, _keybindings, done) => new CampaignInspector({
    service,
    orchestrator,
    runId,
    initial: state,
    tui,
    theme,
    confirm: (title, message) => ctx.ui.confirm(title, message),
    inputReason: (title, placeholder) => ctx.ui.input(title, placeholder),
    done: () => done(undefined),
  }), {
    // Use Pi's overlay compositor—the same stable rendering path as
    // /subagents-fleet. Non-overlay custom views make tmux repaint the whole
    // terminal whenever live campaign output changes.
    overlay: true,
    overlayOptions: { anchor: "center", width: "98%", minWidth: 44, maxHeight: "95%", margin: 1 },
  });
}
async function loadConfig(): Promise<CampaignConfig> { try { const parsed = JSON.parse(await readFile(join(agentDir(), "campaign-config.json"), "utf8")) as Partial<CampaignConfig>; return validateConfig({ ...DEFAULT_CONFIG, ...parsed, hardCaps: { ...DEFAULT_CONFIG.hardCaps, ...parsed.hardCaps } }); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return structuredClone(DEFAULT_CONFIG); throw error; } }
async function saveConfig(config: CampaignConfig): Promise<void> { await import("node:fs/promises").then(({ mkdir }) => mkdir(agentDir(), { recursive: true, mode: 0o700 })); await writeFile(join(agentDir(), "campaign-config.json"), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 }); }
function validateConfig(value: CampaignConfig): CampaignConfig { if (!["always", "smart", "never"].includes(value.launchPolicy)) throw new Error("launchPolicy must be always, smart, or never"); for (const key of ["maxAgents", "maxConcurrency", "maxRounds", "maxTokens"] as const) if (!Number.isInteger(value.hardCaps[key]) || value.hardCaps[key] < 1) throw new Error(`hardCaps.${key} must be positive`); if (!Number.isInteger(value.pollMs) || value.pollMs < 100) throw new Error("pollMs must be at least 100"); return value; }
