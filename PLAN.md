# Pi Campaign Plugin — Architecture and Delivery Plan

## 1. Product intent

Build a Pi package that gives Pi an Ultracode-style execution mode, but with stronger determinism, resumability, model routing, gates, and inspection.

A user should be able to run:

```text
/campaign migrate the API from callbacks to async/await and verify every route
```

or optionally:

```text
ultracode: migrate the API from callbacks to async/await and verify every route
```

The plugin will:

1. inspect the goal and available authenticated models;
2. ask the smallest suitable routing model to choose a model and thinking level for campaign generation;
3. generate a restricted TypeScript campaign program;
4. compile and validate that program before execution;
5. execute it in deterministic, persisted stages through Campaign-owned Pi SDK sessions;
6. enforce first-class gates declared by the program;
7. choose a model and thinking level separately for every agent task;
8. survive Pi restarts and resume from durable checkpoints; and
9. expose a full-screen `/campaign-inspect` TUI with live status, prompts, output, gates, costs, and controls.

The campaign program—not the parent model's context—holds the plan, loops, branches, intermediate results, and stop conditions. The parent conversation receives only compact footer status; milestones, assignment completions, transcripts, and final output remain in durable campaign state and the inspector.

## 2. Confirmed product decisions

- **Product name:** Campaign (`pi-campaign`).
- **Terminology:** this product uses **campaign**, **milestone**, and **assignment**. A first-class gate is shown to users as a **checkpoint**. “Dynamic workflows” appears only when naming the Claude Code reference feature.
- **Reference experience:** Claude Code Ultracode and dynamic workflows: <https://code.claude.com/docs/en/workflows>
- **Campaign language:** TypeScript.
- **Execution kernel:** Campaign owns assignment execution directly through public Pi SDK sessions. Campaign owns scheduling, fan-out, controls, lifecycle artifacts, usage projection, cancellation, and recovery; it does not depend on `pi-subagents`.
- **Gates:** explicit, first-class program nodes. Automated and human gates are selected according to the campaign. Every campaign-level gate, including safety gates, can be overridden by the user.
- **Model routing:** automatic. Normal use must not require the user to choose models or thinking levels.
- **Routing prompt privacy:** the routing model may receive the full task and necessary context.
- **Primary UI:** full-screen modal opened with `/campaign-inspect`.
- **Interactive control:** pause, resume, stop, retry, skip, edit pending prompts, override models, and prompt a campaign control model.
- **Persistence:** runs survive Pi restarts and support deterministic replay/resume.
- **Delivery shape:** complete architecture implemented as independently shippable milestones.

## 3. Lessons to preserve—and improve—from Ultracode

The Claude Code dynamic-workflow reference establishes several useful principles:

- campaign coordination is encoded rather than turn-by-turn model judgment;
- intermediate results live in program variables/artifacts rather than the master context;
- runs happen in the background while the main session remains responsive;
- phases and agents are inspectable, including prompts, recent tools, results, tokens, and elapsed time;
- completed fan-out items are cached for resume;
- campaigns can be saved and rerun as commands;
- loops need explicit bounds and no-progress stop conditions; and
- large runs need concurrency, agent-count, and token limits.

This plugin should improve on that experience by adding:

- restart-safe persistence across Pi sessions, not only same-session resume;
- typed TypeScript programs compiled to a versioned intermediate representation;
- first-class automated, review, approval, artifact, and safety gates;
- per-node automatic model and thinking selection;
- escalation and fallback after model failure;
- editable pending prompts and model overrides;
- an interactive campaign-control chat inside the inspector;
- auditable gate overrides;
- explicit writer/worktree safety; and
- deterministic recovery policies for interrupted mutation steps.

## 4. Core safety and determinism decision

### 4.1 Do not execute arbitrary generated TypeScript

Pi extensions have the user's full system permissions. Running arbitrary model-generated TypeScript with `eval`, `jiti`, `tsx`, `vm`, or a normal Node subprocess would let generated campaign code access the filesystem, network, environment variables, and credentials directly. Node's `vm` is not a security boundary.

The default language will therefore be a **restricted, typed TypeScript combinator program**. It looks and type-checks like TypeScript, but the plugin parses its AST and compiles only an allowlisted syntax into campaign IR. The source itself is never imported or executed.

