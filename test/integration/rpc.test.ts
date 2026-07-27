import assert from "node:assert/strict";
import test from "node:test";
import { SubagentsRpcV1Kernel } from "../../src/adapters/subagents-rpc-v1.ts";
class Bus {
  handlers = new Map<string, Set<(data: unknown) => void>>();
  on(event: string, handler: (data: unknown) => void) { const set = this.handlers.get(event) ?? new Set<(data: unknown) => void>(); set.add(handler); this.handlers.set(event, set); return () => set.delete(handler); }
  emit(event: string, data: unknown) {
    if (event === "subagents:rpc:v1:request") {
      const request = data as { requestId: string; method: string; params: Record<string, unknown> };
      const replyData = request.method === "ping"
        ? { version: 1, methods: ["ping", "spawn"] }
        : { text: "started", details: { asyncId: "abc", asyncDir: "/missing" } };
      queueMicrotask(() => this.emit(`subagents:rpc:v1:reply:${request.requestId}`, { version: 1, requestId: request.requestId, success: true, data: replyData }));
      return;
    }
    for (const handler of this.handlers.get(event) ?? []) handler(data);
  }
}
test("RPC v1 adapter pings and spawns through public event bus", async () => { const bus = new Bus(); const kernel = new SubagentsRpcV1Kernel(bus); assert.equal((await kernel.ping()).version, 1); const run = await kernel.spawn({ agent: "scout", task: "read", cwd: "/tmp", phase: "ignored by v1", thinking: "low" }); assert.equal(run.id, "abc"); assert.equal(run.asyncDir, "/missing"); assert.match(run.outputPath ?? "", /campaign-runs\/.*\.output\.txt$/); kernel.dispose(); });
