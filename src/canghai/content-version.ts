import { createHash } from "node:crypto";
import { isRecord } from "../shared/type-guards.js";

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) {
    if (Object.keys(value).length !== value.length || Array.from({ length: value.length }, (_, index) => index).some((index) => !Object.hasOwn(value, index))) {
      throw new Error("Non-JSON sparse array");
    }
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (isRecord(value) && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  throw new Error("Non-JSON version input");
}

export function bytesVersion(bytes: string | Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export function objectVersion(object: Record<string, unknown>): string {
  const { version: _version, locator: _locator, ...content } = object;
  if (["stella.memory-source/v1", "stella.memory-source/v2"].includes(String(content.schemaVersion)) && Array.isArray(content.payloads)) {
    content.payloads = content.payloads.map((payload: unknown) => {
      if (!isRecord(payload)) throw new Error("Invalid source payload");
      const { path: _path, revision: _revision, ...identity } = payload;
      return identity;
    });
  }
  return bytesVersion(canonicalJson(content));
}