A later, explicitly trusted `unsafeTrustedTypeScript` mode may execute arbitrary hand-authored programs, but it is not part of the default or initial milestones.

### 4.2 Example campaign source

```ts
import {
  defineCampaign,
  sequence,
  task,
  map,
  gate,
  commandGate,
  reviewGate,
  ref,
  template,
} from "pi-campaign/dsl";

export default defineCampaign({
  meta: {
    name: "migrate-routes",
    description: "Migrate routes and verify the result",
    version: 1,
  },
  limits: {
    maxAgents: 30,
    maxConcurrency: 4,
    maxRounds: 3,
    maxTokens: 1_000_000,
  },
  program: sequence([
    task({
      id: "discover",
      agent: "scout",
      prompt: "Return every route that needs migration.",
      output: {
        type: "object",
        required: ["files"],
        properties: {
          files: { type: "array", items: { type: "string" } },
        },
      },
    }),
    map({
      id: "migrate",
      items: ref("discover.output.files"),
      maxItems: 100,
      concurrency: 4,
      isolation: "worktree",
      body: task({
        id: "migrate-file",
        agent: "worker",
        prompt: template("Migrate {{item}} and run its focused tests."),
        capabilities: ["code-write", "tests"],
        recovery: "verify-before-retry",
      }),
    }),
    gate({
      id: "tests",
      check: commandGate({ command: "npm test" }),
      overridable: true,
      onFail: { action: "repair", maxAttempts: 2 },
    }),
    gate({
      id: "review",
      check: reviewGate({
        agent: "reviewer",
        focus: "correctness, regressions, and missed routes",
      }),
      overridable: true,
      onFail: { action: "repair", maxAttempts: 1 },
    }),
  ]),
});
```

### 4.3 Allowed language constructs

The compiler initially accepts only:

- one `defineCampaign({...})` export;
- literals, arrays, and object literals;
- imported DSL combinators;
- `sequence`, `parallel`, `map`, `branch`, and bounded `repeatUntil` composition;
- typed references to prior structured outputs;
- templates whose substitutions come from declared inputs or prior outputs; and
- declarative limits, retry policies, recovery policies, and gates.

It rejects arbitrary imports, property mutation, filesystem/network APIs, dynamic code loading, unbounded loops, recursion, and calls outside the DSL allowlist.

## 5. Campaign intermediate representation

Compile source into a versioned JSON IR before any work starts.

```ts
interface CampaignIR {
  irVersion: 1;
  sourceHash: string;
  meta: CampaignMeta;
  inputSchema?: JsonSchema;
  limits: CampaignLimits;
  nodes: CampaignNode[];
  edges: CampaignEdge[];
  outputs: Record<string, OutputDeclaration>;
}
```

### 5.1 Node types

- `agent-task`: one Campaign-native Pi SDK assignment session.
- `sequence`: deterministic ordered children.
- `parallel`: statically known concurrent children.
- `map`: bounded dynamic fan-out over a schema-validated prior output.
- `branch`: routes on a restricted predicate over structured state.
- `loop`: bounded loop with max rounds, timeout, and optional no-progress hash.
- `gate`: first-class pass/fail/override/error transition.
- `checkpoint`: durable named state boundary.
- `aggregate`: combines child outputs through an agent or deterministic reducer.
- `emit`: publishes a concise milestone or final result to the Pi conversation.

### 5.2 Compile-time validation

Compilation must reject:

- duplicate IDs;
- missing references;
- cycles outside declared bounded loops;
- unbounded `map` or `loop` nodes;
- incompatible output/reference schemas;
- parallel writers without worktree isolation;
- gates without explicit failure behavior;
- retry policies without hard bounds;
- model IDs that are hardcoded but unavailable and lack an automatic fallback policy; and
- campaigns whose declared maximum agents/concurrency/tokens exceed configured hard caps.

The compiler emits a human-readable phase summary and a machine-readable execution graph. Both are persisted and shown before launch when approval policy requires it.

## 6. First-class gates

A gate is a state-machine node, not prose in an agent prompt.

```ts
interface GateNode {
  id: string;
  kind: "gate";
  check: GateCheck;
  overridable: boolean;
  timeoutMs?: number;
  onPass: Transition;
  onFail: Transition;
  onError: Transition;
}
```

