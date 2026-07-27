import { mkdir, readFile, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { writeAtomic } from "./event-store.ts";

interface LeaseData {
  version: 1;
  owner: string;
  nonce: string;
  pid: number;
  acquiredAt: number;
  heartbeatAt: number;
}

export class RunLease {
  private timer?: NodeJS.Timeout;
  private released = false;
  private heartbeatError?: Error;

  private constructor(private lockDir: string, private ownerPath: string, private data: LeaseData) {}

  static async acquire(runDir: string, owner: string, options: { staleMs?: number; heartbeatMs?: number } = {}): Promise<RunLease> {
    const lockDir = join(runDir, "lease.lock");
    const ownerPath = join(lockDir, "owner.json");
    const staleMs = options.staleMs ?? 30_000;
    await mkdir(runDir, { recursive: true, mode: 0o700 });

    for (let tries = 0; tries < 50; tries++) {
      try {
        await mkdir(lockDir, { mode: 0o700 }); // mkdir is the atomic ownership claim.
        const data: LeaseData = { version: 1, owner, nonce: randomUUID(), pid: process.pid, acquiredAt: Date.now(), heartbeatAt: Date.now() };
        try { await writeAtomic(ownerPath, data); }
        catch (error) { await rm(lockDir, { recursive: true, force: true }); throw error; }
        const lease = new RunLease(lockDir, ownerPath, data);
        const interval = options.heartbeatMs ?? 10_000;
        lease.timer = setInterval(() => void lease.heartbeat().catch((error) => lease.failHeartbeat(error)), interval);
        lease.timer.unref();
        return lease;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }

      let existing: LeaseData;
      try { existing = validateLease(JSON.parse(await readFile(ownerPath, "utf8"))); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT" && tries < 49) { await delay(10); continue; }
        throw new Error("Campaign lease is corrupt or incomplete; verify no runner is active before removing lease.lock.", { cause: error instanceof Error ? error : undefined });
      }
      if (Date.now() - existing.heartbeatAt <= staleMs && processAlive(existing.pid)) throw new Error(`Campaign is leased by ${existing.owner} (pid ${existing.pid}).`);
      if (processAlive(existing.pid)) throw new Error(`Campaign lease heartbeat is stale but owner process ${existing.pid} is alive; refusing unsafe reclamation.`);

      const reclaimed = `${lockDir}.stale-${process.pid}-${randomUUID()}`;
      try {
        await rename(lockDir, reclaimed); // only one contender can move this generation
        await rm(reclaimed, { recursive: true, force: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") { await delay(5); continue; }
        throw error;
      }
    }
    throw new Error("Could not acquire campaign lease after concurrent stale-lease reclamation.");
  }

  assertHealthy(): void { if (this.heartbeatError) throw this.heartbeatError; }

  async heartbeat(): Promise<void> {
    if (this.released) return;
    this.assertHealthy();
    const current = validateLease(JSON.parse(await readFile(this.ownerPath, "utf8")));
    if (current.nonce !== this.data.nonce || current.pid !== process.pid) throw new Error("Campaign lease ownership changed unexpectedly.");
    this.data.heartbeatAt = Date.now();
    await writeAtomic(this.ownerPath, this.data);
  }

  async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    if (this.timer) clearInterval(this.timer);
    try {
      const current = validateLease(JSON.parse(await readFile(this.ownerPath, "utf8")));
      if (current.nonce === this.data.nonce && current.pid === process.pid) await rm(this.lockDir, { recursive: true, force: true });
    } catch { /* best effort; never remove another owner's lock */ }
  }

  private failHeartbeat(error: unknown): void {
    if (this.released || this.heartbeatError) return;
    this.heartbeatError = new Error(`Campaign lease heartbeat failed: ${error instanceof Error ? error.message : String(error)}`);
    if (this.timer) clearInterval(this.timer);
  }
}

function validateLease(value: unknown): LeaseData {
  if (!value || typeof value !== "object") throw new Error("Invalid lease owner");
  const data = value as Partial<LeaseData>;
  if (data.version !== 1 || typeof data.owner !== "string" || typeof data.nonce !== "string" || !Number.isInteger(data.pid) || !Number.isFinite(data.heartbeatAt) || !Number.isFinite(data.acquiredAt)) throw new Error("Invalid lease owner");
  return data as LeaseData;
}
function processAlive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch { return false; } }
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
