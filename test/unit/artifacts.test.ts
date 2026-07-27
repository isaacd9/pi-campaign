import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readKernelStatus } from "../../src/adapters/kernel-artifacts.ts";
import { GateExecutor } from "../../src/gates/index.ts";
import { initialState } from "../../src/supervisor/reducer.ts";

test("native kernel artifact requires v1 and preserves trusted final output and usage", async () => {
  const root = await mkdtemp(join(tmpdir(), "campaign-artifact-"));
  try {
    const finalPath = join(root, "final.txt");
    await writeFile(finalPath, "final assignment result");
    await writeFile(join(root, "status.json"), JSON.stringify({ campaignLifecycleArtifactVersion: 1, state: "complete", tokens: 12, cost: 0.25, recentOutput: ["working"] }));
    const status = await readKernelStatus(root, finalPath);
    assert.equal(status.output, "final assignment result");
    assert.equal(status.tokens, 12);
    assert.equal(status.cost, 0.25);
    await writeFile(join(root, "status.json"), JSON.stringify({ campaignLifecycleArtifactVersion: 1, state: "complete", output: { ok: true } }));
    assert.deepEqual((await readKernelStatus(root)).output, { ok: true });
    await writeFile(join(root, "status.json"), JSON.stringify({ state: "complete" }));
    await assert.rejects(readKernelStatus(root), /expected 1/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("artifact gate rejects symlinks and checks configured size before content", async () => {
  const root = await mkdtemp(join(tmpdir(), "campaign-gate-artifact-"));
  try {
    await mkdir(join(root, "data"));
    await writeFile(join(root, "data", "large.txt"), "abcdef");
    await symlink(join(root, "data", "large.txt"), join(root, "link.txt"));
    const state = initialState("r", "g", root);
    const gate = new GateExecutor(root);
    assert.equal((await gate.execute({ type: "artifact", path: "link.txt" }, state, { outputs: {} })).outcome, "failed");
    const result = await gate.execute({ type: "artifact", path: "data/large.txt", maxBytes: 2, contentIncludes: "abc" }, state, { outputs: {} });
    assert.equal(result.outcome, "failed");
    assert.match(JSON.stringify(result.evidence), /size exceeds 2/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