### 6.1 Gate checks

- `command`: run an explicit command with cwd, timeout, and expected exit/output rules.
- `schema`: validate a prior output or artifact.
- `artifact`: assert file existence, hash, diff limits, or content rules.
- `review`: run an independent reviewer and require a structured verdict.
- `acceptance`: validate a prior Campaign assignment and its persisted evidence.
- `approval`: ask the user to approve a stage or decision.
- `safety`: identify a risky operation or capability transition.
- `budget`: enforce token, cost, time, agent, or retry limits.
- `predicate`: evaluate an allowlisted expression over structured campaign state.

### 6.2 Gate outcomes

Every gate records one of:

- `passed`;
- `failed`;
- `errored`;
- `overridden`;
- `skipped`; or
- `timed-out`.

An override requires an explicit user action in the inspector and is recorded with timestamp, gate ID, prior evidence, and an optional reason. No campaign-level gate is technically unoverridable, per the product decision.

The plugin cannot and should not override restrictions owned outside the campaign, such as Pi project trust, provider authentication, operating-system permissions, or a separate Pi permission extension.

## 7. Campaign supervisor

### 7.1 State-machine loop

The Campaign supervisor owns milestone-level transitions; an LLM does not decide the next transition during normal execution. Campaign schedules every sequence, static parallel group, bounded dynamic fan-out, branch, and loop itself, while the native kernel executes one assignment per Pi SDK session.

For each runnable Campaign node it:

1. resolves input references and templates;
2. routes the assignment to a model/thinking level;
3. identifies bounded independent work that Campaign may schedule concurrently;
4. persists `node.scheduled` before side effects;
5. submits the native run to the kernel;
6. records kernel lifecycle and artifact references in the Campaign event log;
7. validates and stores outputs;
8. executes the node's checkpoint/transition policy;
9. persists the resulting state; and
10. advances only nodes made runnable by that persisted transition.

The kernel remains deliberately small: one assignment session, lifecycle projection, budgets, and cancellation. Campaign owns every workflow-level decision.

### 7.2 Single-writer policy

- Read-only scouts, planners, reviewers, and validators may run in parallel.
- Only one writer may touch the active worktree at a time.
- Concurrent writers require isolated git worktrees.
- Worktree results merge through a serialized merge node followed by validation gates.
- The compiler and Campaign supervisor enforce writer rules; until native worktree support lands, isolated writer fan-out requires explicit serialized-downgrade approval.

### 7.3 Idempotency and crash recovery

Each side-effecting node declares a recovery policy:

- `safe-retry`: deterministic/idempotent operation can rerun.
- `verify-before-retry`: run a verification/reconciliation step before retrying.
- `restart-from-checkpoint`: discard isolated work and restart from the last checkpoint.
- `manual`: pause for a user decision.

Writer tasks default to `verify-before-retry`; read-only tasks default to `safe-retry`.

On restart, the supervisor replays the Campaign event log and reconciles it with the kernel's persisted status and artifacts. A node persisted as started but not finished becomes `interrupted`, never silently `completed`. The recovery policy then determines the next transition. Completed kernel results are reused rather than rerun.

## 8. Campaign-native Pi SDK execution kernel

### 8.1 Division of responsibility

Campaign owns the workflow scheduler, bounded fan-out, branches, loops, gates, routing, persistence, recovery, and UI. The kernel therefore needs to execute exactly one assignment at a time; it does not need a second chain or graph scheduler.

Each assignment gets a dedicated public Pi SDK `AgentSession` with:

- an explicit model and thinking level;
- a capability-derived built-in tool allowlist;
- a campaign-specific system prompt and assignment prompt;
- a private persistent session directory under the campaign run;
- turn, tool, and wall-clock budget enforcement;
- structured final-output parsing;
- token and cost projection from assistant-message usage;
- abort/stop control; and
- no parent-chat messages or completion notifications.

### 8.2 Durable lifecycle boundary

Before starting an SDK session, Campaign persists `node.scheduled`; after kernel creation it persists the runtime ID and artifact directory. The native kernel atomically writes `campaignLifecycleArtifactVersion: 1` status snapshots containing state, current tool/path, recent output, model, thinking, usage, session path, errors, and final output.

