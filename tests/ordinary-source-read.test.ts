import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { createOrdinaryPlugin, SOURCE_READ_TOOL, parseOrdinaryConfig } from "../src/ordinary-plugin.js";
import { executeOrdinarySourceRead, parseSourceReadBinding, type SourceReadAdmission } from "../src/openclaw/ordinary-source-read.js";
import { prepareRepositorySource } from "../src/canghai/repository-source.js";
import { CatalogError, CatalogReader, parseMemoryCatalog } from "../src/canghai/catalog-reader.js";
import { canonicalJson, bytesVersion, objectVersion } from "../src/canghai/content-version.js";
import type { VersionedRef } from "../src/praxis/episode-v2.js";

import { fixture, prefix, manifestPath, profilePath, catalogPath, hostVersion } from "./fixtures/ordinary-source-read.js";

test("selected real-contract manifest/profile/catalog lists roles and times without reading original payloads", async t => {
  const f = await fixture(t), result = await f.execute({ action: "list" });
  assert.equal(result.status, "listed"); if (result.status !== "listed") assert.fail();
  assert.equal(result.items.length, 3); assert.equal(f.metadataCalls(), 3); assert.equal(f.sourcePolicies.length, 0);
  assert.deepEqual(result.items.map(i => i.role), ["owner", "assistant", "external_author"]);
  assert.deepEqual(result.items.map(i => i.kind), ["reported", "inference", "quotation"]);
  assert.equal(result.items[0].occurredAt, "2026-07-01T00:00:00Z"); assert.equal(result.items[0].authoredAt, "2026-08-01T00:00:00Z");
  assert.equal(result.semanticSelection, "not_performed"); assert.equal(result.questionSufficiency, "not_assessed");
  assert.equal(JSON.stringify(result).includes("the harbor walk"), false); assert.equal(result.scope, "selected_manifest_catalog");
});

test("descriptor list projects only reviewed fields, never touches payloads, and keeps description separate from evidence", async t => {
  const f = await fixture(t, 1), originalRead = CatalogReader.prototype.readPayload;
  CatalogReader.prototype.readPayload = async () => { throw new Error("list must not read payload"); };
  t.after(() => { CatalogReader.prototype.readPayload = originalRead; });
  const result = await f.execute({ action: "list" }, { ...f.admission, async assertMetadata(reader, ref) {
    const descriptor = await f.admission.assertMetadata(reader, ref); if (descriptor === false) assert.fail();
    return { ...descriptor, extraPrivateBody: "synthetic-unapproved-body",
      sourceRef: { ...descriptor.sourceRef, extraPrivateBody: "synthetic-unapproved-body" },
      policyRef: { ...descriptor.policyRef, extraPrivateBody: "synthetic-unapproved-body" } };
  } });
  if (result.status !== "listed") assert.fail();
  assert.equal(result.items[0].description, "Reviewed fictional record 0.");
  assert.equal(result.descriptionUse, "untrusted_locator_not_evidence");
  assert.deepEqual(Object.keys(result.items[0]).sort(), ["ref", "sourceRef", "policyRef", "segment", "description", "role", "kind", "occurredAt", "authoredAt", "capturedAt"].sort());
  assert.equal(JSON.stringify(result).includes("synthetic-unapproved-body"), false);
  assert.equal(f.sourcePolicies.length, 0);
});

test("list rejects missing, invalid or mismatched descriptors instead of inventing descriptions or reading bodies", async t => {
  const f = await fixture(t, 1);
  const mutations = [
    () => undefined,
    (d: any) => ({ ...d, description: " " }),
    (d: any) => ({ ...d, description: "x".repeat(8001) }),
    (d: any) => ({ ...d, description: { text: "not a string" } }),
    (d: any) => ({ ...d, sourceRef: { ...d.sourceRef, version: "sha256:" + "a".repeat(64) } }),
    (d: any) => ({ ...d, policyRef: { ...d.policyRef, version: "sha256:" + "a".repeat(64) } }),
    (d: any) => ({ ...d, segment: { ...d.segment, start: d.segment.start + 1 } }),
    (d: any) => ({ ...d, segment: undefined }),
  ];
  for (const mutate of mutations) await assert.rejects(f.execute({ action: "list" }, { ...f.admission,
    async assertMetadata(reader, ref) { return mutate(await f.admission.assertMetadata(reader, ref)); },
  } as SourceReadAdmission), /source_descriptor_(unavailable|mismatch)/);
  assert.equal(f.sourcePolicies.length, 0);
});

