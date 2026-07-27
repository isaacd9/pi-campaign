export const validCampaign = `
import { defineCampaign, sequence, task, map, gate, commandGate, checkpoint, emit, ref, template } from "pi-campaign/dsl";
export default defineCampaign({
  meta: { name: "fixture", description: "compiler fixture", version: 1 },
  limits: { maxAgents: 8, maxConcurrency: 2, maxRounds: 2, maxTokens: 100000 },
  program: sequence([
    task({ id: "discover", agent: "scout", prompt: "Find files", output: { type: "object" }, recovery: "safe-retry" }),
    map({ id: "map", items: ref("discover.output.files"), maxItems: 3, concurrency: 2, isolation: "worktree", body: task({ id: "write", agent: "worker", prompt: template("Edit {{item}}"), capabilities: ["code-write"], recovery: "verify-before-retry" }) }),
    gate({ id: "test", check: commandGate({ command: "true" }), overridable: true, onFail: { action: "stop" } }),
    checkpoint({ id: "done" }),
    emit({ id: "final", message: "Done", final: true })
  ])
});
`;