An SDK session is owned by one Pi process. If Pi exits while an assignment is queued or running, replay treats the persisted non-terminal artifact as interrupted rather than claiming native process resume. The node's declared recovery policy then verifies, retries, restarts from a checkpoint, or pauses for manual action.

### 8.3 Tools and writer safety

Read-only assignments receive only `read`, `grep`, `find`, and `ls`. Writer assignments add `edit`, `write`, and `bash`; shell/test capabilities add `bash`. Campaign disables ancillary acceptance-report generation and uses first-class Campaign gates for validation.

The initial native kernel does not create worktrees. Parallel writers remain compile-time restricted. A campaign that explicitly requires isolated writers must obtain an auditable user approval to serialize in the active worktree, and all mutation-capable assignments take the canonical cross-process writer lock.

### 8.4 Controls

Campaign pause prevents new scheduling but cannot freeze an already in-flight provider request. Stop-agent calls `AgentSession.abort()` and settles the lifecycle artifact before the supervisor marks the node stopped/skipped. Retry creates a new assignment session from persisted Campaign state. The control plane must describe these semantics honestly rather than claiming process-native resume.

## 9. Automatic model and thinking routing

### 9.1 Available-model discovery

Use `ctx.modelRegistry.getAvailable()` to obtain only models with configured authentication. Never read or expose credential files. For calls made directly by the extension, resolve request auth with `getApiKeyAndHeaders()` and call Pi's `complete`/`completeSimple` API.

The current machine exposes authenticated models from Anthropic, Fireworks, and OpenAI Codex, including small candidates such as Claude Haiku, GPT-5.4 Mini, and GPT-OSS 20B. These names must not be hardcoded as the only supported choices.

### 9.2 Bootstrap router selection

A model cannot sensibly choose the smallest router before a router has been selected. Use a deterministic bootstrap policy:

1. filter authenticated text-capable models against user/project policy;
2. rank known small/fast models using a versioned capability profile;
3. prefer the lowest-cost/lowest-capability model that meets the router minimum;
4. use name heuristics only for unknown catalog entries and mark that choice low-confidence; and
5. fall back to the active Pi model if no router candidate is known.

The selected router receives the available model catalog, capability profiles, task prompt, node kind, required tools, expected context, risk, prior attempts, and budget.

### 9.3 Router output

```ts
interface ModelDecision {
  model: string;              // provider/id
  thinking: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  fallbackModels: string[];
  confidence: number;
  reasons: string[];
  expectedStrengths: string[];
  escalationTriggers: string[];
}
```

Validate every decision deterministically:

- model is still authenticated and allowed;
- context and image capabilities meet the task;
- requested thinking level is supported or can be clamped;
- writer/reviewer independence rules are preserved;
- model does not violate configured cost or provider constraints; and
- fallbacks are valid and stronger or meaningfully complementary.

If the router emits invalid output, retry once with schema diagnostics, then use the deterministic policy.

### 9.4 Per-node routing and escalation

Route separately for campaign generation, scouting, implementation, review, synthesis, repair, and gate judging. Cache decisions by a hash of task class, requirements, available catalog, and policy.

Escalate automatically when:

- the selected model fails or is unavailable;
- structured output is repeatedly invalid;
- a gate fails for a capability-related reason;
- the model reports low confidence;
- a task exceeds its context estimate; or
- retrying the same model would repeat a no-progress state.

The user can inspect and override the decision but is never required to choose one.

### 9.5 Capability profile and learning

Pi model metadata provides context, output, reasoning, image, and cost information, but not reliable coding/review quality rankings. Maintain a small versioned profile with task-class strengths, latency tier, and confidence. Store observed success, schema compliance, gate outcomes, latency, and cost locally. Use telemetry only to adjust routing on this machine; never silently upload prompts or results.

## 10. Campaign generation pipeline

`/campaign <goal>` starts a persisted bootstrap run:

