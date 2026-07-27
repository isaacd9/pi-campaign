import assert from "node:assert/strict";
import test from "node:test";
import { CampaignCompileError, compileCampaign } from "../../src/compiler/index.ts";
import { Ajv } from "ajv";
import { CAMPAIGN_IR_V1_SCHEMA } from "../../src/schemas/campaign-ir-v1.ts";
import { validCampaign } from "../fixtures/valid.ts";
import { defaultCampaignSource, extractCampaignCandidate, generatorPrompt } from "../../src/generator/index.ts";
test("generator prompt delegates the goal and demonstrates the exact DSL shape", () => { const prompt = generatorPrompt("Analyze the repository", { maxAgents: 10, maxConcurrency: 2, maxRounds: 2, maxTokens: 1000, timeoutMs: 1000 }); assert.match(prompt, /DO NOT perform the user's goal/); assert.match(prompt, /Do not inspect the repository and do not call tools/); assert.match(prompt, /export default defineCampaign/); assert.match(prompt, /tree or DAG-shaped campaign/); assert.match(prompt, /phase-analysis/); assert.match(prompt, /template\("Analyze concern A/); assert.match(prompt, /top-level fields are meta, limits, and program/); assert.match(prompt, /limits\.maxAgents must cover/); assert.match(prompt, /output only the campaign program/); });
test("default campaign source uses explicit template interpolation", () => { assert.doesNotThrow(() => compileCampaign(defaultCampaignSource("Implement the goal"))); });
test("invalid generator code fences remain available to the repair pass", () => { assert.match(extractCampaignCandidate("analysis\n```ts\ndefineCampaign({ workflow: [] });\n```"), /workflow/); assert.match(extractCampaignCandidate("```ts\nold();\n```\n```ts\nnewest();\n```"), /newest/); });
test("compiles deterministically without executing source", () => { delete process.env.CAMPAIGN_PWNED; const one = compileCampaign(validCampaign); const two = compileCampaign(validCampaign); assert.deepEqual(one.ir, two.ir); assert.equal(one.irHash, two.irHash); assert.equal(one.ir.root, "sequence-1"); assert.equal(one.ir.nodes.length, 7); const validate = new Ajv({ strict: false }).compile(CAMPAIGN_IR_V1_SCHEMA); assert.equal(validate(one.ir), true, JSON.stringify(validate.errors)); assert.equal(process.env.CAMPAIGN_PWNED, undefined); });
test("rejects arbitrary imports and calls with ranges", () => { const source = `import fs from "node:fs"; import { defineCampaign } from "pi-campaign/dsl"; fs.writeFileSync("x", "x"); export default defineCampaign({});`; assert.throws(() => compileCampaign(source), (error: unknown) => { assert.ok(error instanceof CampaignCompileError); assert.ok(error.diagnostics.some((item) => item.code === "unsafe-import")); assert.ok(error.diagnostics.every((item) => !item.range || item.range.line >= 1)); return true; }); });
test("rejects unbounded map, missing refs, and caps", () => { const source = validCampaign.replace("maxItems: 3", "maxItems: -1").replace("discover.output.files", "missing.output.files").replace("maxConcurrency: 2", "maxConcurrency: 99"); assert.throws(() => compileCampaign(source), (error: unknown) => { const codes = (error as CampaignCompileError).diagnostics.map((item) => item.code); assert.ok(codes.includes("unbounded-map")); assert.ok(codes.includes("missing-reference")); assert.ok(codes.includes("hard-cap")); return true; }); });
test("rejects duplicate ids and parallel writers without worktrees", () => { const source = `import {defineCampaign,parallel,task} from "pi-campaign/dsl"; export default defineCampaign({meta:{name:"x",version:1},limits:{maxAgents:2,maxConcurrency:2,maxRounds:1,maxTokens:10},program:parallel({id:"p",concurrency:2,children:[task({id:"same",agent:"worker",prompt:"a",capabilities:["code-write"]}),task({id:"same",agent:"worker",prompt:"b",capabilities:["code-write"]})]})});`; assert.throws(() => compileCampaign(source), (error: unknown) => { const codes = (error as CampaignCompileError).diagnostics.map((item) => item.code); assert.ok(codes.includes("duplicate-id")); assert.ok(codes.includes("parallel-writers")); return true; }); });
test("compiles branch and bounded repeatUntil", () => { const source = `import {defineCampaign,sequence,task,branch,repeatUntil,checkpoint,ref} from "pi-campaign/dsl"; export default defineCampaign({meta:{name:"flow",version:1},limits:{maxAgents:3,maxConcurrency:1,maxRounds:2,maxTokens:100},program:sequence([task({id:"inspect",agent:"scout",prompt:"inspect",output:{type:"object",properties:{ok:{type:"boolean"}},additionalProperties:false}}),branch({id:"choose",predicate:{op:"truthy",value:ref("inspect.output.ok")},then:checkpoint("yes"),else:checkpoint("no")}),repeatUntil({id:"repeat",body:task({id:"check",agent:"scout",prompt:"check",output:{type:"object",properties:{done:{type:"boolean"}},additionalProperties:false}}),until:{op:"truthy",value:ref("check.output.done")},maxRounds:2,noProgress:true})])});`; const { ir } = compileCampaign(source); assert.ok(ir.nodes.some((node) => node.kind === "branch")); assert.ok(ir.nodes.some((node) => node.kind === "loop")); });
test("rejects forward and schema-incompatible references", () => { const source = `import {defineCampaign,sequence,task,emit,ref} from "pi-campaign/dsl"; export default defineCampaign({meta:{name:"x",version:1},limits:{maxAgents:1,maxConcurrency:1,maxRounds:1,maxTokens:10},program:sequence([emit({id:"early",message:ref("later.output.missing")}),task({id:"later",agent:"scout",prompt:"x",output:{type:"object",properties:{ok:{type:"boolean"}},additionalProperties:false}})])});`; assert.throws(() => compileCampaign(source), (error: unknown) => { const diagnostics = (error as CampaignCompileError).diagnostics; assert.ok(diagnostics.some((item) => item.code === "forward-reference")); assert.ok(diagnostics.some((item) => item.code === "incompatible-reference")); assert.ok(diagnostics.every((item) => item.range)); return true; }); });
test("validates hardcoded models against authenticated catalog and fallback", () => { const source = validCampaign.replace('agent: "scout", prompt:', 'agent: "scout", model: "p/missing", fallbackModels: ["p/available"], prompt:'); assert.doesNotThrow(() => compileCampaign(source, { availableModels: ["p/available"] })); assert.throws(() => compileCampaign(source, { availableModels: ["p/other"] }), (error: unknown) => { assert.ok((error as CampaignCompileError).diagnostics.some((item) => item.code === "unavailable-model")); return true; }); });
test("rejects retry or repair gate policies without a hard bound", () => { const source = validCampaign.replace('onFail: { action: "stop" }', 'onFail: { action: "repair" }'); assert.throws(() => compileCampaign(source), (error: unknown) => { assert.ok((error as CampaignCompileError).diagnostics.some((item) => item.code === "unbounded-retry")); return true; }); });
test("rejects variables, spreads, functions, loops, dynamic properties, and prototype keys", () => { for (const program of ["(() => 1)()", "sequence([...[]])", "sequence(items)", "define()"] ) { const source = `import {defineCampaign,sequence} from "pi-campaign/dsl"; export default defineCampaign({meta:{name:"x",version:1},limits:{maxAgents:1,maxConcurrency:1,maxRounds:1,maxTokens:1},program:${program}});`; assert.throws(() => compileCampaign(source)); } const proto = `import {defineCampaign,checkpoint} from "pi-campaign/dsl"; export default defineCampaign({meta:{name:"x",version:1,__proto__:{}},limits:{maxAgents:1,maxConcurrency:1,maxRounds:1,maxTokens:1},program:checkpoint("x")});`; assert.throws(() => compileCampaign(proto), /Unsafe property/); });

test("predicateGate compiles its predicate structurally", () => {
  const source = `import {defineCampaign,gate,predicateGate} from "pi-campaign/dsl"; export default defineCampaign({meta:{name:"p",version:1},limits:{maxAgents:1,maxConcurrency:1,maxRounds:1,maxTokens:10},program:gate({id:"g",check:predicateGate({op:"truthy",value:true}),overridable:true,onFail:{action:"stop"}})});`;
  const gate = compileCampaign(source).ir.nodes.find((node) => node.kind === "gate");
  assert.deepEqual(gate && gate.kind === "gate" ? gate.check : undefined, { type: "predicate", predicate: { op: "truthy", value: true } });
});

test("rejects malformed gates, predicates, schemas, and hidden acceptance commands", () => {
  const programs = [
    `gate({id:"g",check:commandGate({}),overridable:true,onFail:{action:"stop"}})`,
    `branch({id:"b",predicate:{op:"wat",value:true},then:checkpoint("x")})`,
    `task({id:"t",agent:"scout",prompt:"x",output:{type:"wat"}})`,
    `task({id:"t",agent:"worker",prompt:"x",acceptance:{verify:{command:"rm -rf ."}}})`,
  ];
  const imports = "defineCampaign,gate,commandGate,branch,checkpoint,task";
  for (const program of programs) {
    const source = `import {${imports}} from "pi-campaign/dsl"; export default defineCampaign({meta:{name:"x",version:1},limits:{maxAgents:2,maxConcurrency:1,maxRounds:1,maxTokens:10},program:${program}});`;
    assert.throws(() => compileCampaign(source), (error: unknown) => {
      assert.ok(error instanceof CampaignCompileError);
      assert.ok(error.diagnostics.every((item) => item.range));
      return true;
    });
  }
});

test("rejects malformed ref/template expressions and unresolved plain interpolation", () => {
  const base = (prompt: string) => `import {defineCampaign,task,ref,template} from "pi-campaign/dsl"; export default defineCampaign({meta:{name:"x",version:1},limits:{maxAgents:1,maxConcurrency:1,maxRounds:1,maxTokens:10},program:task({id:"work",agent:"scout",prompt:${prompt}})});`;
  assert.throws(() => compileCampaign(base("ref(123)")), (error: unknown) => (error as CampaignCompileError).diagnostics.some((item) => item.code === "invalid-expression"));
  assert.throws(() => compileCampaign(base('template("x", "ignored")')), (error: unknown) => (error as CampaignCompileError).diagnostics.some((item) => item.code === "invalid-arity"));
  assert.throws(() => compileCampaign(base('"Use {{prior.output}}"')), (error: unknown) => (error as CampaignCompileError).diagnostics.some((item) => item.code === "unresolved-interpolation"));
});

test("rejects references between parallel siblings", () => {
  const source = `import {defineCampaign,parallel,task,ref} from "pi-campaign/dsl"; export default defineCampaign({meta:{name:"x",version:1},limits:{maxAgents:2,maxConcurrency:2,maxRounds:1,maxTokens:10},program:parallel({id:"p",concurrency:2,children:[task({id:"a",agent:"scout",prompt:"a"}),task({id:"b",agent:"scout",prompt:ref("a.output")})]})});`;
  assert.throws(() => compileCampaign(source), (error: unknown) => {
    assert.ok((error as CampaignCompileError).diagnostics.some((item) => item.code === "parallel-sibling-reference"));
    return true;
  });
});
