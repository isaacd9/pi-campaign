# pi-campaign

Campaign is a Pi package for compiling restricted TypeScript workflow programs into a versioned IR and running them as durable, deterministic stages through `pi-subagents`.

> **Release status:** 0.1 is a usable v1-RPC release. It implements the safe compiler, persistence/replay, gates, automatic routing, generation pipeline, saved programs, controls, and inspector. Native child `resume`, `steer`, and `append-step` remain unavailable in `pi-subagents` RPC v1; Campaign deliberately uses campaign-level restart/retry and does not import private executor modules.

## Install

```bash
pi install npm:pi-campaign
# or while developing
pi -e ./extensions/campaign/index.ts
```

Campaign expects `pi-subagents` to be loaded separately. Pi supplies the core peer packages and `typebox`; runtime-only libraries (`typescript` for AST parsing and `ajv` for schemas) are normal dependencies.

Run `/campaign-doctor` after installation. It checks:

- `typebox/compile` resolution with remediation;
- `pi-subagents` RPC v1 availability and methods;
- authenticated model count;
- private run-storage creation and cleanup; and
- the v1 control limitation.

## Commands

- `/campaign <goal>` — route a generator model, ask a bounded read-only `scout` for restricted source, compile/repair it (maximum two repairs), and execute it in the background. Launch stays in the parent editor; use `/campaign-inspect` explicitly when you want the workspace.
- `/campaign-inspect [run-id]` — select a run using status, English summary, and timestamp, then open the full-screen Campaign workspace with live status, timestamps, nodes, transcript tails, controls, and orchestrator chat. It uses Pi's stable overlay compositor for tmux-safe live updates.
- `/campaign-list` — active and recent runs for this Pi session.
- `/campaign-run <name> [json-input]` — validate typed JSON input and run a saved campaign (project definition overrides personal).
- `/campaign-save <run-id> [name] [--project]` — save immutable run source.
- `/campaign-stop <run-id>` — stop an active run.
- `/campaign-doctor` — dependency/RPC/storage/model diagnosis.
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
```

`run.json` stores immutable run identity, `events.jsonl` is authoritative and append-only, and `state.json` is only an atomic materialized cache. Replay uses a pure reducer. A corrupt final partial JSONL line is diagnosed and truncated; middle corruption stops recovery. Side effects are preceded by `node.scheduled`; in-flight nodes become `interrupted` after restart and follow their declared recovery policy. Completed task instances and fan-out items remain cached.

Saved definitions live in `~/.pi/agent/campaigns/*.campaign.ts` and trusted-project `.pi/campaigns/*.campaign.ts`. Project definitions are not discovered for untrusted projects.

## Inspector

Launching a campaign leaves the parent editor undisturbed and reports compact progress only in Pi's footer status line. If the configured launch policy requires approval, the compiled campaign pauses durably instead of opening a late modal; open `/campaign-inspect` and press `p` to approve and launch it. `/campaign-inspect` explicitly opens the dedicated Campaign workspace built from the proven `pi-subagents` fleet layout and overlay-compositor patterns. Closing it never stops the background supervisor. Campaign milestones remain in durable campaign state instead of being injected into parent-chat context. The campaign—not the parent Pi chat—is the first-class object:

- an explicit campaign status, deterministic English progress summary, started/updated timestamps, and live node roster with stable selection and status glyphs;
- selected-agent metadata plus bounded, auto-following lifecycle transcript/output tails;
- pause/resume (`p`), stop the selected agent (`x`), stop the whole campaign (`X`), retry (`r`), and skip or gate override (`s`);
- a persistent per-run Pi SDK session for orchestrator chat, stored under the campaign run directory;
- read-only `campaign_status` and explicit `campaign_control` tools for the orchestrator; it cannot edit files or run shell commands;
- `Tab` switches between campaign navigation and chat, with independent transcript scrolling and IME-compatible input;
- deterministic local chat commands `/pause`, `/resume`, `/stop-agent`, `/retry`, and `/stop`.

Outside TUI mode, inspection returns formatted JSON status.

## Automatic routing

Only `ctx.modelRegistry.getAvailable()` models (authenticated models) enter the catalog. A deterministic capability/cost profile picks the smallest model that meets the task class, clamps thinking to advertised support, records fallbacks and escalation triggers, and caches decisions by hashed requirements/catalog. Unknown model names receive a low-confidence heuristic rank. The router accepts an optional schema-validated LLM decision callback; malformed or unavailable decisions always fall back deterministically.

## Security boundaries

- Campaign source is data, never code.
- Provider credentials are resolved by Pi and never persisted by Campaign.
- Every campaign gate is user-overridable and the prior evidence, reason, id, and timestamp are logged.
- Campaign cannot override Pi project trust, provider authentication, OS permissions, or configured hard caps.
- A generated command gate is still a shell side effect. Use smart/always launch approval policy and inspect generated source for risky campaigns. The 0.1 service records launch policy configuration, while generation remains explicitly initiated by a human command.

## Known v1 limitations

- RPC v1 solo spawn does not carry native phase/label/thinking/output-schema fields. Campaign preserves these in its own IR/event state, passes supported model/acceptance fields, and validates outputs itself.
- RPC v1 in `pi-subagents` 0.35.1 has no native child resume, steer, append-step, or per-spawn completion-notification suppression. Campaign never injects its own milestones or lifecycle messages into parent chat, but this dependency may still independently emit `Background task completed/failed` messages for Campaign-owned children until its public RPC adds a silent-spawn option. The inspector exposes campaign-level pause/retry/relaunch controls and deterministic local control commands.
- Worktree creation is delegated to `pi-subagents`; v1 solo spawn cannot request its private single-run worktree controls. The compiler rejects unsafe parallel writers. At runtime, a declared isolated writer fan-out fails unless the user explicitly approves a serialized active-worktree downgrade. Mutation-capable assignments and repair agents also take a cross-process canonical-cwd writer lock. Kernel-native grouped isolation remains reserved for a future public adapter.
- Orchestrator chat is a dedicated Pi SDK session with campaign status/control tools. It can reason about and control campaign-level state, but RPC v1 still cannot steer a running child turn or append native executor steps.
- The `smart` launch policy confirms campaigns with command/safety gates, multiple writers, more than 25 declared agents, or more than 1.5M declared tokens. It is a compact confirmation rather than a dedicated graph preview; source and IR paths are shown for inspection.

## Development

```bash
npm install
npm run typecheck
npm test
```

Tests cover malicious compiler inputs, deterministic IR/hash, bounds and writer policy, reducer replay, tail/middle corruption, gates and override audit, model routing fallback/clamping, width invariants, public RPC envelopes, fake-kernel fan-out, and completed-node resume caching.
