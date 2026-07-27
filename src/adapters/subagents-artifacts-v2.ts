import { watch, type FSWatcher } from "node:fs";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { KernelStatus } from "./kernel.ts";

export const SUPPORTED_LIFECYCLE_ARTIFACT_VERSIONS = new Set([2]);
interface ArtifactStatus {
  lifecycleArtifactVersion?: number;
  state?: string;
  outputFile?: string;
  error?: string;
  totalTokens?: { total?: number };
  totalCost?: { costUsd?: number; total?: number };
  steps?: Array<{ structuredOutput?: unknown; recentOutput?: string[] }>;
}

export async function readSubagentStatus(asyncDir: string, trustedOutputPath?: string): Promise<KernelStatus> {
  const lexicalRoot = resolve(asyncDir);
  const root = await realpath(lexicalRoot);
  const raw = JSON.parse(await readFile(join(root, "status.json"), "utf8")) as ArtifactStatus;
  if (raw.lifecycleArtifactVersion !== 2) throw new Error(`Unsupported or missing pi-subagents lifecycleArtifactVersion ${String(raw.lifecycleArtifactVersion)}; expected 2.`);
  const state = normalizeState(raw.state);
  let output: unknown = raw.steps?.at(-1)?.structuredOutput;
  // pi-subagents status.outputFile is the full child transcript, which includes
  // the assignment prompt. Campaign configures a separate final-result path;
  // prefer that trusted, caller-owned path so prompt examples cannot be parsed
  // as the child's result (especially during compiler repair).
  if (output === undefined && trustedOutputPath && state === "complete") output = await readTrustedOutput(trustedOutputPath);
  if (output === undefined && raw.outputFile) {
    const path = await containedArtifactPath(lexicalRoot, root, raw.outputFile);
    try { output = await readFile(path, "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  if (output === undefined && raw.steps?.at(-1)?.recentOutput) output = raw.steps.at(-1)!.recentOutput!.join("\n");
  const cost = raw.totalCost?.costUsd ?? raw.totalCost?.total;
  return {
    state,
    ...(output !== undefined ? { output } : {}),
    ...(raw.error ? { error: raw.error } : {}),
    ...(raw.totalTokens?.total !== undefined ? { tokens: raw.totalTokens.total } : {}),
    ...(cost !== undefined ? { cost } : {}),
    raw,
  };
}

async function readTrustedOutput(path: string): Promise<string> {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isFile()) throw new Error(`Campaign kernel output is not a regular file: ${path}`);
  return readFile(path, "utf8");
}

async function containedArtifactPath(lexicalRoot: string, canonicalRoot: string, value: string): Promise<string> {
  // Compare the status path against the spelling supplied by pi-subagents
  // before comparing real paths. On macOS /var canonically resolves to
  // /private/var; mixing those two forms causes a valid child output to look
  // lexically outside its own async directory.
  const candidate = isAbsolute(value) ? resolve(value) : resolve(lexicalRoot, value);
  const lexical = relative(lexicalRoot, candidate);
  if (lexical.startsWith("..") || isAbsolute(lexical)) throw new Error(`pi-subagents outputFile escapes async artifact directory: ${value}`);
  try {
    const actual = await realpath(candidate);
    const rel = relative(canonicalRoot, actual);
    if (rel.startsWith("..") || isAbsolute(rel)) throw new Error(`pi-subagents outputFile resolves outside async artifact directory: ${value}`);
    return actual;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return candidate;
    throw error;
  }
}

export function watchSubagentStatus(asyncDir: string, onStatus: (status: KernelStatus) => void, intervalMs = 1000): () => void {
  let watcher: FSWatcher | undefined;
  let disposed = false;
  let reading = false;
  const refresh = async () => {
    if (disposed || reading) return;
    reading = true;
    try { onStatus(await readSubagentStatus(asyncDir)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !disposed) onStatus({ state: "failed", error: error instanceof Error ? error.message : String(error) }); }
    finally { reading = false; }
  };
  try {
    watcher = watch(asyncDir, (_event, file) => { if (!file || file === "status.json" || file === "events.jsonl") void refresh(); });
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
