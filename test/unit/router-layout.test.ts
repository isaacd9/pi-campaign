import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { ModelRouter } from "../../src/model-router/index.ts";
import { ControlInput } from "../../src/tui/input.ts";
import { columns, fit } from "../../src/tui/layout.ts";
import { CampaignInspector } from "../../src/tui/inspector.ts";
import { initialState } from "../../src/supervisor/reducer.ts";
test("deterministic router picks smallest sufficient model and clamps thinking", async () => { const models = [{ provider: "p", id: "tiny-mini", reasoning: false, input: ["text"], contextWindow: 100_000, cost: { input: 1, output: 1 } }, { provider: "p", id: "solid-sonnet", reasoning: true, input: ["text", "image"], contextWindow: 200_000, cost: { input: 3, output: 10 } }]; const router = new ModelRouter(models); const scout = await router.route({ taskClass: "scout", prompt: "inspect", risk: "low" }); assert.equal(scout.model, "p/tiny-mini"); assert.equal(scout.thinking, "off"); const implementation = await router.route({ taskClass: "implementation", prompt: "code", risk: "medium" }); assert.equal(implementation.model, "p/solid-sonnet"); assert.equal(implementation.thinking, "medium"); assert.deepEqual(implementation, await router.route({ taskClass: "implementation", prompt: "code", risk: "medium" })); });
test("invalid LLM routing output falls back deterministically", async () => { const router = new ModelRouter([{ provider: "p", id: "mini", reasoning: false, input: ["text"], contextWindow: 10 }], async () => ({ model: "evil/missing", thinking: "ultra" })); const decision = await router.route({ taskClass: "router", prompt: "x" }); assert.equal(decision.source, "deterministic"); });
test("layout never exceeds terminal width", () => { for (const width of [1, 2, 10, 30, 71, 72, 120]) { const lines = columns(["a".repeat(200), "😀 wide"], ["\x1b[31mred content that is very long\x1b[0m"], width); assert.ok(lines.every((line) => visibleWidth(line) <= width)); assert.ok(visibleWidth(fit("x".repeat(100), width)) <= width); const input = new ControlInput(() => undefined); input.setText("long 😀 input ".repeat(20)); const rendered = input.render(width); assert.ok(rendered.every((line) => visibleWidth(line) <= width)); input.handleInput("\u001b"); assert.equal(input.text, ""); } });

test("campaign workspace renders a width-safe fleet and orchestrator chat", () => {
  const state = initialState("run", "Inspect architecture", "/tmp");
  state.status = "running";
  state.nodes.generator = { id: "generator", status: "running", attempts: 1, kernelRunId: "kernel-run" };
  const component = new CampaignInspector({
    service: { registerUiDisposer: () => () => undefined, getState: async () => state } as never,
    orchestrator: { transcript: [{ role: "assistant", text: "Campaign is running." }], isStreaming: false, subscribe: () => () => undefined } as never,
    runId: "run",
    initial: state,
    tui: { terminal: { rows: 36 }, requestRender: () => undefined } as never,
    theme: { fg: (_name: string, value: string) => value, bold: (value: string) => value } as never,
    confirm: async () => false,
    inputReason: async () => undefined,
    done: () => undefined,
  });
  for (const width of [44, 72, 120]) {
    const lines = component.render(width);
    assert.ok(lines.some((line) => line.includes("Orchestrator")));
    assert.ok(lines.length <= 36);
    assert.ok(lines.every((line) => visibleWidth(line) <= width));
  }
  component.dispose();
});
