# pi-campaign

Campaign is a Pi package for compiling restricted TypeScript workflow programs into a versioned IR and running them as durable, deterministic stages through Campaign-owned Pi SDK sessions.

> **Release status:** 0.1 implements the safe compiler, native assignment runtime, persistence/replay, gates, automatic routing, generation pipeline, saved programs, controls, and inspector. Campaign owns scheduling and isolated agent sessions directly; it does not require `pi-subagents`.

## Install

```bash
pi install npm:pi-campaign
# or while developing
pi -e ./extensions/campaign/index.ts
```

Pi supplies the SDK/model/tool peer packages and `typebox`; runtime-only libraries (`typescript` for AST parsing and `ajv` for schemas) are normal dependencies.

Run `/campaign-doctor` after installation. It checks:

- `typebox/compile` resolution with remediation;
- the Campaign Pi SDK kernel and authenticated models;
- private run-storage creation and cleanup; and
- persisted interruption/recovery behavior.

## Commands

- `/campaign <goal>` — route a generator model, ask a bounded read-only `scout` for restricted source, compile/repair it (maximum two repairs), and execute it in the background. Launch stays in the parent editor; use `/campaign-inspect` explicitly when you want the workspace.
- `/campaign-inspect [run-id]` — select a run using status, English summary, and timestamp, then open the full-screen Campaign workspace with live status, timestamps, nodes, transcript tails, controls, and orchestrator chat. It uses Pi's stable overlay compositor for tmux-safe live updates.
- `/campaign-list` — active and recent runs for this Pi session.
- `/campaign-run <name> [json-input]` — validate typed JSON input and run a saved campaign (project definition overrides personal).
- `/campaign-save <run-id> [name] [--project]` — save immutable run source.
- `/campaign-stop <run-id>` — stop an active run.
- `/campaign-doctor` — dependency/native-kernel/storage/model diagnosis.
- `/campaign-config [json]` — show (loads JSON into the editor in TUI) or merge configuration.

When enabled (default), human interactive input beginning with `ultracode:` is equivalent to `/campaign`. RPC, extension-injected, queued, and streaming input is ignored to prevent recursion.

## Restricted TypeScript

Campaign source is parsed with the TypeScript AST and **never imported, evaluated, passed to `vm`, or executed as a subprocess**. Only named imports from `pi-campaign/dsl`, object/array/primitive literals, and allowlisted combinator calls are accepted.

```ts
import {
  defineCampaign, sequence, task, map, ref, template,
  gate, commandGate, checkpoint, emit,
} from "pi-campaign/dsl";

export default defineCampaign({
  meta: { name: "migrate", version: 1 },
  limits: {
    maxAgents: 25,
    maxConcurrency: 4,
    maxRounds: 3,
    maxTokens: 1_000_000,
  },
  program: sequence([
    task({
      id: "discover",
      agent: "scout",
      prompt: "Return JSON with a files array.",
      output: { type: "object", required: ["files"] },
      recovery: "safe-retry",
    }),
    map({
      id: "migrate",
      items: ref("discover.output.files"),
      maxItems: 20,
      concurrency: 4,
      isolation: "worktree",
      body: task({
        id: "migrate-file",
        agent: "worker",
        prompt: template("Migrate {{item}} and test it."),
        capabilities: ["code-write", "tests"],
        recovery: "verify-before-retry",
      }),
    }),
    gate({
      id: "tests",
      check: commandGate({ command: "npm test", timeoutMs: 120000 }),
      overridable: true,
      onFail: { action: "repair", maxAttempts: 2 },
    }),
    checkpoint({ id: "verified" }),
    emit({ id: "done", message: "Migration verified", final: true }),
  ]),
});
```

Supported composition: `sequence`, static `parallel`, bounded `map`, `branch`, bounded `repeatUntil`, `task`, `gate`, `checkpoint`, `aggregate`, and `emit`. Supported checks: command, schema, artifact, restricted predicate, approval, independent review, acceptance, safety, and budget.

Compilation rejects arbitrary imports/calls, variables, functions, mutation, recursion, spreads, dynamic properties, missing references, duplicate ids, invalid bounds, campaigns above configured hard caps, and concurrent active-worktree writers without worktree isolation. The exact normalized source and canonical IR have SHA-256 hashes.

## Persistence and recovery

Run data is private local state:

```text
~/.pi/agent/campaign-runs/<pi-session-id>/<run-id>/
  source.campaign.ts
  campaign.ir.json
  state.json
  events.jsonl
  lease.lock/owner.json      # atomic lease directory, only while owned
  router/generation.json
  assignments/<node>.txt
  assignments/.runtime-<id>/
    status.json
    session/*.jsonl
```

