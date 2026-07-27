import assert from "node:assert/strict";
import test from "node:test";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { GateExecutor } from "../../src/gates/index.ts";
import { initialState } from "../../src/supervisor/reducer.ts";
test("command, schema, artifact, predicate, approval, safety, and budget gates", async () => { const cwd = await mkdtemp(join(tmpdir(), "campaign-gates-")); try { await writeFile(join(cwd, "ok.txt"), "hello"); const state = initialState("r", "g", cwd, Date.now()); state.outputs.x = { value: 3 }; const gates = new GateExecutor(cwd, { approve: async () => true, safety: async () => true }); const ctx = { outputs: state.outputs }; assert.equal((await gates.execute({ type: "command", command: "printf pass", outputIncludes: "pass" }, state, ctx)).outcome, "passed"); assert.equal((await gates.execute({ type: "schema", value: { $ref: "x.output" }, schema: { type: "object", required: ["value"] } }, state, ctx)).outcome, "passed"); assert.equal((await gates.execute({ type: "artifact", path: "ok.txt", contentIncludes: "hello" }, state, ctx)).outcome, "passed"); assert.equal((await gates.execute({ type: "predicate", predicate: { op: "eq", left: { $ref: "x.output.value" }, right: 3 } }, state, ctx)).outcome, "passed"); assert.equal((await gates.execute({ type: "approval", prompt: "go" }, state, ctx)).outcome, "passed"); assert.equal((await gates.execute({ type: "safety", prompt: "safe" }, state, ctx)).outcome, "passed"); assert.equal((await gates.execute({ type: "budget", maxAgents: 0 }, state, ctx)).outcome, "passed"); state.agentsStarted = 1; assert.equal((await gates.execute({ type: "budget", maxAgents: 0 }, state, ctx)).outcome, "failed"); } finally { await rm(cwd, { recursive: true, force: true }); } });

test("aborting a command gate terminates its process group and awaits exit", { skip: process.platform === "win32" }, async () => {
  const cwd = await mkdtemp(join(tmpdir(), "campaign-gate-abort-"));
  try {
    const marker = join(cwd, "late.txt");
    const controller = new AbortController();
    const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(`setTimeout(() => require('fs').writeFileSync(${JSON.stringify(marker)}, 'late'), 400)`)}`;
    const promise = new GateExecutor(cwd).execute({ type: "command", command, timeoutMs: 5_000 }, initialState("r", "g", cwd), { outputs: {} }, undefined, controller.signal);
    setTimeout(() => controller.abort(), 50);
    assert.equal((await promise).outcome, "errored");
    await new Promise((resolve) => setTimeout(resolve, 500));
    await assert.rejects(access(marker));
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