test("descriptive pages obey serialized UTF-8 capacity and resume without dropping or truncating a candidate", async t => {
  const f = await fixture(t, 8), description = "漢".repeat(7500), refs: VersionedRef[] = [];
  const admission = { ...f.admission, async assertMetadata(reader: CatalogReader, ref: VersionedRef) {
    const descriptor = await f.admission.assertMetadata(reader, ref); if (descriptor === false) return false as const;
    return { ...descriptor, description };
  } };
  let cursor: { catalogHash: string; offset: number } | undefined, pages = 0;
  do {
    const result = await f.execute({ action: "list", ...(cursor ? { cursor } : {}) }, admission);
    if (result.status !== "listed") assert.fail();
    assert.ok(Buffer.byteLength(JSON.stringify(result), "utf8") <= 128 * 1024);
    assert.ok(result.items.length > 0); assert.equal(result.excludedByScopeOnPage, 0); assert.equal(result.excludedByTimeOnPage, 0);
    for (const item of result.items) { assert.equal(item.description, description); refs.push(item.ref); }
    if (result.nextCursor) assert.ok(result.nextCursor.offset > (cursor?.offset ?? 0));
    cursor = result.nextCursor ?? undefined; pages++; assert.ok(pages <= 8);
  } while (cursor);
  assert.ok(pages > 1); assert.deepEqual(refs, f.refs); assert.equal(f.sourcePolicies.length, 0);
});

test("an expired metadata await cannot release descriptors after replacing the original guard", async t => {
  const f = await fixture(t, 1); let active = true;
  const admission: SourceReadAdmission = { ...f.admission, assertCurrent() { assert.ok(active, "request_expired"); },
    async assertMetadata(reader, ref) {
      const descriptor = await f.admission.assertMetadata(reader, ref);
      active = false; admission.assertCurrent = () => {}; return descriptor;
    } };
  await assert.rejects(f.execute({ action: "list" }, admission), /request_expired/);
  assert.equal(f.sourcePolicies.length, 0);
});

test("exact Evidence read preserves original UTF-8, role/kind/time, selector, versions and both source/segment policies", async t => {
  const f = await fixture(t), result = await f.execute({ action: "read", ref: f.refs[0] });
  assert.equal(result.status, "read"); if (result.status !== "read") assert.fail();
  assert.equal(result.original.text, f.texts[0]); assert.deepEqual(result.original.ref, f.refs[0]);
  assert.equal(result.original.role, "owner"); assert.equal(result.original.kind, "reported");
  assert.equal(result.original.occurredAt, "2026-07-01T00:00:00Z"); assert.equal(result.authorConfirmation, false); assert.equal(result.publisher, false);
  assert.deepEqual(f.sourcePolicies.sort(), ["synthetic-base", "synthetic-leaf"]);
  assert.equal(result.original.usageConstraints!.length, 2); assert.equal(result.original.usageConstraints![0].quotePolicy, "never_quote");
  assert.equal(result.revision, f.binding.revision); assert.match(result.catalogHash, /^sha256:/);
});

test("missing issuer/config and owner/tool parameters cannot supply source permission or cause filesystem access", async () => {
  for (const configured of [false, true]) {
    let factory: any;
    const plugin = createOrdinaryPlugin();
    plugin.register!({ pluginConfig: { agentId: "main", publisher: false, ...(configured ? { sourceRead: { root: "/nonexistent/synthetic", manifestPath, revision: "a".repeat(40) } } : {}) },
      registerTool(v: unknown) { factory = v; }, registerCommand() {}, on() {} } as unknown as OpenClawPluginApi);
    const tool = factory.create({ agentId: "main", senderIsOwner: true, assertInvocationCurrent() {} }).find((x: any) => x.name === SOURCE_READ_TOOL);
    const result = await tool.execute("synthetic-call", { action: "read", owner: true, sourceRoot: "/forged", ref: { id: "forged", version: "sha256:" + "a".repeat(64) } });
    assert.equal(result.isError, true);
    assert.equal(result.details.code, configured ? "source_request_admission_unavailable" : "source_read_not_configured");
  }
  for (const binding of [{ root: "/tmp", revision: "a".repeat(40), manifestPath: "../escape" }, { root: "/tmp", manifestPath, revision: "HEAD" },
    { root: "relative", manifestPath, revision: "a".repeat(40) }]) assert.throws(() => parseSourceReadBinding(binding), /source_binding_invalid/);
});

