import { canonicalJson, bytesVersion } from "./content-version.js";
import { isRecord } from "../shared/type-guards.js";

export type IntentSource = { id: string; version: string; authorId: string; role: "author" | "assistant" | "third_party";
  locator: string; purpose: "support" | "counter" | "clarification"; excerpt: string };
export type IntentStatement = { id: string; text: string; sourceIds: string[] };
export type AuthorIntentContent = { topic: string; scope: string; nonGoals: string[]; sources: IntentSource[];
  originalIntent: IntentStatement[]; established: IntentStatement[]; candidates: IntentStatement[]; unresolved: string[];
  interpretation: IntentStatement | null;
  authorityConflicts: { authority: "USER" | "MEMORY"; reference: string; version: string; issue: string;
    status: "unresolved" | "scoped_exception" }[] };
export type IntentPublication = { operationId: string; expectedVersion: string | null; content: AuthorIntentContent;
  confirmation: "candidate" | "author_confirmed"; triggerSourceId: string | null; replaces: string[]; reason: string };
export type AuthorIntentDocument = { schemaVersion: "stella.author-intent/v1"; assetId: string; content: AuthorIntentContent;
  revision: Omit<IntentPublication, "content" | "expectedVersion"> & { previousVersion: string | null } };
export class AuthorIntentError extends Error {
  constructor(readonly category: string) { super(`Author intent: ${category}`); }
}
export function intentCheck(value: unknown, category: string): asserts value {
  if (!value) throw new AuthorIntentError(category);
}
export function intentVersion(value: unknown): value is string {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
}
export function intentId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z][A-Za-z0-9_-]{0,99}$/.test(value);
}
function exact(value: unknown, fields: string[]): asserts value is Record<string, unknown> {
  intentCheck(isRecord(value) && Object.getPrototypeOf(value) === Object.prototype &&
    Object.keys(value).sort().join() === [...fields].sort().join(), "invalid_asset");
}
function text(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0 && value.length <= 16_384; }
function list(value: unknown): asserts value is unknown[] { intentCheck(Array.isArray(value) && value.length <= 128, "invalid_asset"); }
function texts(value: unknown): asserts value is string[] { list(value); intentCheck(value.every(text), "invalid_asset"); }
function statements(value: unknown, ids: Set<string>): asserts value is IntentStatement[] {
  list(value);
  for (const statement of value) {
    exact(statement, ["id", "text", "sourceIds"]); texts(statement.sourceIds);
    intentCheck(intentId(statement.id) && text(statement.text) && statement.sourceIds.length > 0 &&
      new Set(statement.sourceIds).size === statement.sourceIds.length && statement.sourceIds.every(id => ids.has(id)), "invalid_asset");
  }
}
export function parseIntentPublication(value: unknown): IntentPublication {
  // Snapshot JSON once, before any asynchronous source/permission checks.
  let copy: unknown;
  try { const bytes = canonicalJson(value); intentCheck(Buffer.byteLength(bytes) <= 256 * 1024, "invalid_asset"); copy = JSON.parse(bytes); }
  catch { throw new AuthorIntentError("invalid_asset"); }
  exact(copy, ["operationId", "expectedVersion", "content", "confirmation", "triggerSourceId", "replaces", "reason"]);
  intentCheck(intentId(copy.operationId) && (copy.expectedVersion === null || intentVersion(copy.expectedVersion)) && text(copy.reason) &&
    typeof copy.confirmation === "string" && ["candidate", "author_confirmed"].includes(copy.confirmation) &&
    (copy.triggerSourceId === null || intentId(copy.triggerSourceId)), "invalid_asset");
  texts(copy.replaces); intentCheck(copy.replaces.every(intentId) && new Set(copy.replaces).size === copy.replaces.length, "invalid_asset");
  const c = copy.content;
  exact(c, ["topic", "scope", "nonGoals", "sources", "originalIntent", "established", "candidates", "unresolved", "interpretation", "authorityConflicts"]);
  intentCheck(text(c.topic) && text(c.scope), "invalid_asset"); texts(c.nonGoals); texts(c.unresolved); list(c.sources);
  const sourceIds = new Set<string>();
  for (const source of c.sources) {
    exact(source, ["id", "version", "authorId", "role", "locator", "purpose", "excerpt"]);
    intentCheck(intentId(source.id) && !sourceIds.has(source.id) && intentVersion(source.version) && text(source.authorId) &&
      typeof source.role === "string" && ["author", "assistant", "third_party"].includes(source.role) && text(source.locator) && text(source.excerpt) &&
      typeof source.purpose === "string" && ["support", "counter", "clarification"].includes(source.purpose), "invalid_asset");
    sourceIds.add(source.id);
  }
  statements(c.originalIntent, sourceIds); statements(c.established, sourceIds); statements(c.candidates, sourceIds);
  if (c.interpretation !== null) statements([c.interpretation], sourceIds);
  const all = [...c.originalIntent, ...c.established, ...c.candidates, ...(c.interpretation ? [c.interpretation as IntentStatement] : [])];
  intentCheck(new Set(all.map(s => s.id)).size === all.length, "invalid_asset");
  list(c.authorityConflicts);
  for (const conflict of c.authorityConflicts) {
    exact(conflict, ["authority", "reference", "version", "issue", "status"]);
    intentCheck(typeof conflict.authority === "string" && ["USER", "MEMORY"].includes(conflict.authority) && text(conflict.reference) && text(conflict.version) &&
      text(conflict.issue) && typeof conflict.status === "string" && ["unresolved", "scoped_exception"].includes(conflict.status), "invalid_asset");
  }
  if (copy.confirmation === "candidate") {
    intentCheck(c.originalIntent.length === 0 && c.established.length === 0 && c.interpretation === null && copy.triggerSourceId === null,
      "author_source_required");
  } else {
    const authorIds = new Set((c.sources as IntentSource[]).filter(s => s.role === "author").map(s => s.id));
    const authoritative = [...c.originalIntent, ...c.established, ...(c.interpretation ? [c.interpretation as IntentStatement] : [])];
    intentCheck(typeof copy.triggerSourceId === "string" && authorIds.has(copy.triggerSourceId) && authoritative.length > 0 &&
      authoritative.every(s => s.sourceIds.some(id => authorIds.has(id))) &&
      authoritative.some(s => s.sourceIds.includes(copy.triggerSourceId as string)), "author_source_required");
  }
  return copy as unknown as IntentPublication;
}
export function intentDocument(assetId: string, input: IntentPublication): AuthorIntentDocument {
  intentCheck(intentId(assetId), "invalid_asset_id");
  const { content, expectedVersion, ...revision } = parseIntentPublication(input);
  return { schemaVersion: "stella.author-intent/v1", assetId, content, revision: { ...revision, previousVersion: expectedVersion } };
}
export function parseIntentDocument(bytes: string, assetId: string): AuthorIntentDocument {
  let value: unknown;
  try { value = JSON.parse(bytes); } catch { throw new AuthorIntentError("invalid_asset"); }
  exact(value, ["schemaVersion", "assetId", "content", "revision"]);
  intentCheck(value.schemaVersion === "stella.author-intent/v1" && value.assetId === assetId, "invalid_asset");
  exact(value.revision, ["operationId", "confirmation", "triggerSourceId", "replaces", "reason", "previousVersion"]);
  const { previousVersion, ...revision } = value.revision;
  const parsed = intentDocument(assetId, { ...revision, content: value.content, expectedVersion: previousVersion } as IntentPublication);
  intentCheck(canonicalJson(parsed) === bytes, "invalid_asset"); return parsed;
}
export function intentProposalHash(input: IntentPublication): string { return bytesVersion(canonicalJson(input)); }
