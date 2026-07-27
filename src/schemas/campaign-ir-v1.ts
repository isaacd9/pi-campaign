export const CAMPAIGN_IR_V1_SCHEMA = {
  $id: "https://pi.dev/schemas/campaign-ir-v1.json",
  type: "object",
  additionalProperties: false,
  required: ["irVersion", "sourceHash", "meta", "limits", "root", "nodes", "edges", "outputs"],
  properties: {
    irVersion: { const: 1 },
    sourceHash: { type: "string", pattern: "^[a-f0-9]{64}$" },
    meta: {
      type: "object", required: ["name", "version"], additionalProperties: false,
      properties: { name: { type: "string", minLength: 1 }, description: { type: "string" }, version: { type: "integer", minimum: 1 } },
    },
    inputSchema: { type: "object" },
    limits: {
      type: "object", required: ["maxAgents", "maxConcurrency", "maxRounds", "maxTokens"], additionalProperties: false,
      properties: {
        maxAgents: { type: "integer", minimum: 1 }, maxConcurrency: { type: "integer", minimum: 1 },
        maxRounds: { type: "integer", minimum: 1 }, maxTokens: { type: "integer", minimum: 1 }, timeoutMs: { type: "integer", minimum: 1 },
      },
    },
    root: { type: "string" },
    nodes: {
      type: "array",
      items: {
        type: "object", required: ["id", "kind"],
        properties: {
          id: { type: "string", pattern: "^[A-Za-z][A-Za-z0-9._-]{0,127}$" },
          kind: { enum: ["agent-task", "sequence", "parallel", "map", "branch", "loop", "gate", "checkpoint", "aggregate", "emit"] },
        },
      },
    },
    edges: {
      type: "array",
      items: {
        type: "object", required: ["from", "to", "type"], additionalProperties: false,
        properties: { from: { type: "string" }, to: { type: "string" }, type: { enum: ["child", "then", "else", "body"] } },
      },
    },
    outputs: {
      type: "object",
      additionalProperties: {
        type: "object", required: ["nodeId"], additionalProperties: false,
        properties: { nodeId: { type: "string" }, schema: { type: "object" } },
      },
    },
  },
} as const;
