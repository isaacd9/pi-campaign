import { spawn } from "node:child_process";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { Ajv } from "ajv";
import type { GateCheck } from "../dsl/types.ts";
import type { CampaignState } from "../persistence/types.ts";
import { sha256 } from "../shared/json.ts";
import { evaluatePredicate, resolveExpression, type ExpressionContext } from "../supervisor/expressions.ts";

export interface GateResult { outcome: "passed" | "failed" | "errored" | "timed-out"; evidence?: unknown; error?: string }
export interface GateServices {
  approve?: (prompt: string) => Promise<boolean>;
  review?: (focus: string, agent?: string) => Promise<{ passed: boolean; evidence: unknown }>;
  safety?: (prompt: string, capabilities: string[]) => Promise<boolean>;
  acceptance?: (node: string) => Promise<{ passed: boolean; evidence: unknown }>;
}

export class GateExecutor {
  private ajv = new Ajv({ allErrors: true, strict: false });
  constructor(private cwd: string, private services: GateServices = {}) {}

  async execute(check: GateCheck, state: CampaignState, context: ExpressionContext, timeoutMs?: number, signal?: AbortSignal): Promise<GateResult> {
    try {
      if (check.type === "command") return await this.executeInner(check, state, context, signal, timeoutMs ?? check.timeoutMs);
      return await withTimeout(this.executeInner(check, state, context, signal), timeoutMs, signal);
    } catch (error) {
      if (error instanceof TimeoutError) return { outcome: "timed-out", error: error.message };
      return { outcome: "errored", error: error instanceof Error ? error.message : String(error) };
    }
  }

  private async executeInner(check: GateCheck, state: CampaignState, context: ExpressionContext, signal?: AbortSignal, timeoutMs?: number): Promise<GateResult> {
    if (signal?.aborted) throw abortError();
    switch (check.type) {
      case "command": {
        const result = await runCommand(check.command, safeResolve(this.cwd, check.cwd ?? "."), timeoutMs ?? 60_000, signal);
        const expected = check.expectedExitCode ?? 0;
        const passed = result.exitCode === expected && (!check.outputIncludes || `${result.stdout}\n${result.stderr}`.includes(check.outputIncludes));
        return { outcome: passed ? "passed" : "failed", evidence: result };
      }
      case "schema": {
        const value = resolveExpression(check.value, context);
        const validate = this.ajv.compile(check.schema);
        const passed = validate(value);
        return { outcome: passed ? "passed" : "failed", evidence: { value, errors: validate.errors ?? [] } };
      }
      case "artifact": return this.executeArtifact(check);
      case "predicate": return { outcome: evaluatePredicate(check.predicate, context) ? "passed" : "failed", evidence: check.predicate };
      case "approval": {
        if (!this.services.approve) return { outcome: "errored", error: "Approval UI is unavailable in this mode." };
        return { outcome: await this.services.approve(check.prompt) ? "passed" : "failed" };
      }
      case "review": {
        if (!this.services.review) return { outcome: "errored", error: "Review service is unavailable." };
        const result = await this.services.review(check.focus, check.agent);
        return { outcome: result.passed ? "passed" : "failed", evidence: result.evidence };
      }
      case "acceptance": {
        if (!this.services.acceptance) return { outcome: "errored", error: "Acceptance service is unavailable." };
        const result = await this.services.acceptance(check.node);
        return { outcome: result.passed ? "passed" : "failed", evidence: result.evidence };
      }
      case "safety": {
        if (!this.services.safety) return { outcome: "errored", error: "Safety confirmation service is unavailable." };
        return { outcome: await this.services.safety(check.prompt, check.capabilities ?? []) ? "passed" : "failed" };
      }
      case "budget": {
        const elapsed = Date.now() - state.createdAt;
        const violations = [
          check.maxTokens !== undefined && state.tokens > check.maxTokens ? `tokens ${state.tokens}/${check.maxTokens}` : "",
          check.maxCost !== undefined && state.cost > check.maxCost ? `cost ${state.cost}/${check.maxCost}` : "",
          check.maxElapsedMs !== undefined && elapsed > check.maxElapsedMs ? `elapsed ${elapsed}/${check.maxElapsedMs}` : "",
          check.maxAgents !== undefined && state.agentsStarted > check.maxAgents ? `agents ${state.agentsStarted}/${check.maxAgents}` : "",
        ].filter(Boolean);
        return { outcome: violations.length ? "failed" : "passed", evidence: { violations, tokens: state.tokens, cost: state.cost, elapsed, agents: state.agentsStarted } };
      }
    }
  }