test("ordinary v2 tool executes the same read port with server-supplied existing admission; sandbox/workspace and original guard remain enforced", async t => {
  const f = await fixture(t); let factory: any, admissions = 0, active = true;
  const plugin = createOrdinaryPlugin({ async admitSourceRead() { admissions++; return f.admission; } });
  plugin.register!({ pluginConfig: { agentId: "main", sourceRead: f.binding }, runtime: { version: hostVersion },
    registerTool(v: unknown) { factory = v; }, registerCommand() {}, on() {} } as unknown as OpenClawPluginApi);
  const make = (extra = {}) => factory.create({ agentId: "main", assertInvocationCurrent() { assert.ok(active, "closed"); }, ...extra }).find((x: any) => x.name === SOURCE_READ_TOOL);
  assert.equal((await make().execute("read-call", { action: "read", ref: f.refs[0] })).details.original.text, f.texts[0]);
  assert.equal(admissions, 1);
  assert.equal((await make({ sandboxed: true }).execute("sandbox", { action: "list" })).details.code, "source_read_sandbox_unsupported");
  assert.equal((await make({ fsPolicy: { workspaceOnly: true, root: "/unrelated" } }).execute("workspace", { action: "list" })).details.code, "source_read_workspace_denied");
  assert.equal(admissions, 1); active = false;
  await assert.rejects(make().execute("closed", { action: "list" }), /closed/);
});

test("metadata processing denial and semantic source-policy denial are explicit failures, never empty success", async t => {
  const f = await fixture(t);
  await assert.rejects(f.execute({ action: "list" }, { ...f.admission, async assertMetadata() { throw new CatalogError("metadata_processing_denied"); } }), /metadata_processing_denied/);
  assert.equal(f.sourcePolicies.length, 0);
  const denied = { ...f.admission, purpose: { ...f.admission.purpose, sourceAccess: async () => ({ judgment: {
    scenarios: ["social"], trigger: "user_requested" as const, topicRequested: true, topicExplicitlyNamed: true, presentation: "summary" as const }, quoteGrants: [] }) } };
  await assert.rejects(f.execute({ action: "read", ref: f.refs[0] }, denied), /source_scenario_forbidden/);
});

test("explicit revision/clean checkout and exact evidence version cannot silently follow HEAD or working edits", async t => {
  const f = await fixture(t);
  await assert.rejects(executeOrdinarySourceRead({ binding: { ...f.binding, revision: "a".repeat(40) }, agentId: "main", hostVersion, parameters: { action: "list" }, admission: f.admission }), /source_revision_mismatch/);
  await f.put("unrelated-dirty.txt", "synthetic dirty state");
  await assert.rejects(f.execute({ action: "list" }), /source_repository_dirty/); await rm(path.join(f.root, "unrelated-dirty.txt"));
  await assert.rejects(f.execute({ action: "read", ref: { ...f.refs[0], version: "sha256:" + "a".repeat(64) } }), /reference_unavailable/);
  await assert.rejects(f.execute({ action: "read", ref: f.refs[0], confirmation: true }), /source_arguments_invalid/);
});

test("manifest profile disagreement, wrong agent and missing explicit manifest fail without falling back to root YAML", async t => {
  const f = await fixture(t); f.manifest.runtimeState.runtimeProfileRef = "path:wrong.json";
  await f.put(manifestPath, canonicalJson(f.manifest)); f.binding.revision = await f.commit();
  await assert.rejects(f.execute({ action: "list" }), /source_profile_reference_conflict/);
  f.manifest.runtimeState.runtimeProfileRef = `path:${profilePath}`; f.profile.agent_id = "other";
  await f.put(manifestPath, canonicalJson(f.manifest)); await f.put(profilePath, canonicalJson(f.profile)); f.binding.revision = await f.commit();
  await assert.rejects(f.execute({ action: "list" }), /source_profile_binding_mismatch/);
  await assert.rejects(executeOrdinarySourceRead({ binding: { ...f.binding, manifestPath: "missing.json" }, agentId: "main", hostVersion, parameters: { action: "list" }, admission: f.admission }));
});

test("catalog pages bind cursors to exact generation and return all eligible page metadata without semantic ranking", async t => {
  const f = await fixture(t, 33), a = await f.execute({ action: "list" }); if (a.status !== "listed") assert.fail();
  assert.equal(a.items.length, 32); assert.ok(a.nextCursor);
  const b = await f.execute({ action: "list", cursor: a.nextCursor }); if (b.status !== "listed") assert.fail();
  assert.equal(b.items.length, 1); assert.equal(b.nextCursor, null);
  f.catalog.generationId = "synthetic-migration-two"; await f.put(catalogPath, canonicalJson(f.catalog)); f.binding.revision = await f.commit();
  await assert.rejects(f.execute({ action: "list", cursor: a.nextCursor }), /source_cursor_stale/);
});

test("original read enforces temporal cutoff and explicit output capacity; no truncation or fabricated absence", async t => {
  const f = await fixture(t);
  const historical = { ...f.admission, purpose: { ...f.admission.purpose, evidenceCutoff: "2026-06-01T00:00:00Z" } };
  await assert.rejects(f.execute({ action: "read", ref: f.refs[0] }, historical), /evidence_after_cutoff/);
  const metadata = await f.execute({ action: "list" }, historical); if (metadata.status !== "listed") assert.fail();
  assert.equal(metadata.items.length, 0); assert.equal(metadata.excludedByTimeOnPage, 3);
  const big = await fixture(t, 1, 128 * 1024 + 1);
  await assert.rejects(big.execute({ action: "read", ref: big.refs[0] }), /source_output_capacity/);
});

