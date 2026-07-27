import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { compileCampaign } from "../../src/compiler/index.ts";
import { FakeKernel } from "../../src/adapters/fake-kernel.ts";
import { EventStore } from "../../src/persistence/event-store.ts";
import { GateExecutor } from "../../src/gates/index.ts";
import { CampaignSupervisor } from "../../src/supervisor/supervisor.ts";
import { validCampaign } from "../fixtures/valid.ts";
test("fake kernel executes sequence, bounded map, gate, checkpoint, and emit", async () => { const cwd = await mkdtemp(join(tmpdir(), "campaign-supervisor-")); try { const { ir } = compileCampaign(validCampaign); const store = await EventStore.create(join(cwd, "run"), "run", "goal", cwd); await store.append("run.created", { ir }); const kernel = new FakeKernel((assignment) => assignment.agent === "scout" ? { files: ["a.ts", "b.ts", "c.ts"] } : { edited: assignment.task }); const emitted: string[] = []; const supervisor = new CampaignSupervisor(ir, store, kernel, new GateExecutor(cwd), { pollMs: 1, emit: (message) => emitted.push(message) }); const state = await supervisor.run(); assert.equal(state.status, "completed"); assert.equal(kernel.assignments.length, 4); assert.deepEqual(state.outputs.map, [{ edited: "Edit a.ts" }, { edited: "Edit b.ts" }, { edited: "Edit c.ts" }]); assert.ok(state.checkpoints.includes("done")); assert.deepEqual(emitted, ["Done"]); assert.equal(state.gates[0]?.outcome, "passed"); } finally { await rm(cwd, { recursive: true, force: true }); } });
test("replay does not rerun completed nodes", async () => { const cwd = await mkdtemp(join(tmpdir(), "campaign-resume-")); try { const { ir } = compileCampaign(validCampaign); const store = await EventStore.create(join(cwd, "run"), "run", "goal", cwd); await store.append("run.created", { ir }); const firstKernel = new FakeKernel((assignment) => assignment.agent === "scout" ? { files: [] } : {}); await new CampaignSupervisor(ir, store, firstKernel, new GateExecutor(cwd), { pollMs: 1 }).run(); const reopened = await EventStore.open(join(cwd, "run")); const secondKernel = new FakeKernel(); await new CampaignSupervisor(ir, reopened.store, secondKernel, new GateExecutor(cwd), { pollMs: 1 }).run(); assert.equal(secondKernel.assignments.length, 0); } finally { await rm(cwd, { recursive: true, force: true }); } });
test("interrupted writer verifies before retry and reuses completed work", async () => { const cwd = await mkdtemp(join(tmpdir(), "campaign-recovery-")); try { const source = `import {defineCampaign,task} from "pi-campaign/dsl"; export default defineCampaign({meta:{name:"recover",version:1},limits:{maxAgents:2,maxConcurrency:1,maxRounds:1,maxTokens:100},program:task({id:"write",agent:"worker",prompt:"edit",capabilities:["code-write"],recovery:"verify-before-retry"})});`; const { ir } = compileCampaign(source); const store = await EventStore.create(join(cwd, "run"), "run", "goal", cwd); await store.append("run.created", { ir }); await store.append("node.scheduled", { nodeId: "write", attempt: 1 }); await store.append("node.started", { nodeId: "write", kernelRunId: "lost" }); const kernel = new FakeKernel((assignment) => assignment.agent === "reviewer" ? { complete: true, output: { already: "done" }, evidence: "file verified" } : (() => { throw new Error("writer must not rerun"); })()); const supervisor = new CampaignSupervisor(ir, store, kernel, new GateExecutor(cwd), { pollMs: 1 }); await supervisor.recoverInterrupted(); const state = await supervisor.run(); assert.equal(state.status, "completed"); assert.deepEqual(state.outputs.write, { already: "done" }); assert.deepEqual(kernel.assignments.map((item) => item.agent), ["reviewer"]); } finally { await rm(cwd, { recursive: true, force: true }); } });
test("bounded loop evaluates freshly persisted outputs", async () => { const cwd = await mkdtemp(join(tmpdir(), "campaign-loop-")); try { const source = `import {defineCampaign,repeatUntil,task,ref} from "pi-campaign/dsl"; export default defineCampaign({meta:{name:"loop",version:1},limits:{maxAgents:3,maxConcurrency:1,maxRounds:3,maxTokens:100},program:repeatUntil({id:"loop",body:task({id:"check",agent:"scout",prompt:"check",output:{type:"object",required:["done"]}}),until:{op:"truthy",value:ref("check.output.done")},maxRounds:3})});`; const { ir } = compileCampaign(source); const store = await EventStore.create(join(cwd, "run"), "run", "goal", cwd); await store.append("run.created", { ir }); let calls = 0; const kernel = new FakeKernel(() => ({ done: ++calls === 2 })); const state = await new CampaignSupervisor(ir, store, kernel, new GateExecutor(cwd), { pollMs: 1 }).run(); assert.equal(state.status, "completed"); assert.equal(calls, 2); } finally { await rm(cwd, { recursive: true, force: true }); } });
test("v1-like kernels serialize writer fan-out when worktree isolation is unavailable", async () => { const cwd = await mkdtemp(join(tmpdir(), "campaign-writer-lock-")); try { const { ir } = compileCampaign(validCampaign); const store = await EventStore.create(join(cwd, "run"), "run", "goal", cwd); await store.append("run.created", { ir }); let active = 0, maximum = 0, sequence = 0; const runs = new Map<string, { assignment: { agent: string; task: string }; polls: number }>(); const kernel = { worktreeIsolation: false, async ping() { return { version: 1, methods: [] }; }, async spawn(assignment: { agent: string; task: string }) { const id = String(++sequence); runs.set(id, { assignment, polls: 0 }); if (assignment.agent === "worker") { active++; maximum = Math.max(maximum, active); } return { id }; }, async status(run: { id: string }) { const entry = runs.get(run.id)!; if (entry.assignment.agent === "scout") return { state: "complete" as const, output: { files: ["a", "b", "c"] } }; if (entry.polls++ === 0) return { state: "running" as const }; active--; return { state: "complete" as const, output: { ok: entry.assignment.task } }; }, async interrupt() {}, async stop() {}, dispose() {} }; const state = await new CampaignSupervisor(ir, store, kernel, new GateExecutor(cwd), { pollMs: 1, approveIsolationDowngrade: async () => true }).run(); assert.equal(state.status, "completed"); assert.equal(maximum, 1); } finally { await rm(cwd, { recursive: true, force: true }); } });
test("required worktree isolation fails without an explicit downgrade approval", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "campaign-isolation-refusal-"));
  try {
    const { ir } = compileCampaign(validCampaign);
    const store = await EventStore.create(join(cwd, "run"), "run", "goal", cwd);
    await store.append("run.created", { ir });
    const kernel = new FakeKernel((assignment) => assignment.agent === "scout" ? { files: ["a"] } : { ok: true });
    Object.defineProperty(kernel, "worktreeIsolation", { value: false });
    const state = await new CampaignSupervisor(ir, store, kernel, new GateExecutor(cwd), { pollMs: 1 }).run();
    assert.equal(state.status, "failed");
    assert.match(state.error ?? "", /requires worktree isolation/);
    assert.deepEqual(kernel.assignments.map((assignment) => assignment.agent), ["scout"]);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("gate overrides are auditable and do not re-execute the command", async () => { const cwd = await mkdtemp(join(tmpdir(), "campaign-override-")); try { const source = validCampaign.replace('command: "true"', 'command: "printf x >> count.txt; false"').replace('onFail: { action: "stop" }', 'onFail: { action: "pause" }'); const { ir } = compileCampaign(source); const store = await EventStore.create(join(cwd, "run"), "run", "goal", cwd); await store.append("run.created", { ir }); const supervisor = new CampaignSupervisor(ir, store, new FakeKernel((assignment) => assignment.agent === "scout" ? { files: [] } : {}), new GateExecutor(cwd), { pollMs: 1 }); const run = supervisor.run(); while (supervisor.state.status !== "paused") await new Promise((resolve) => setTimeout(resolve, 2)); await supervisor.overrideGate("test", "accepted by test user"); await supervisor.resume(); const state = await run; assert.equal(state.status, "completed"); assert.ok(state.gates.some((record) => record.outcome === "overridden" && record.reason === "accepted by test user")); assert.equal(await readFile(join(cwd, "count.txt"), "utf8"), "x"); await store.append("node.interrupted", { nodeId: "discover", error: "retry fixture" }); await supervisor.retry("discover"); assert.equal(supervisor.state.gates.find((record) => record.outcome === "overridden")?.active, false); } finally { await rm(cwd, { recursive: true, force: true }); } });

test("interrupted command gates pause instead of duplicating uncertain shell effects", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "campaign-command-recovery-"));
  try {
    const source = `import {defineCampaign,gate,commandGate} from "pi-campaign/dsl"; export default defineCampaign({meta:{name:"gate",version:1},limits:{maxAgents:1,maxConcurrency:1,maxRounds:1,maxTokens:10},program:gate({id:"command",check:commandGate({command:"printf x >> count.txt"}),overridable:true,onFail:{action:"stop"}})});`;
    const { ir } = compileCampaign(source);
    const store = await EventStore.create(join(cwd, "run"), "run", "goal", cwd);
    await store.append("run.created", { ir });
    await store.append("run.started");
    await store.append("node.scheduled", { nodeId: "command", attempt: 1 });
    await import("node:fs/promises").then(({ writeFile }) => writeFile(join(cwd, "count.txt"), "x"));
    const supervisor = new CampaignSupervisor(ir, store, new FakeKernel(), new GateExecutor(cwd), { pollMs: 1 });
    await supervisor.recoverInterrupted();
    const running = supervisor.run();
    while (supervisor.state.status !== "paused") await new Promise((resolve) => setTimeout(resolve, 2));
    assert.equal(await readFile(join(cwd, "count.txt"), "utf8"), "x");
    await supervisor.overrideGate("command", "pre-crash effect accepted");
    await supervisor.resume();
    assert.equal((await running).status, "completed");
    assert.equal(await readFile(join(cwd, "count.txt"), "utf8"), "x");
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("safety checkpoint overrides require a reason", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "campaign-safety-reason-"));
  try {
    const source = `import {defineCampaign,gate,safetyGate} from "pi-campaign/dsl"; export default defineCampaign({meta:{name:"safe",version:1},limits:{maxAgents:1,maxConcurrency:1,maxRounds:1,maxTokens:10},program:gate({id:"s",check:safetyGate({prompt:"risk"}),overridable:true,onFail:{action:"pause"}})});`;
    const { ir } = compileCampaign(source);
    const store = await EventStore.create(join(cwd, "run"), "run", "goal", cwd);
    await store.append("run.created", { ir });
    const supervisor = new CampaignSupervisor(ir, store, new FakeKernel(), new GateExecutor(cwd), { pollMs: 1 });
    await assert.rejects(supervisor.overrideGate("s"), /require an explicit reason/);
    await supervisor.overrideGate("s", "accepted for test");
    assert.equal(supervisor.state.gates.at(-1)?.reason, "accepted for test");
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("scheduled-only interrupted writer verifies before any retry", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "campaign-scheduled-writer-"));
  try {
    const source = `import {defineCampaign,task} from "pi-campaign/dsl"; export default defineCampaign({meta:{name:"recover",version:1},limits:{maxAgents:2,maxConcurrency:1,maxRounds:1,maxTokens:100},program:task({id:"write",agent:"worker",prompt:"edit",capabilities:["code-write"],recovery:"verify-before-retry"})});`;
    const { ir } = compileCampaign(source);
    const store = await EventStore.create(join(cwd, "run"), "run", "goal", cwd);
    await store.append("run.created", { ir });
    await store.append("node.scheduled", { nodeId: "write", attempt: 1 });
    const kernel = new FakeKernel((assignment) => assignment.agent === "reviewer" ? { complete: true, output: { already: true }, evidence: "verified" } : (() => { throw new Error("writer must not run"); })());
    const supervisor = new CampaignSupervisor(ir, store, kernel, new GateExecutor(cwd), { pollMs: 1 });
    await supervisor.recoverInterrupted();
    const state = await supervisor.run();
    assert.equal(state.status, "completed");
    assert.deepEqual(kernel.assignments.map((assignment) => assignment.agent), ["reviewer"]);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("composite map bodies keep descendant state and references instance-scoped", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "campaign-composite-map-"));
  try {
    const source = `import {defineCampaign,map,sequence,task,ref,template} from "pi-campaign/dsl"; export default defineCampaign({meta:{name:"map",version:1},limits:{maxAgents:4,maxConcurrency:2,maxRounds:1,maxTokens:100},program:map({id:"map",items:["A","B"],maxItems:2,concurrency:2,body:sequence([task({id:"first",agent:"scout",prompt:template("{{item}}")}),task({id:"second",agent:"scout",prompt:ref("first.output")})])})});`;
    const { ir } = compileCampaign(source);
    const store = await EventStore.create(join(cwd, "run"), "run", "goal", cwd);
    await store.append("run.created", { ir });
    const kernel = new FakeKernel((assignment) => assignment.task);
    const state = await new CampaignSupervisor(ir, store, kernel, new GateExecutor(cwd), { pollMs: 1 }).run();
    assert.equal(state.status, "completed");
    assert.deepEqual(state.outputs.map, ["A", "B"]);
    assert.deepEqual(kernel.assignments.map((assignment) => assignment.task).sort(), ["A", "A", "B", "B"]);
    assert.ok(state.nodes["first[0]"]?.status === "completed" && state.nodes["first[1]"]?.status === "completed");
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("composite loop bodies do not reuse round-one descendants", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "campaign-composite-loop-"));
  try {
    const source = `import {defineCampaign,repeatUntil,sequence,task,ref} from "pi-campaign/dsl"; export default defineCampaign({meta:{name:"loop",version:1},limits:{maxAgents:4,maxConcurrency:1,maxRounds:2,maxTokens:100},program:repeatUntil({id:"loop",body:sequence([task({id:"inspect",agent:"scout",prompt:"inspect"}),task({id:"check",agent:"scout",prompt:ref("inspect.output"),output:{type:"object",required:["done"]}})]),until:{op:"truthy",value:ref("sequence-1.output.done")},maxRounds:2})});`;
    const { ir } = compileCampaign(source);
    const store = await EventStore.create(join(cwd, "run"), "run", "goal", cwd);
    await store.append("run.created", { ir });
    let checks = 0;
    const kernel = new FakeKernel((assignment) => assignment.agent === "scout" && assignment.label === "check" ? { done: ++checks === 2 } : `round-${checks + 1}`);
    const state = await new CampaignSupervisor(ir, store, kernel, new GateExecutor(cwd), { pollMs: 1 }).run();
    assert.equal(state.status, "completed");
    assert.equal(checks, 2);
    assert.equal(kernel.assignments.length, 4);
    assert.ok(state.nodes["inspect[round-1]"] && state.nodes["inspect[round-2]"]);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("partial loop replay evaluates the completed round instance, not stale global output", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "campaign-loop-replay-"));
  try {
    const source = `import {defineCampaign,repeatUntil,task,ref} from "pi-campaign/dsl"; export default defineCampaign({meta:{name:"loop",version:1},limits:{maxAgents:3,maxConcurrency:1,maxRounds:3,maxTokens:100},program:repeatUntil({id:"loop",body:task({id:"check",agent:"scout",prompt:"check",output:{type:"object",required:["done"]}}),until:{op:"truthy",value:ref("check.output.done")},maxRounds:3,noProgress:true})});`;
    const { ir } = compileCampaign(source);
    const store = await EventStore.create(join(cwd, "run"), "run", "goal", cwd);
    await store.append("run.created", { ir });
    await store.append("run.started");
    await store.append("node.completed", { nodeId: "check[round-1]", output: { done: false }, outputKey: "check" });
    await store.append("loop.round-completed", { nodeId: "loop", round: 1, output: { done: false }, outputHash: "round-one", passed: false });
    await store.append("node.completed", { nodeId: "check[round-2]", output: { done: true }, outputKey: "check" });
    const reopened = await EventStore.open(join(cwd, "run"));
    const kernel = new FakeKernel(() => { throw new Error("completed round must be reused"); });
    const state = await new CampaignSupervisor(ir, reopened.store, kernel, new GateExecutor(cwd), { pollMs: 1 }).run();
    assert.equal(state.status, "completed");
    assert.deepEqual(state.nodes.loop?.output, { done: true });
    assert.equal(kernel.assignments.length, 0);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("manual retry invalidates completed ancestors and executes a skipped child", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "campaign-manual-retry-"));
  try {
    const source = `import {defineCampaign,sequence,task} from "pi-campaign/dsl"; export default defineCampaign({meta:{name:"retry",version:1},limits:{maxAgents:2,maxConcurrency:1,maxRounds:1,maxTokens:100},program:sequence([task({id:"a",agent:"scout",prompt:"a"}),task({id:"b",agent:"scout",prompt:"b"})])});`;
    const { ir } = compileCampaign(source);
    const store = await EventStore.create(join(cwd, "run"), "run", "goal", cwd);
    await store.append("run.created", { ir });
    await store.append("node.completed", { nodeId: "a", output: "a", outputKey: "a" });
    await store.append("node.skipped", { nodeId: "b", reason: "test" });
    await store.append("node.completed", { nodeId: ir.root, output: undefined });
    await store.append("run.completed");
    const kernel = new FakeKernel(() => "b");
    const supervisor = new CampaignSupervisor(ir, store, kernel, new GateExecutor(cwd), { pollMs: 1 });
    await supervisor.retry("b");
    const state = await supervisor.run();
    assert.equal(state.status, "completed");
    assert.deepEqual(kernel.assignments.map((assignment) => assignment.task), ["b"]);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("spawn uncertainty leaves a retryable interrupted node", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "campaign-spawn-uncertain-"));
  try {
    const source = `import {defineCampaign,task} from "pi-campaign/dsl"; export default defineCampaign({meta:{name:"spawn",version:1},limits:{maxAgents:2,maxConcurrency:1,maxRounds:1,maxTokens:100},program:task({id:"w",agent:"worker",prompt:"write",capabilities:["code-write"],recovery:"verify-before-retry"})});`;
    const { ir } = compileCampaign(source);
    const store = await EventStore.create(join(cwd, "run"), "run", "goal", cwd);
    await store.append("run.created", { ir });
    const kernel = new FakeKernel();
    kernel.spawn = async () => { throw new Error("RPC timeout after possible launch"); };
    const supervisor = new CampaignSupervisor(ir, store, kernel, new GateExecutor(cwd), { pollMs: 1, withWriterLock: async (work) => work() });
    const state = await supervisor.run();
    assert.equal(state.status, "failed");
    assert.equal(state.nodes.w?.status, "interrupted");
    await assert.doesNotReject(supervisor.retry("w"));
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("campaign timeout is enforced from the persisted run creation time", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "campaign-timeout-"));
  try {
    const source = `import {defineCampaign,task} from "pi-campaign/dsl"; export default defineCampaign({meta:{name:"timeout",version:1},limits:{maxAgents:1,maxConcurrency:1,maxRounds:1,maxTokens:100,timeoutMs:20},program:task({id:"slow",agent:"scout",prompt:"slow"})});`;
    const { ir } = compileCampaign(source);
    const store = await EventStore.create(join(cwd, "run"), "run", "goal", cwd);
    await store.append("run.created", { ir });
    await new Promise((resolve) => setTimeout(resolve, 25));
    const state = await new CampaignSupervisor(ir, store, new FakeKernel(), new GateExecutor(cwd), { pollMs: 1 }).run();
    assert.equal(state.status, "failed");
    assert.match(state.error ?? "", /Campaign timeout/);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("failed attempts contribute usage exactly once", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "campaign-failed-usage-"));
  try {
    const source = `import {defineCampaign,task} from "pi-campaign/dsl"; export default defineCampaign({meta:{name:"usage",version:1},limits:{maxAgents:3,maxConcurrency:1,maxRounds:1,maxTokens:100},program:task({id:"x",agent:"scout",prompt:"x"})});`;
    const { ir } = compileCampaign(source);
    const store = await EventStore.create(join(cwd, "run"), "run", "goal", cwd);
    await store.append("run.created", { ir });
    const state = await new CampaignSupervisor(ir, store, new FakeKernel(() => { throw new Error("fail"); }), new GateExecutor(cwd), { pollMs: 1 }).run();
    assert.equal(state.status, "failed");
    assert.equal(state.tokens, 30);
    assert.equal(state.usageRecorded.length, 3);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
