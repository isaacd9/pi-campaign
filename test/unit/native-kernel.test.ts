import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PiSdkKernel } from "../../src/adapters/pi-sdk-kernel.ts";

test("native kernel treats orphaned non-terminal SDK artifacts as interrupted", async () => {
  const dir = await mkdtemp(join(tmpdir(), "campaign-native-orphan-"));
  try {
    await writeFile(join(dir, "status.json"), JSON.stringify({ campaignLifecycleArtifactVersion: 1, runId: "old", state: "running", tokens: 7, cost: 0.1 }));
    const kernel = new PiSdkKernel();
    const status = await kernel.status({ id: "old", asyncDir: dir });
    assert.equal(status.state, "failed");
    assert.match(status.error ?? "", /interrupted with its owning Pi process/);
    assert.equal(status.tokens, 7);
    kernel.dispose();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("native kernel reuses terminal artifacts after process replacement", async () => {
  const dir = await mkdtemp(join(tmpdir(), "campaign-native-terminal-"));
  try {
    await writeFile(join(dir, "status.json"), JSON.stringify({ campaignLifecycleArtifactVersion: 1, runId: "done", state: "complete", output: { ok: true }, tokens: 9 }));
    const kernel = new PiSdkKernel();
    const status = await kernel.status({ id: "done", asyncDir: dir });
    assert.equal(status.state, "complete");
    assert.deepEqual(status.output, { ok: true });
    assert.equal(status.tokens, 9);
    kernel.dispose();
  } finally { await rm(dir, { recursive: true, force: true }); }
});