  private async executeArtifact(check: Extract<GateCheck, { type: "artifact" }>): Promise<GateResult> {
    const candidate = safeResolve(this.cwd, check.path);
    try {
      const linkInfo = await lstat(candidate);
      if (linkInfo.isSymbolicLink() || !linkInfo.isFile()) return { outcome: "failed", evidence: { path: candidate, reason: linkInfo.isSymbolicLink() ? "symlink rejected" : "not a regular file" } };
      const root = await realpath(this.cwd);
      const actual = await realpath(candidate);
      const rel = relative(root, actual);
      if (rel.startsWith("..") || isAbsolute(rel)) return { outcome: "failed", evidence: { path: candidate, reason: "realpath escapes campaign cwd" } };
      if (check.exists === false) return { outcome: "failed", evidence: { path: actual, size: linkInfo.size } };
      if (check.maxBytes !== undefined && linkInfo.size > check.maxBytes) return { outcome: "failed", evidence: { path: actual, size: linkInfo.size, reason: `size exceeds ${check.maxBytes}` } };
      const content = await readFile(actual);
      const digest = sha256(content);
      const passed = (!check.sha256 || digest === check.sha256) && (!check.contentIncludes || content.toString("utf8").includes(check.contentIncludes));
      return { outcome: passed ? "passed" : "failed", evidence: { path: actual, size: linkInfo.size, sha256: digest } };
    } catch (error) {
      const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
      if (!missing) throw error;
      return { outcome: missing && check.exists === false ? "passed" : "failed", evidence: { path: candidate, missing } };
    }
  }
}

function safeResolve(root: string, candidate: string): string {
  const path = resolve(root, candidate);
  const rel = relative(resolve(root), path);
  if (rel.startsWith("..") || isAbsolute(rel)) throw new Error(`Gate path escapes campaign cwd: ${candidate}`);
  return path;
}

function runCommand(command: string, cwd: string, timeoutMs: number, signal?: AbortSignal): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const detached = process.platform !== "win32";
    const child = spawn(command, { cwd, shell: true, stdio: ["ignore", "pipe", "pipe"], detached });
    let stdout = "", stderr = "", settled = false, termination: Error | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      signal?.removeEventListener("abort", onAbort);
      callback();
    };
    const kill = (reason: Error) => {
      if (termination) return;
      termination = reason;
      terminate(child.pid, detached, "SIGTERM");
      killTimer = setTimeout(() => terminate(child.pid, detached, "SIGKILL"), 750);
      killTimer.unref();
    };
    const onAbort = () => kill(abortError());
    const timer = setTimeout(() => kill(new TimeoutError(`Command gate timed out after ${timeoutMs}ms`)), timeoutMs);
    timer.unref();
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    child.stdout.on("data", (chunk) => { if (stdout.length < 100_000) stdout += String(chunk).slice(0, 100_000 - stdout.length); });
    child.stderr.on("data", (chunk) => { if (stderr.length < 100_000) stderr += String(chunk).slice(0, 100_000 - stderr.length); });
    child.on("error", (error) => finish(() => reject(error)));
    child.on("close", (code) => finish(() => { if (termination) { terminate(child.pid, detached, "SIGKILL"); reject(termination); } else resolvePromise({ exitCode: code, stdout, stderr }); }));
  });
}

function terminate(pid: number | undefined, detached: boolean, signal: NodeJS.Signals): void {
  if (!pid) return;
  try { process.kill(detached ? -pid : pid, signal); } catch { /* process/group already gone or not signalable */ }
}
class TimeoutError extends Error {}
function abortError(): Error { const error = new Error("Gate execution aborted"); error.name = "AbortError"; return error; }
async function withTimeout<T>(promise: Promise<T>, timeoutMs?: number, signal?: AbortSignal): Promise<T> {
  if (!timeoutMs && !signal) return promise;
  return new Promise<T>((resolvePromise, reject) => {
    const timer = timeoutMs ? setTimeout(() => reject(new TimeoutError(`Gate timed out after ${timeoutMs}ms`)), timeoutMs) : undefined;
    timer?.unref();
    const abort = () => reject(abortError());
    signal?.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => { if (timer) clearTimeout(timer); signal?.removeEventListener("abort", abort); resolvePromise(value); },
      (error) => { if (timer) clearTimeout(timer); signal?.removeEventListener("abort", abort); reject(error); },
    );
  });
}