test("UTF-8 original bytes are preserved; an inherited decoder's BOM projection is an explicit unsupported representation", async t => {
  const text = "合成资料：保留尚未回答的问题。\n";
  const plain = await fixture(t, 1, 0, text), result = await plain.execute({ action: "read", ref: plain.refs[0] });
  if (result.status !== "read") assert.fail(); assert.equal(result.original.text, text);
  const bom = await fixture(t, 1, 0, "\uFEFF" + text);
  await assert.rejects(bom.execute({ action: "read", ref: bom.refs[0] }), /source_text_representation_unverified/);
});

test("cancelled or expired original admission cannot be replaced during awaits", async t => {
  const f = await fixture(t), abort = new AbortController(); abort.abort(Error("synthetic cancelled"));
  await assert.rejects(executeOrdinarySourceRead({ binding: f.binding, agentId: "main", hostVersion, parameters: { action: "list" }, admission: f.admission, signal: abort.signal }), /synthetic cancelled/);
  let active = true;
  const admission = { ...f.admission, assertCurrent() { assert.ok(active, "source admission expired"); }, async assertMetadata() {
    active = false; admission.assertCurrent = () => {}; return false as const;
  } };
  await assert.rejects(f.execute({ action: "read", ref: f.refs[0] }, admission), /source admission expired/);
  assert.equal(f.sourcePolicies.length, 0);
  assert.deepEqual(parseOrdinaryConfig({ sourceRead: f.binding }).sourceRead, f.binding);
});

test("request expiry during source judgment stops before any protected payload load", async t => {
  const f = await fixture(t, 1); let active = true, payloadReads = 0;
  const originalRead = CatalogReader.prototype.readPayload;
  CatalogReader.prototype.readPayload = async function (...args) { payloadReads++; return originalRead.apply(this, args); };
  t.after(() => { CatalogReader.prototype.readPayload = originalRead; });
  const admission = { ...f.admission, assertCurrent() { if (!active) throw new CatalogError("request_expired"); },
    purpose: { ...f.admission.purpose, sourceAccess: async (...args: Parameters<NonNullable<typeof f.admission.purpose.sourceAccess>>) => {
      await Promise.resolve(); active = false; return f.admission.purpose.sourceAccess!(...args);
    } } };
  await assert.rejects(f.execute({ action: "read", ref: f.refs[0] }, admission), /request_expired/);
  assert.equal(payloadReads, 0);
});

test("request expiry while reading coverage is checked immediately before the first payload load", async t => {
  const f = await fixture(t, 1); let active = true, payloadReads = 0;
  const originalRead = CatalogReader.prototype.read, originalPayload = CatalogReader.prototype.readPayload;
  CatalogReader.prototype.read = async function (...args) {
    const value = await originalRead.apply(this, args); if (args[1] === "coverage") active = false; return value;
  };
  CatalogReader.prototype.readPayload = async function (...args) { payloadReads++; return originalPayload.apply(this, args); };
  t.after(() => { CatalogReader.prototype.read = originalRead; CatalogReader.prototype.readPayload = originalPayload; });
  await assert.rejects(f.execute({ action: "read", ref: f.refs[0] }, { ...f.admission,
    assertCurrent() { if (!active) throw new CatalogError("request_expired"); } }), /request_expired/);
  assert.equal(payloadReads, 0);
});

test("source references and selectors expose documented fields only", async t => {
  const f = await fixture(t, 1), entry = f.catalog.evidence[0]!;
  const e = JSON.parse(await readFile(path.join(f.root, entry.locator.path), "utf8"));
  e.source.extraPrivateBody = "SYNTHETIC_UNAPPROVED_REFERENCE_BODY";
  const bytes = canonicalJson(e); entry.version = objectVersion(e); entry.locator.sha256 = bytesVersion(bytes);
  f.refs[0] = { id: entry.id, version: entry.version };
  await f.put(entry.locator.path, bytes); await f.put(catalogPath, canonicalJson(f.catalog)); f.binding.revision = await f.commit();
  for (const args of [{ action: "list" }, { action: "read", ref: f.refs[0] }]) {
    const result = await f.execute(args);
    assert.equal(JSON.stringify(result).includes("SYNTHETIC_UNAPPROVED_REFERENCE_BODY"), false);
    const ref = result.status === "read" ? result.sourceRef : result.items[0]!.sourceRef;
    assert.deepEqual(Object.keys(ref).sort(), ["id", "version"]);
    if (result.status === "read") assert.deepEqual(Object.keys(result.locator.selector).sort(), ["kind", "value"]);
  }
});