1. **Ingest:** capture goal, cwd, session ID, available models, active tools, and relevant configuration.
2. **Route generator:** small router chooses the campaign-generator model and thinking level.
3. **Generate:** a bounded, read-only Campaign-native SDK assignment designs labeled hierarchical phases from the goal without inspecting or performing repository work.
4. **Compile:** parse and compile source to IR without executing it.
5. **Repair:** if compilation fails, return diagnostics to the generator for at most two bounded repair attempts.
6. **Risk/size analysis:** calculate maximum fan-out, writers, gates, commands, token estimate, and required capabilities.
7. **Launch gate:** apply configured launch policy (`always`, `smart`, or `never`). The default is `smart`: auto-run routine bounded campaigns and durably pause unusually large/risky campaigns for explicit inspector approval.
8. **Execute:** persist `run.started` and enter the Campaign supervisor loop.

Generated source and IR are always viewable before or during execution. A user can save a successful source program for reuse.

## 11. Persistence model

### 11.1 Locations

- Project campaign definitions: `.pi/campaigns/*.campaign.ts`
- Personal campaign definitions: `~/.pi/agent/campaigns/*.campaign.ts`
- Run data: `~/.pi/agent/campaign-runs/<pi-session-id>/<campaign-run-id>/`
- Session index/checkpoints: lightweight `pi.appendEntry("campaign-run", {...})` entries

Project-local definitions load only for trusted projects. Personal/project naming follows Pi precedence: project overrides personal.

### 11.2 Run directory

```text
<run-id>/
├── source.campaign.ts
├── campaign.ir.json
├── state.json
├── events.jsonl
├── lease.lock/owner.json
├── outputs/
├── gates/
├── router/
├── assignments/
│   ├── <node>.txt
│   └── .runtime-<id>/
│       ├── status.json
│       └── session/*.jsonl
└── logs/
```

- `events.jsonl` is append-only and authoritative.
- `state.json` is an atomic materialized snapshot for fast startup.
- every source, IR, prompt, output, and gate result is content-hashed;
- secrets and provider auth are never written;
- prompt/artifact retention is configurable;
- writes use temp-file + rename and a per-run lease/heartbeat; and
- event schemas carry explicit versions and migration functions.

### 11.3 Replay semantics

Replay applies events in order to a pure reducer. Tests must prove that replaying the same log yields byte-equivalent materialized state. Corrupt final JSONL lines can be truncated after user-visible diagnosis; corruption in the middle pauses the run rather than guessing.

## 12. Full-screen `/campaign-inspect` TUI

Use `ctx.ui.custom()` in non-overlay mode so the inspector temporarily replaces the editor and occupies the available terminal. Guard it with `ctx.mode === "tui"` and provide a noninteractive textual status fallback.

### 12.1 Layout

```text
┌ Run header: goal | state | elapsed | tokens | cost | model policy ┐
│ Phases/nodes                 │ Selected detail                    │
│  ✓ Understand               │ prompt / tools / output / gate     │
│  ▶ Implement 2/8            │ model + thinking + fallbacks       │
│    ✓ worker: route-a        │ transcript and artifact links      │
│    ▶ worker: route-b        │                                     │
│  ○ Verify                   │                                     │
├ Timeline / campaign-control conversation                         ┤
│ > ask or instruct the campaign controller…                       │
└ key hints and active filters                                     ┘
```

Responsive layouts collapse to tabs on narrow terminals. Every rendered line must respect the provided width and use Pi TUI width/truncation helpers.

### 12.2 Views

- run list;
- phase/node tree;
- agent list filtered by status;
- full prompt and editable pending prompt;
- recent tools and current tool/path;
- transcript/result viewer;
- gate evidence and override history;
- model decision, alternatives, and escalation history;
- artifacts;
- event timeline;
- aggregate token/cost/time view; and
- embedded campaign-control conversation.

### 12.3 Controls

- arrows or `j/k`: navigate/scroll;
- Enter/right: drill in;
- Escape/left: back;
- `p`: pause/resume campaign;
- `x`: stop selected node or run;
- `r`: retry selected node;
- `s`: skip node or override selected gate after confirmation;
- `e`: edit a pending node prompt;
- `m`: override the selected node's model/thinking;
- `f`: cycle status filters;
- `a`: artifacts;
- Tab: cycle panes;
- `/`: focus the embedded prompt/control input;
- `q`: close inspector without stopping the background run.

Use Pi's injected keybinding manager and show key hints. The embedded input must implement/propagate `Focusable` and `CURSOR_MARKER` for IME support.

### 12.4 Prompting the model inside the inspector

Free text in the bottom input goes to a campaign controller model with a compact snapshot of the run. The controller returns a validated response:

