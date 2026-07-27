import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readSubagentStatus } from "../../src/adapters/subagents-artifacts-v2.ts";
import { GateExecutor } from "../../src/gates/index.ts";
import { initialState } from "../../src/supervisor/reducer.ts";

test("artifact adapter requires v2, reads costUsd, and contains outputFile", async () => {
  const root = await mkdtemp(join(tmpdir(), "campaign-artifact-"));
  try {
    await writeFile(join(root, "out.txt"), "full transcript with prompt examples");
    const finalPath = join(root, "final.txt");
    await writeFile(finalPath, "final child result");
    await writeFile(join(root, "status.json"), JSON.stringify({ lifecycleArtifactVersion: 2, state: "complete", outputFile: "out.txt", totalTokens: { total: 12 }, totalCost: { costUsd: 0.25 } }));
    const status = await readSubagentStatus(root, finalPath);
    assert.equal(status.output, "final child result");
    assert.equal(status.cost, 0.25);
    await writeFile(join(root, "status.json"), JSON.stringify({ lifecycleArtifactVersion: 2, state: "complete", outputFile: join(root, "out.txt") }));
    assert.equal((await readSubagentStatus(root)).output, "full transcript with prompt examples", "absolute output path must survive /var to /private/var canonicalization");
    await writeFile(join(root, "status.json"), JSON.stringify({ state: "complete" }));
    await assert.rejects(readSubagentStatus(root), /expected 2/);
    await writeFile(join(root, "status.json"), JSON.stringify({ lifecycleArtifactVersion: 2, state: "complete", outputFile: "../outside.txt" }));
    await assert.rejects(readSubagentStatus(root), /escapes async artifact directory/);
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
