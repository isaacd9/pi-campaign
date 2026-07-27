import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { withCwdWriterLock } from "../../src/supervisor/writer-lock.ts";

test("canonical cwd writer lock serializes concurrent mutations", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "campaign-writer-mutex-"));
  const previous = process.env.PI_AGENT_DIR;
  process.env.PI_AGENT_DIR = join(cwd, "agent");
  let active = 0, maximum = 0;
  try {
    await Promise.all(Array.from({ length: 3 }, () => withCwdWriterLock(cwd, async () => {
      active++;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active--;
    }, { pollMs: 5 })));
    assert.equal(maximum, 1);
  } finally {
    if (previous === undefined) delete process.env.PI_AGENT_DIR; else process.env.PI_AGENT_DIR = previous;
    await rm(cwd, { recursive: true, force: true });
  }
});
