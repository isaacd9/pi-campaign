import { createHash } from "node:crypto";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonSchema = Record<string, unknown>;

export function stableStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  const normalize = (input: unknown): unknown => {
    if (input === undefined) return null;
    if (typeof input === "number" && !Number.isFinite(input)) throw new TypeError("Non-finite numbers are not JSON values");
    if (!input || typeof input !== "object") return input;
    if (seen.has(input)) throw new TypeError("Cannot stringify a cyclic value");
    seen.add(input);
    const output = Array.isArray(input)
      ? input.map(normalize)
      : Object.fromEntries(Object.keys(input as Record<string, unknown>).sort().map((key) => [key, normalize((input as Record<string, unknown>)[key])]));
    seen.delete(input);
    return output;
  };
  return JSON.stringify(normalize(value));
}

export function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function contentHash(value: unknown): string {
  return sha256(stableStringify(value));
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
