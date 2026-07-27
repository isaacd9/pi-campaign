import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EventStore } from "../../src/persistence/event-store.ts";
import { replay, initialState } from "../../src/supervisor/reducer.ts";
import { RunLease } from "../../src/persistence/lease.ts";
test("append, snapshot, and replay are deterministic", async () => { const dir = await mkdtemp(join(tmpdir(), "campaign-store-")); try { const store = await EventStore.create(dir, "run", "goal", "/tmp"); const events = [await store.append("run.started"), await store.append("node.scheduled", { nodeId: "x", attempt: 1 }), await store.append("node.completed", { nodeId: "x", output: { b: 2, a: 1 } }), await store.append("run.completed")]; const replayed = replay(initialState("run", "goal", "/tmp", store.state.createdAt), events); assert.deepEqual(replayed, store.state); const reopened = await EventStore.open(dir); assert.deepEqual(reopened.store.state, store.state); } finally { await rm(dir, { recursive: true, force: true }); } });
test("truncates a corrupt final JSONL line but rejects middle corruption", async () => { const dir = await mkdtemp(join(tmpdir(), "campaign-corrupt-")); try { const store = await EventStore.create(dir, "run", "goal", "/tmp"); await store.append("run.started"); await writeFile(store.eventsPath, `${await readFile(store.eventsPath, "utf8")}{broken`, "utf8"); const opened = await EventStore.open(dir); assert.equal(opened.load.truncatedTail, true); await writeFile(store.eventsPath, `{broken\n${JSON.stringify({ eventVersion: 1, seq: 1, id: "e", runId: "run", type: "run.started", timestamp: 1, data: {} })}\n`); await assert.rejects(EventStore.open(dir), /Corrupt campaign event at line 1/); } finally { await rm(dir, { recursive: true, force: true }); } });

test("immutable header and event log recover missing or stale snapshots", async () => {
  const dir = await mkdtemp(join(tmpdir(), "campaign-authoritative-"));
  try {
    const store = await EventStore.create(dir, "run", "goal", "/project");
    await store.append("run.started");
    await store.append("node.completed", { nodeId: "x", output: 42 });
    await writeFile(store.statePath, JSON.stringify({ ...store.state, status: "failed", outputs: {} }));
    let reopened = await EventStore.open(dir);
    assert.equal(reopened.store.state.status, "running");
    assert.equal(reopened.store.state.outputs.x, 42);
    await unlink(store.statePath);
    reopened = await EventStore.open(dir);
    assert.equal(reopened.store.state.goal, "goal");
    assert.equal(reopened.store.state.outputs.x, 42);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("run lease acquisition is mutually exclusive", async () => {
  const dir = await mkdtemp(join(tmpdir(), "campaign-lease-"));
  try {
    const results = await Promise.allSettled([RunLease.acquire(dir, "one"), RunLease.acquire(dir, "two")]);
    const acquired = results.filter((result): result is PromiseFulfilledResult<RunLease> => result.status === "fulfilled");
    assert.equal(acquired.length, 1);
    assert.equal(results.filter((result) => result.status === "rejected").length, 1);
    await acquired[0]!.value.release();
    const next = await RunLease.acquire(dir, "three");
    await next.release();
  } finally { await rm(dir, { recursive: true, force: true }); }
});