```ts
interface CampaignControlResponse {
  message: string;
  actions: CampaignControlAction[];
}
```

Actions include explain, change a pending prompt, reroute a pending node, retry, skip, override a gate, pause, resume, stop, or—once kernel support is exposed—steer a running child. The model cannot mutate Campaign state directly; the supervisor validates each action against current state and the user's authority before applying it.

A local-command prefix can provide deterministic controls without an LLM, for example `/pause`, `/retry`, and `/model auto`.

## 13. User-facing commands and invocation

Initial commands:

- `/campaign <goal>` — generate and run a campaign.
- `/campaign-inspect [run-id]` — open the full-screen inspector.
- `/campaign-list` — list active and recent runs.
- `/campaign-run <name> [args]` — run a saved campaign.
- `/campaign-save <run-id> [name]` — save generated source personally or in the project.
- `/campaign-stop <run-id>` — stop a run without opening the inspector.
- `/campaign-doctor` — diagnose Pi SDK kernel, model auth, storage, and lifecycle compatibility.
- `/campaign-config` — configure invocation, launch approval, size, storage, and routing policy.

Optional input interception recognizes `ultracode:` only for human interactive input. It must ignore extension-injected, RPC, print-mode, and queued internal messages to prevent accidental recursion. It can be disabled independently.

The active run also gets a compact footer status. The full inspector remains opt-in and does not monopolize the main session.

## 14. Package/module structure

```text
package.json
README.md
extensions/
└── campaign/
    └── index.ts
src/
├── commands/
├── compiler/
│   ├── parser.ts
│   ├── validator.ts
│   └── diagnostics.ts
├── dsl/
│   ├── index.ts
│   └── types.ts
├── supervisor/
│   ├── dispatch.ts
│   ├── reducer.ts
│   ├── transitions.ts
│   ├── recovery.ts
│   └── writer-policy.ts
├── gates/
├── generator/
├── model-router/
├── persistence/
├── adapters/
│   ├── pi-sdk-kernel.ts
│   ├── kernel-artifacts.ts
│   └── fake-kernel.ts
├── tui/
│   ├── inspector.ts
│   ├── layout.ts
│   ├── input.ts
│   └── views/
├── schemas/
└── shared/
test/
├── unit/
├── integration/
├── fixtures/
└── e2e/
```

The package manifest exposes the Pi extension and lists Pi SDK/core packages plus `typebox` as peer dependencies. Runtime libraries not supplied by Pi belong in `dependencies`. Assignment sessions use the host Pi SDK directly with extension discovery disabled.

## 15. Independently shippable milestones

### Milestone 0 — Feasibility harness and doctor

Deliver:

- Pi package skeleton;
- extension loading and `/campaign-doctor`;
- Campaign-native Pi SDK kernel ping and model-resolution probe;
- available-model inventory using `ctx.modelRegistry.getAvailable()`;
- temporary run storage and cleanup probe;
- fake backend for deterministic tests; and
- one real asynchronous SDK assignment smoke test.

Acceptance:

- doctor clearly detects an absent or incompatible `typebox/compile` dependency;
- native-kernel availability and authenticated-model count are reported without reading secrets;
- a real SDK assignment can be spawned, observed, stopped, and completed;
- package reload and session shutdown leak no watchers/timers; and
- unit/integration test commands are established.

### Milestone 1 — Restricted TypeScript DSL and compiler

Deliver:

- typed DSL package;
- AST parser and strict allowlist;
- IR v1 and JSON schemas;
- compile diagnostics;
- graph/limit/static writer checks; and
- fixture campaigns for sequence, parallel, map, branch, loop, and gate.

Acceptance:

- no generated source is executed;
- malicious imports/calls and unbounded work are rejected;
- valid examples compile deterministically to golden IR;
- source and IR hashes are stable; and
- compiler errors identify source ranges and actionable fixes.

This milestone is independently useful as a campaign authoring/validation tool even before live execution.

### Milestone 2 — Durable Campaign supervisor with a fake kernel

Deliver:

- pure Campaign event reducer;
- milestone dispatch and transitions;
- append-only event log and atomic snapshots;
- delegation of sequence/parallel/map groups through a kernel adapter;
- Campaign-level branch/loop handling around kernel runs;
- output/reference/schema validation;
- checkpoints, retries, and no-progress detection; and
- restart/replay tests using the fake kernel.

