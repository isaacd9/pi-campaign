import { mkdir, readFile, realpath, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { agentDir } from "../persistence/paths.ts";
import { sha256 } from "../shared/json.ts";
import { writeAtomic } from "../persistence/event-store.ts";

interface Owner { version: 1; nonce: string; pid: number; cwd: string; heartbeatAt: number }

/** Cross-process mutex for mutation-capable work in one canonical worktree. */
export async function withCwdWriterLock<T>(cwd: string, work: () => Promise<T>, options: { staleMs?: number; pollMs?: number } = {}): Promise<T> {
  const canonical = await realpath(cwd);
  const root = join(agentDir(), "campaign-writer-locks");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const lockDir = join(root, `${sha256(canonical).slice(0, 32)}.lock`);
  const ownerPath = join(lockDir, "owner.json");
  const nonce = randomUUID();
  const staleMs = options.staleMs ?? 30_000;
  const pollMs = options.pollMs ?? 100;

  while (true) {
    try {
      await mkdir(lockDir, { mode: 0o700 });
      const owner: Owner = { version: 1, nonce, pid: process.pid, cwd: canonical, heartbeatAt: Date.now() };
      try { await writeAtomic(ownerPath, owner); }
      catch (error) { await rm(lockDir, { recursive: true, force: true }); throw error; }
      let heartbeatError: Error | undefined;
      let heartbeatChain: Promise<void> = Promise.resolve();
      const timer = setInterval(() => {
        owner.heartbeatAt = Date.now();
        heartbeatChain = heartbeatChain.then(() => writeAtomic(ownerPath, owner)).catch((error) => { heartbeatError = new Error(`Writer-lock heartbeat failed: ${error instanceof Error ? error.message : String(error)}`); });
      }, Math.min(10_000, Math.max(250, staleMs / 3)));
      timer.unref();
      try {
        const result = await work();
        if (heartbeatError) throw heartbeatError;
        return result;
      } finally {
        clearInterval(timer);
        await heartbeatChain;
        try {
          const current = JSON.parse(await readFile(ownerPath, "utf8")) as Owner;
          if (current.nonce === nonce && current.pid === process.pid) await rm(lockDir, { recursive: true, force: true });
        } catch { /* never remove an unknown owner */ }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }

    try {
      const owner = validateOwner(JSON.parse(await readFile(ownerPath, "utf8")));
      if (Date.now() - owner.heartbeatAt > staleMs && !processAlive(owner.pid)) {
        const stale = `${lockDir}.stale-${process.pid}-${randomUUID()}`;
        try { await rename(lockDir, stale); await rm(stale, { recursive: true, force: true }); continue; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await delay(pollMs);
  }
}

function validateOwner(value: unknown): Owner {
  if (!value || typeof value !== "object") throw new Error("Writer lock owner is invalid.");
  const owner = value as Partial<Owner>;
  if (owner.version !== 1 || typeof owner.nonce !== "string" || !Number.isInteger(owner.pid) || typeof owner.cwd !== "string" || !Number.isFinite(owner.heartbeatAt)) throw new Error("Writer lock owner is invalid.");
  return owner as Owner;
}
function processAlive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch { return false; } }
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
