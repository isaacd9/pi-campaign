import { createId } from "../shared/ids.ts";
import type { CampaignKernel, KernelAssignment, KernelRun, KernelStatus } from "./kernel.ts";
export type FakeHandler = (assignment: KernelAssignment, attempt: number) => unknown | Promise<unknown>;
export class FakeKernel implements CampaignKernel {
  readonly worktreeIsolation = true;
  readonly assignments: KernelAssignment[] = []; private runs = new Map<string, KernelStatus>(); private attempts = new Map<string, number>();
  constructor(private handler: FakeHandler = (assignment) => ({ text: `completed: ${assignment.task}` }), private latencyPolls = 0) {}
  async ping() { return { version: 1, methods: ["ping", "spawn", "status", "interrupt", "stop"] }; }
  async spawn(assignment: KernelAssignment): Promise<KernelRun> { const id = createId("fake"); this.assignments.push(structuredClone(assignment)); const attempt = (this.attempts.get(assignment.label ?? assignment.task) ?? 0) + 1; this.attempts.set(assignment.label ?? assignment.task, attempt); this.runs.set(id, { state: this.latencyPolls > 0 ? "running" : "complete", raw: { polls: 0, assignment, attempt } }); if (this.latencyPolls === 0) await this.finish(id); return { id, asyncDir: `/fake/${id}` }; }
  async status(run: KernelRun): Promise<KernelStatus> { const status = this.runs.get(run.id); if (!status) return { state: "failed", error: "Unknown fake run" }; const raw = status.raw as { polls: number } | undefined; if (status.state === "running" && raw && ++raw.polls >= this.latencyPolls) await this.finish(run.id); return structuredClone(this.runs.get(run.id)!); }
  async interrupt(run: KernelRun): Promise<void> { const status = this.runs.get(run.id); if (status?.state === "running") status.state = "paused"; }
  async stop(run: KernelRun): Promise<void> { const status = this.runs.get(run.id); if (status && ["running", "queued", "paused"].includes(status.state)) status.state = "stopped"; }
  dispose(): void { this.runs.clear(); }
  private async finish(id: string): Promise<void> { const status = this.runs.get(id)!; const raw = status.raw as { assignment: KernelAssignment; attempt: number; polls: number }; try { status.output = await this.handler(raw.assignment, raw.attempt); status.state = "complete"; } catch (error) { status.state = "failed"; status.error = error instanceof Error ? error.message : String(error); } finally { status.tokens = 10; status.cost = 0; } }
}