Acceptance:

- crash at every event boundary and replay produces a valid deterministic state;
- completed nodes are never rerun;
- bounded loops/fan-out respect limits;
- writer locks are enforced; and
- corrupt/truncated log behavior is tested.

### Milestone 3 — Campaign-native Pi SDK execution

Deliver:

- SDK assignment spawn/status/interrupt/stop integration;
- versioned native lifecycle artifact watcher;
- assignment-to-session prompt/tool/model/thinking mapping;
- silent parent-chat behavior and compact footer status;
- `/campaign-list` and textual inspection; and
- serialized native writer execution.

Acceptance:

- Pi remains responsive during a run;
- phase, prompt, tools, model, thinking, tokens, cost, result, and errors are captured;
- stopping Pi and reopening restores run state;
- active run cleanup is correct on session replacement/shutdown; and
- a multi-stage real campaign completes through Campaign-owned SDK sessions without parent-chat completion notifications.

### Milestone 4 — First-class gates and controls

Deliver:

- command, schema, artifact, review, acceptance, approval, safety, budget, and predicate gates;
- pass/fail/error/override transitions;
- pause, stop, retry, skip, edit-pending-prompt, and model override APIs;
- auditable overrides;
- recovery policies for interrupted nodes; and
- campaign-level resume through persisted replay and fresh assignment sessions.

Acceptance:

- every gate transition is persisted and replayable;
- user can override every campaign-level gate;
- edit/retry invalidates only dependent pending outputs;
- mutation steps are not blindly duplicated after a crash; and
- completed fan-out items remain cached on resume.

### Milestone 5 — Automatic model router

Deliver:

- authenticated model discovery;
- capability profile and deterministic bootstrap ranking;
- smallest-router selection;
- schema-validated routing calls;
- per-node thinking/model/fallback decisions;
- cache and telemetry;
- escalation/no-progress rules; and
- inspector-ready decision records.

Acceptance:

- normal runs require no model choice;
- invalid/unavailable router choices are rejected safely;
- thinking levels are clamped to model capabilities;
- fallback/escalation is reproducible and bounded;
- provider or budget policies are enforced; and
- router failure falls back to deterministic selection.

### Milestone 6 — Dynamic campaign generation and saved programs

Deliver:

- `/campaign <goal>` bootstrap pipeline;
- generator routing and read-only repository inspection;
- compile/repair loop;
- phase/risk/size summary;
- smart launch policy;
- `/campaign-run` and `/campaign-save`;
- project/personal discovery and precedence; and
- optional human-only `ultracode:` trigger.

Acceptance:

- a natural-language goal produces viewable source and valid IR;
- compiler repair is capped and reports final diagnostics;
- saved campaign inputs are schema validated;
- project campaigns load only in trusted projects; and
- generated campaigns respect global hard caps regardless of source declarations.

This is the first full end-to-end Ultracode-equivalent release.

### Milestone 7 — Full-screen inspector and campaign-control chat

Deliver:

- responsive full-screen TUI;
- run/phase/agent/gate/model/artifact/timeline views;
- live filesystem/event updates;
- all keyboard controls;
- embedded IME-compatible input;
- validated controller-model actions; and
- textual/RPC fallbacks outside TUI mode.

Acceptance:

- live updates do not block the Campaign supervisor or main Pi session;
- every rendered line stays within terminal width;
- narrow/wide terminals and theme invalidation are tested;
- inspector can close/reopen without stopping the run;
- pending prompts/models and gates are controllable; and
- model chat cannot bypass supervisor validation.

### Milestone 8 — Native steering/resume and production hardening

Deliver:

- explicit inspector steering for live SDK assignment sessions where deterministic semantics permit it;
- persisted session continuation where it can be reconciled safely;
- stronger process-isolation options for untrusted or mutation-heavy assignments;
- scale warnings and cost projections;
- retention/redaction controls;
- package documentation, migration policy, and release automation;
- adversarial security review; and
- performance/load testing.

Acceptance:

