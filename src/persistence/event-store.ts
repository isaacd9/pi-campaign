import { appendFile, mkdir, open, readFile, rename, truncate, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { CampaignEvent, CampaignState } from "./types.ts";
import { createId } from "../shared/ids.ts";
import { stableStringify } from "../shared/json.ts";
import { initialState, reduceEvent } from "../supervisor/reducer.ts";

export interface LoadResult { state: CampaignState; events: CampaignEvent[]; truncatedTail: boolean; diagnostics: string[] }
interface RunHeader { headerVersion: 1; runId: string; goal: string; cwd: string; createdAt: number }

export class EventStore {
  readonly eventsPath: string;
  readonly statePath: string;
  readonly headerPath: string;
  private stateValue: CampaignState;
  private seq = 0;
  private queue: Promise<unknown> = Promise.resolve();

  private constructor(public readonly runDir: string, state: CampaignState) {
    this.eventsPath = join(runDir, "events.jsonl");
    this.statePath = join(runDir, "state.json");
    this.headerPath = join(runDir, "run.json");
    this.stateValue = state;
  }

  static async create(runDir: string, runId: string, goal: string, cwd: string): Promise<EventStore> {
    await mkdir(runDir, { recursive: true, mode: 0o700 });
    const state = initialState(runId, goal, cwd);
    const store = new EventStore(runDir, state);
    const header: RunHeader = { headerVersion: 1, runId, goal, cwd, createdAt: state.createdAt };
    await writeAtomic(store.headerPath, header);
    await writeFile(store.eventsPath, "", { mode: 0o600, flag: "wx" });
    await syncFile(store.eventsPath);
    await writeAtomic(store.statePath, state);
    return store;
  }

  static async open(runDir: string): Promise<{ store: EventStore; load: LoadResult }> {
    let header: RunHeader;
    try {
      header = validateHeader(JSON.parse(await readFile(join(runDir, "run.json"), "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      // Migration path for 0.1 directories created before the immutable header.
      const snapshot = JSON.parse(await readFile(join(runDir, "state.json"), "utf8")) as CampaignState;
      header = { headerVersion: 1, runId: snapshot.runId, goal: snapshot.goal, cwd: snapshot.cwd, createdAt: snapshot.createdAt };
      await writeAtomic(join(runDir, "run.json"), header);
    }
    const load = await loadEvents(join(runDir, "events.jsonl"), initialState(header.runId, header.goal, header.cwd, header.createdAt));
    const store = new EventStore(runDir, load.state);
    store.seq = load.events.at(-1)?.seq ?? 0;
    // Snapshot is a cache only. Always repair it from header + authoritative log.
    await writeAtomic(store.statePath, load.state);
    return { store, load };
  }

  get state(): CampaignState { return structuredClone(this.stateValue); }

  append(type: string, data: unknown = {}, timestamp = Date.now()): Promise<CampaignEvent> {
    const execute = async (): Promise<CampaignEvent> => {
      const nextSeq = this.seq + 1;
      const event: CampaignEvent = {
        eventVersion: 1,
        seq: nextSeq,
        id: createId("evt"),
        runId: this.stateValue.runId,
        type,
        timestamp,
        data: JSON.parse(stableStringify(data)) as unknown,
      };
      await appendFile(this.eventsPath, `${JSON.stringify(event)}\n`, { mode: 0o600 });
      // This is the persist-before-side-effect boundary used by the supervisor.
      await syncFile(this.eventsPath);
      this.seq = nextSeq;
      this.stateValue = reduceEvent(this.stateValue, event);
      await writeAtomic(this.statePath, this.stateValue);
      return event;
    };
    const result = this.queue.then(execute, execute);
    this.queue = result.catch(() => undefined);
    return result;
  }

  async flush(): Promise<void> {
    await this.queue;
    await syncFile(this.eventsPath);
  }
}

export async function loadEvents(path: string, base: CampaignState): Promise<LoadResult> {
  let text: string;
  try { text = await readFile(path, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { state: base, events: [], truncatedTail: false, diagnostics: [] };
    throw error;
  }
  const lines = text.split("\n");
  const events: CampaignEvent[] = [];
  let state = base;
  let truncatedTail = false;
  const diagnostics: string[] = [];
  let validBytes = 0;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    if (!line.trim()) { validBytes += Buffer.byteLength(line) + (index < lines.length - 1 ? 1 : 0); continue; }
    try {
      const event = JSON.parse(line) as CampaignEvent;
      validateEvent(event, events.at(-1));
      state = reduceEvent(state, event);
      events.push(event);
      validBytes += Buffer.byteLength(line) + 1;
    } catch (error) {
      const isTail = index === lines.length - 1 || (index === lines.length - 2 && lines.at(-1) === "");
      if (!isTail) throw new Error(`Corrupt campaign event at line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
      truncatedTail = true;
      diagnostics.push(`Truncated corrupt final event at line ${index + 1}.`);
      await truncate(path, validBytes);
      await syncFile(path);
      break;
    }
  }
  return { state, events, truncatedTail, diagnostics };
}

function validateHeader(value: unknown): RunHeader {
  if (!value || typeof value !== "object") throw new Error("Invalid campaign run header");
  const header = value as Partial<RunHeader>;
  if (header.headerVersion !== 1 || typeof header.runId !== "string" || typeof header.goal !== "string" || typeof header.cwd !== "string" || !Number.isFinite(header.createdAt)) throw new Error("Invalid campaign run header");
  return header as RunHeader;
}

function validateEvent(event: CampaignEvent, previous?: CampaignEvent): void {
  if (event.eventVersion !== 1 || !Number.isInteger(event.seq) || typeof event.type !== "string") throw new Error("Invalid event envelope");
  if (previous && event.seq !== previous.seq + 1) throw new Error(`Expected event sequence ${previous.seq + 1}, got ${event.seq}`);
}

async function syncFile(path: string): Promise<void> {
  const handle = await open(path, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

export async function writeAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  const handle = await open(temp, "r+");
  try { await handle.sync(); } finally { await handle.close(); }
  await rename(temp, path);
  try {
    const directory = await open(dirname(path), "r");
    try { await directory.sync(); } finally { await directory.close(); }
  } catch { /* Directory fsync is not available on every platform. */ }
}
