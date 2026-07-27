import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SubagentsRpcV1Kernel } from "../../src/adapters/subagents-rpc-v1.ts";
class Bus {
  handlers = new Map<string, Set<(data: unknown) => void>>();
  asyncDir = "/missing";
  statusCalls = 0;
  stopCalls = 0;
  stopMissingReplies = 0;
  on(event: string, handler: (data: unknown) => void) { const set = this.handlers.get(event) ?? new Set<(data: unknown) => void>(); set.add(handler); this.handlers.set(event, set); return () => set.delete(handler); }
  emit(event: string, data: unknown) {
    if (event === "subagents:rpc:v1:request") {
      const request = data as { requestId: string; method: string; params: Record<string, unknown> };
      if (request.method === "status") this.statusCalls++;
      if (request.method === "stop") {
        this.stopCalls++;
        if (this.stopCalls <= this.stopMissingReplies) {
          queueMicrotask(() => this.emit(`subagents:rpc:v1:reply:${request.requestId}`, { version: 1, requestId: request.requestId, success: false, error: { code: "not_found", message: "Status file not found." } }));
          return;
        }
      }
      const replyData = request.method === "ping"
        ? { version: 1, methods: ["ping", "spawn"] }
        : request.method === "spawn"
          ? { text: "started", details: { asyncId: "abc", asyncDir: this.asyncDir } }
          : { text: "State: running" };
      queueMicrotask(() => this.emit(`subagents:rpc:v1:reply:${request.requestId}`, { version: 1, requestId: request.requestId, success: true, data: replyData }));
      return;
    }
    for (const handler of this.handlers.get(event) ?? []) handler(data);
  }
}
test("RPC v1 adapter pings and spawns through public event bus", async () => { const bus = new Bus(); const kernel = new SubagentsRpcV1Kernel(bus); assert.equal((await kernel.ping()).version, 1); const run = await kernel.spawn({ agent: "scout", task: "read", cwd: "/tmp", phase: "ignored by v1", thinking: "low" }); assert.equal(run.id, "abc"); assert.equal(run.asyncDir, "/missing"); assert.match(run.outputPath ?? "", /campaign-runs\/.*\.output\.txt$/); kernel.dispose(); });

test("RPC v1 adapter treats a newly spawned run without status.json as queued", async () => {
  const dir = await mkdtemp(join(tmpdir(), "campaign-rpc-startup-"));
  try {
    const bus = new Bus();
    bus.asyncDir = dir;
    const kernel = new SubagentsRpcV1Kernel(bus);
    const run = await kernel.spawn({ agent: "scout", task: "read", cwd: "/tmp" });
    assert.deepEqual(await kernel.status(run), { state: "queued" });
    assert.equal(bus.statusCalls, 0, "must not query RPC during the status publication race");
    kernel.dispose();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("RPC v1 adapter retries stop through the status publication race", async () => {
  const bus = new Bus();
  bus.stopMissingReplies = 1;
  const kernel = new SubagentsRpcV1Kernel(bus, 1_000, 1_000);
  const run = await kernel.spawn({ agent: "scout", task: "read", cwd: "/tmp" });
  await kernel.stop(run);
  assert.equal(bus.stopCalls, 2);
  kernel.dispose();
});
