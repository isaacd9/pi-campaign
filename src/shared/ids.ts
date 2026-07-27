import { randomBytes } from "node:crypto";
export function createId(prefix = "run"): string {
  return `${prefix}-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
}
export function safeName(value: string): string {
  const result = value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!result || result.includes("..")) throw new Error(`Invalid name: ${value}`);
  return result;
}
