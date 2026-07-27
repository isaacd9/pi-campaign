import type { CampaignKernel, KernelAssignment, KernelRun, KernelStatus } from "./kernel.ts";
import { readSubagentStatus } from "./subagents-artifacts-v2.ts";
export interface EventBus { on(event: string, handler: (data: unknown) => void): (() => void) | void; emit(event: string, data: unknown): void }
type Method = "ping" | "spawn" | "status" | "interrupt" | "stop";
interface Reply { version: 1; requestId: string; success: boolean; data?: unknown; error?: { code: string; message: string } }
export class SubagentsRpcV1Kernel implements CampaignKernel {
  readonly worktreeIsolation = false;
  private disposed = false; private pending = new Set<() => void>(); private spawnedAt = new Map<string, number>();
  constructor(private events: EventBus, private timeoutMs = 5_000, private startupGraceMs = 30_000) {}
  async ping(): Promise<{ version: number; methods: string[] }> { const data = await this.call("ping", {}) as { version: number; methods: string[] }; return data; }
  async spawn(assignment: KernelAssignment): Promise<KernelRun> {
    const output = assignment.outputPath ?? `${assignment.cwd}/.pi/campaign-runs/${Date.now()}-${Math.random().toString(36).slice(2)}.output.txt`;
    // RPC v1 validates against the public single-agent schema. It cannot carry
    // phase/label/thinking/outputSchema for a solo spawn, so those stay in the
    // campaign record rather than being sent as unsupported private fields.
    const data = await this.call("spawn", { agent: assignment.agent, task: assignment.task, cwd: assignment.cwd, context: "fresh", async: true, clarify: false, model: assignment.model, output, acceptance: assignment.acceptance, timeoutMs: assignment.timeoutMs });
    const details = (data as { details?: { asyncId?: string; asyncDir?: string } }).details;
    if (!details?.asyncId) throw new Error("pi-subagents spawn reply omitted asyncId.");
    this.spawnedAt.set(details.asyncId, Date.now());
    return { id: details.asyncId, ...(details.asyncDir ? { asyncDir: details.asyncDir } : {}), outputPath: output };
  }
  async status(run: KernelRun): Promise<KernelStatus> {
    if (run.asyncDir) {
      try {
        const status = await readSubagentStatus(run.asyncDir, run.outputPath);
        if (!["queued", "running"].includes(status.state)) this.spawnedAt.delete(run.id);
        return status;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        const spawnedAt = this.spawnedAt.get(run.id);
        // RPC spawn can reply after creating asyncDir but just before its runner
        // atomically publishes status.json. Querying RPC status in this window
        // returns a misleading hard failure and leaves the launched child orphaned.
        if (spawnedAt !== undefined && Date.now() - spawnedAt < this.startupGraceMs) return { state: "queued" };
      }
    }
    const data = await this.call("status", { id: run.id });
    const status = statusFromRpc(data);
    if (!["queued", "running"].includes(status.state)) this.spawnedAt.delete(run.id);
    return status;
  }
  async interrupt(run: KernelRun): Promise<void> { await this.call("interrupt", { id: run.id, ...(run.asyncDir ? { dir: run.asyncDir } : {}) }); }
  async stop(run: KernelRun): Promise<void> {
    while (true) {
      try { await this.call("stop", { id: run.id, ...(run.asyncDir ? { dir: run.asyncDir } : {}) }); return; }
      catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const spawnedAt = this.spawnedAt.get(run.id);
        if (/Status file not found/i.test(message) && spawnedAt !== undefined && Date.now() - spawnedAt < this.startupGraceMs) { await delay(50); continue; }
        if (/invalid_state:.*\b(?:complete|failed|stopped)\b/i.test(message)) return;
        throw error;
      }
    }
  }
  dispose(): void { this.disposed = true; for (const cancel of this.pending) cancel(); this.pending.clear(); this.spawnedAt.clear(); }
  private call(method: Method, params: unknown): Promise<unknown> {
    if (this.disposed) return Promise.reject(new Error("pi-subagents RPC adapter disposed")); const requestId = `campaign-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    return new Promise((resolve, reject) => {
      let off: (() => void) | void; const finish = () => { clearTimeout(timer); if (typeof off === "function") off(); this.pending.delete(cancel); };
      const cancel = () => { finish(); reject(new Error("pi-subagents RPC adapter disposed")); }; this.pending.add(cancel);
      const timer = setTimeout(() => { finish(); reject(new Error(`pi-subagents RPC ${method} timed out after ${this.timeoutMs}ms`)); }, this.timeoutMs); timer.unref();
      off = this.events.on(`subagents:rpc:v1:reply:${requestId}`, (raw) => { const reply = raw as Reply; if (reply.requestId !== requestId) return; finish(); if (!reply.success) reject(new Error(`${reply.error?.code ?? "rpc_error"}: ${reply.error?.message ?? "Unknown RPC error"}`)); else resolve(reply.data); });
      this.events.emit("subagents:rpc:v1:request", { version: 1, requestId, method, params, source: { extension: "pi-campaign" } });
    });
  }
}
function delay(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }
function statusFromRpc(data: unknown): KernelStatus { const text = (data as { text?: string }).text ?? ""; const state = /\bcomplete\b/i.test(text) ? "complete" : /\bfailed\b/i.test(text) ? "failed" : /\bpaused\b/i.test(text) ? "paused" : /\bstopped\b/i.test(text) ? "stopped" : "running"; return { state, raw: data, ...(state === "failed" ? { error: text } : {}) }; }
export const RPC_V1_UNSUPPORTED_CONTROLS = ["resume-child", "steer", "append-step"] as const;
