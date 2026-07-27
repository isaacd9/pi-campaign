import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { safeName } from "../shared/ids.ts";
export function agentDir(): string { return process.env.PI_AGENT_DIR ?? join(homedir(), ".pi", "agent"); }
export function runRoot(sessionId: string): string { return join(agentDir(), "campaign-runs", safeName(sessionId || "ephemeral")); }
export function runDir(sessionId: string, runId: string): string { return join(runRoot(sessionId), safeName(runId)); }
export function personalCampaignDir(): string { return join(agentDir(), "campaigns"); }
export function projectCampaignDir(cwd: string): string { return join(cwd, ".pi", "campaigns"); }
export interface SavedCampaign { name: string; path: string; scope: "personal" | "project" }
export async function discoverCampaigns(cwd: string, trusted: boolean): Promise<SavedCampaign[]> { const personal = await list(personalCampaignDir(), "personal"); const project = trusted ? await list(projectCampaignDir(cwd), "project") : []; const map = new Map(personal.map((item) => [item.name, item])); for (const item of project) map.set(item.name, item); return [...map.values()].sort((a, b) => a.name.localeCompare(b.name)); }
async function list(dir: string, scope: SavedCampaign["scope"]): Promise<SavedCampaign[]> { try { return (await readdir(dir)).filter((file) => file.endsWith(".campaign.ts")).map((file) => ({ name: file.slice(0, -12), path: join(dir, file), scope })); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; } }
export async function saveCampaign(name: string, source: string, cwd: string, scope: "personal" | "project"): Promise<string> { const dir = scope === "project" ? projectCampaignDir(cwd) : personalCampaignDir(); await mkdir(dir, { recursive: true, mode: 0o700 }); const path = join(dir, `${safeName(name)}.campaign.ts`); await writeFile(path, source, { mode: 0o600, flag: "wx" }); return path; }
export async function loadSavedCampaign(cwd: string, trusted: boolean, name: string): Promise<{ source: string; campaign: SavedCampaign }> { const campaign = (await discoverCampaigns(cwd, trusted)).find((item) => item.name === name); if (!campaign) throw new Error(`Saved campaign '${name}' not found.`); return { source: await readFile(campaign.path, "utf8"), campaign }; }
