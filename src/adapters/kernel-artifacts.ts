import { watch, type FSWatcher } from "node:fs";
import { lstat, readFile, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { KernelStatus } from "./kernel.ts";

export const SUPPORTED_CAMPAIGN_LIFECYCLE_ARTIFACT_VERSIONS = new Set([1]);
interface ArtifactStatus {
  campaignLifecycleArtifactVersion?: number;
  state?: string;
  outputFile?: string;
  output?: unknown;
  error?: string;
  currentTool?: string;
  currentPath?: string;
  recentOutput?: string[];
  model?: string;
  thinking?: string;
  tokens?: number;
  cost?: number;
  turns?: number;
  toolCalls?: number;
  sessionFile?: string;
}

export async function readKernelStatus(asyncDir: string, trustedOutputPath?: string): Promise<KernelStatus> {
  const root = await realpath(resolve(asyncDir));
  const raw = JSON.parse(await readFile(join(root, "status.json"), "utf8")) as ArtifactStatus;
  if (raw.campaignLifecycleArtifactVersion !== 1) throw new Error(`Unsupported or missing campaignLifecycleArtifactVersion ${String(raw.campaignLifecycleArtifactVersion)}; expected 1.`);
  const state = normalizeState(raw.state);
  let output: unknown = raw.output;
  if (output === undefined && trustedOutputPath && state === "complete") output = await readTrustedOutput(trustedOutputPath);
  return {
    state,
    ...(output !== undefined ? { output } : {}),
    ...(raw.error ? { error: raw.error } : {}),
    ...(raw.tokens !== undefined ? { tokens: raw.tokens } : {}),
    ...(raw.cost !== undefined ? { cost: raw.cost } : {}),
    raw: {
      ...raw,
      steps: [{ recentOutput: raw.recentOutput, model: raw.model, thinking: raw.thinking }],
    },
  };
}

async function readTrustedOutput(path: string): Promise<string> {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isFile()) throw new Error(`Campaign kernel output is not a regular file: ${path}`);
  return readFile(path, "utf8");
}

export function watchKernelStatus(asyncDir: string, onStatus: (status: KernelStatus) => void, intervalMs = 1000): () => void {
  let watcher: FSWatcher | undefined;
  let disposed = false;
  let reading = false;
  const refresh = async () => {
    if (disposed || reading) return;
    reading = true;
    try { onStatus(await readKernelStatus(asyncDir)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !disposed) onStatus({ state: "failed", error: error instanceof Error ? error.message : String(error) }); }
    finally { reading = false; }
  };
  try {
    watcher = watch(asyncDir, (_event, file) => { if (!file || file === "status.json") void refresh(); });
    watcher.on("error", () => { watcher?.close(); watcher = undefined; });
  } catch { /* portable interval remains active */ }
  const timer = setInterval(() => void refresh(), intervalMs);
  timer.unref();
  void refresh();
  return () => { disposed = true; clearInterval(timer); watcher?.close(); };
}

function normalizeState(state: string | undefined): KernelStatus["state"] {
  return ["queued", "running", "complete", "failed", "paused", "stopped"].includes(state ?? "") ? state as KernelStatus["state"] : "failed";
}
