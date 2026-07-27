export const CAMPAIGN_EVENT_V1_SCHEMA = {
  $id: "https://pi.dev/schemas/campaign-event-v1.json",
  type: "object",
  additionalProperties: false,
  required: ["eventVersion", "seq", "id", "runId", "type", "timestamp", "data"],
  properties: {
    eventVersion: { const: 1 },
    seq: { type: "integer", minimum: 1 },
    id: { type: "string", minLength: 1 },
    runId: { type: "string", minLength: 1 },
    type: { type: "string", minLength: 1 },
    timestamp: { type: "integer", minimum: 0 },
    data: {},
  },
} as const;