- a running assignment acknowledges inspector steering;
- persisted assignment sessions continue without losing available context where reconciliation is safe;
- 100+ bounded read-only tasks remain inspectable without UI degradation;
- leaked secrets are absent from persisted fixtures/logs;
- compatibility tests cover supported Pi SDK versions; and
- installation through `pi install` works from a clean environment.

## 16. Test strategy

### Unit

- DSL parsing and rejection cases;
- IR graph validation;
- event reducer and replay;
- branch/loop/no-progress logic;
- gates and overrides;
- prompt/reference rendering;
- model ranking and decision validation;
- redaction and retention; and
- responsive TUI layout calculations.

### Property/fuzz

- arbitrary event sequences never create impossible states;
- replay is deterministic;
- graph compilation never schedules more than declared limits;
- malformed model/generator JSON cannot mutate state; and
- terminal render lines never exceed width.

### Integration

- fake kernel and native lifecycle-artifact fixtures;
- real Pi SDK assignment completion and cancellation smoke runs;
- `status.json`/`events.jsonl` recovery fixtures;
- restart with an in-flight read task and writer task;
- worktree writer isolation and serialized merge;
- unavailable/rate-limited model escalation; and
- session new/resume/fork/reload lifecycle.

### End-to-end

1. audit many files, verify and deduplicate findings;
2. run a check/repair loop until pass or no progress;
3. migrate isolated files in parallel and merge serially;
4. pause, restart Pi, resume, and retain completed items;
5. edit a pending prompt and observe dependent invalidation;
6. override a failed safety gate with an audit record;
7. use `/campaign-inspect` to prompt and reroute a pending node; and
8. save a generated campaign and rerun it with typed arguments.

## 17. Operational limits and defaults

Initial defaults:

- maximum concurrent agents: 4;
- maximum total agents: 100;
- maximum loop rounds: 3;
- one writer per active worktree;
- generator repair attempts: 2;
- model attempts per task: 3;
- default launch size guideline: medium;
- large-run warning: more than 25 agents or projected 1.5M tokens;
- no hardcoded cost ceiling unless configured, but budget gates remain available;
- prompt/output persistence enabled locally with configurable retention; and
- project campaign execution requires project trust.

Hard caps live in trusted user/project configuration and cannot be raised by generated source. A user may override campaign gates but not silently exceed runtime hard caps; changing a hard cap is an explicit configuration action.

## 18. Major risks and mitigations

| Risk | Mitigation |
|---|---|
| Generated TypeScript executes arbitrary code | Parse restricted AST into IR; never import/eval default campaign source. |
| In-process SDK assignment dies with Pi | Durable lifecycle artifact, interruption reconciliation, and declared node recovery policy. |
| Native kernel lacks worktrees | Reject unsafe parallel writers; require explicit serialized downgrade and canonical writer lock. |
| “Best model” is not derivable from Pi metadata alone | Capability profiles, small routing model, deterministic validation, local outcome telemetry, bounded escalation. |
| Duplicate edits after crash | Persist-before-side-effect events, writer recovery policies, verify-before-retry default. |
| Parallel writers conflict | Compiler/supervisor writer rules; kernel worktree isolation and serialized merge gates. |
| Model-generated campaign explodes in size/cost | Compile-time bounds, runtime hard caps, budget gates, no-progress checks, warnings. |
| Inspector falls behind large event streams | Incremental tailing, summarized state, bounded buffers, lazy transcript loading. |
| State diverges after source edit | Content hashes, immutable run source/IR snapshots, explicit new revision on edit. |
| Gate judge is nondeterministic | Structured verdicts, evidence capture, input-hash caching, independent review where warranted. |
| User overrides a safety gate accidentally | Deliberate confirmation, evidence display, audit log; still overridable as requested. |
| Pi SDK drift | Use only public SDK contracts, version native artifacts, and test supported Pi versions in CI. |

## 19. Definition of the first production-quality release

The project is production-ready when a user can submit a substantive goal, leave model selection entirely on automatic, inspect the generated TypeScript and compiled phases, let the run continue in the background, reopen Pi after a restart, inspect or prompt the campaign from `/campaign-inspect`, override any gate, and receive a final evidence-backed result—without the master conversation holding or manually advancing every intermediate step.

The recommended implementation order is Milestones 0 through 7. Milestone 8 hardens the Campaign-native SDK runtime after the core supervisor is stable.