`run.json` stores immutable run identity, `events.jsonl` is authoritative and append-only, and `state.json` is only an atomic materialized cache. Replay uses a pure reducer. A corrupt final partial JSONL line is diagnosed and truncated; middle corruption stops recovery. Side effects are preceded by `node.scheduled`; in-flight nodes become `interrupted` after restart and follow their declared recovery policy. Completed task instances and fan-out items remain cached.

Saved definitions live in `~/.pi/agent/campaigns/*.campaign.ts` and trusted-project `.pi/campaigns/*.campaign.ts`. Project definitions are not discovered for untrusted projects.

## Inspector

Launching a campaign leaves the parent editor undisturbed and reports compact progress only in Pi's footer status line. If the configured launch policy requires approval, the compiled campaign pauses durably instead of opening a late modal; open `/campaign-inspect` and press `p` to approve and launch it. `/campaign-inspect` explicitly opens the dedicated Campaign workspace using a fleet-inspired phase tree and Pi's overlay compositor. Closing it never stops the background supervisor. Campaign milestones remain in durable campaign state instead of being injected into parent-chat context. The campaign—not the parent Pi chat—is the first-class object:

- an explicit campaign status, deterministic English progress summary, and started/updated timestamps;
- a phase-labeled execution tree derived from persisted IR edges, with structural nodes, parallel branches, and dynamic instances;
- selected-agent metadata including the phase, label, full prompt, state, agent, model/thinking, recovery policy, capabilities, timestamps, current tool/path, usage, async identity, errors, and bounded transcript/output tails;
- pause/resume (`p`), stop the selected agent (`x`), stop the whole campaign (`X`), retry (`r`), and skip or gate override (`s`);
- a persistent per-run Pi SDK session for orchestrator chat, stored under the campaign run directory;
- read-only `campaign_status` and explicit `campaign_control` tools for the orchestrator; it cannot edit files or run shell commands;
- `Tab` switches between campaign navigation and chat, with independent transcript scrolling and IME-compatible input;
- deterministic local chat commands `/pause`, `/resume`, `/stop-agent`, `/retry`, and `/stop`.

Outside TUI mode, inspection returns formatted JSON status. The generator is explicitly prompted to produce labeled hierarchical phases, fan out independent work with parallel/map/branch nodes, and converge into synthesis or review instead of defaulting to a flat chain.

## Automatic routing

Only `ctx.modelRegistry.getAvailable()` models (authenticated models) enter the catalog. A deterministic capability/cost profile picks the smallest model that meets the task class, clamps thinking to advertised support, records fallbacks and escalation triggers, and caches decisions by hashed requirements/catalog. Unknown model names receive a low-confidence heuristic rank. The router accepts an optional schema-validated LLM decision callback; malformed or unavailable decisions always fall back deterministically.

## Security boundaries

- Campaign source is data, never code.
- Provider credentials are resolved by Pi and never persisted by Campaign.
- Every campaign gate is user-overridable and the prior evidence, reason, id, and timestamp are logged.
- Campaign cannot override Pi project trust, provider authentication, OS permissions, or configured hard caps.
- A generated command gate is still a shell side effect. Use smart/always launch approval policy and inspect generated source for risky campaigns. The 0.1 service records launch policy configuration, while generation remains explicitly initiated by a human command.

## Known v1 limitations

- Assignment sessions run inside the owning Pi process. Pi shutdown aborts them; authoritative campaign replay marks uncertain work interrupted and applies the node's recovery policy after restart.
- The native kernel does not yet create git worktrees. The compiler rejects unsafe parallel writers, and declared isolated writer fan-out requires explicit approval to serialize in the active worktree. Mutation-capable assignments and repair agents also take a cross-process canonical-cwd writer lock.
- Campaign pause stops scheduling new nodes but cannot freeze a provider request already in flight. Stop-agent aborts the selected SDK session; retry starts a new persisted assignment session.
- Orchestrator chat is a separate restricted Pi SDK session with campaign status/control tools. It cannot edit repository files or run shell commands.
- The `smart` launch policy durably pauses risky or unusually large compiled campaigns. Open the inspector to review the phase tree and press `p` to approve execution.

## Development

```bash
npm install
npm run typecheck
npm test
```

Tests cover malicious compiler inputs, deterministic IR/hash, bounds and writer policy, reducer replay, tail/middle corruption, gates and override audit, model routing fallback/clamping, native lifecycle artifacts, width invariants, fake-kernel fan-out, and completed-node resume caching.
