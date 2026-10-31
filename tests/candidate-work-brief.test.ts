import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, realpath, rm, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { DRAFT_MARKER, DRAFT_MARKER_BYTES, executeWorkBrief, WORK_BRIEF_TOOL } from "../src/openclaw/candidate-work-brief.js";
import plugin, { parseOrdinaryConfig } from "../src/ordinary-plugin.js";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";

const run = promisify(execFile);
const proposal = { topic: "Synthetic harbor walk", interpretation: "Keep two possible endings open",
  proposedPremises: ["A fictional walk may connect the scenes"], openQuestions: ["Which ending fits?"],
  evidenceReferences: ["synthetic:unverified-reference"] };
const save = (operationId = "create_A", expectedVersion: string | null = null, next = proposal) =>
  ({ action: "save", briefId: "harbor", operationId, expectedVersion, proposal: next });
const read = { action: "read", briefId: "harbor" };
async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "stella-drafts-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = async (...args: string[]) => (await run("git", ["-C", root, ...args])).stdout.trim();
  await git("init", "--quiet", "--initial-branch=main");
  await git("config", "user.name", "Synthetic Draft Test"); await git("config", "user.email", "synthetic@example.invalid");
  await writeFile(path.join(root, DRAFT_MARKER), DRAFT_MARKER_BYTES);
  await git("add", DRAFT_MARKER); await git("commit", "--quiet", "-m", "Synthetic draft baseline");
  let current = true, guards = 0;
  const guard = () => { guards++; if (!current) throw Error("request_closed"); };
  // Each call constructs new repository/ports; no prior factory or qualification cache is reused.
  const invoke = (input: unknown) => executeWorkBrief(root, input, guard);
  return { root, git, invoke, guard, guards: () => guards, close() { current = false; } };
}
test("save, restore in a new request, and versioned modification preserve candidate meaning", async t => {
  const f = await fixture(t), a = await f.invoke(save());
  assert.equal(a.saved, true); assert.equal(a.authorConfirmation, false); assert.equal(a.publisher, false);
  assert.ok("publishedVersion" in a);
  const first = await f.invoke(read); assert.ok("proposal" in first && "version" in first);
  assert.deepEqual(first.proposal, proposal); assert.equal(first.version, a.publishedVersion);
  const next = { ...proposal, interpretation: "The ending remains an open question", openQuestions: ["Keep both endings for now?"] };
  const b = await f.invoke(save("revise_B", first.version, next)); assert.ok("publishedVersion" in b);
  const restored = await f.invoke(read); assert.ok("proposal" in restored && "version" in restored);
  assert.deepEqual(restored.proposal, next); assert.equal(restored.version, b.publishedVersion);
  assert.notEqual(restored.version, first.version); assert.equal(restored.longTermMemory, false);
  const disk = JSON.parse(await readFile(path.join(f.root, "drafts/harbor/current.json"), "utf8"));
  assert.equal(disk.revision.confirmation, "candidate"); assert.equal(disk.revision.previousVersion, first.version);
  assert.equal(disk.content.sources[0].role, "assistant"); assert.deepEqual(disk.content.originalIntent, []);
  assert.deepEqual(disk.content.established, []); assert.equal(disk.content.interpretation, null);
  assert.equal(await f.git("status", "--porcelain"), "");
});
test("stale CAS and operation identity conflicts fail without changing the committed draft", async t => {
  const f = await fixture(t), a = await f.invoke(save()); assert.ok("publishedVersion" in a);
  const next = { ...proposal, openQuestions: ["A newer unresolved question"] };
  await f.invoke(save("revise_B", a.publishedVersion, next)); const before = await f.git("rev-parse", "HEAD");
  await assert.rejects(f.invoke(save("stale_C", a.publishedVersion)), /asset_version_conflict/);
  await assert.rejects(f.invoke(save("create_A", null, next)), /operation_identity_conflict/);
  assert.equal(await f.git("rev-parse", "HEAD"), before); assert.equal(await f.git("status", "--porcelain"), "");
});
test("exact retry is idempotent and an older operation never rolls back the new version", async t => {
  const f = await fixture(t), a = await f.invoke(save()); assert.ok("publishedVersion" in a);
  const same = await f.invoke(save()); assert.ok("replayed" in same); assert.equal(same.replayed, true);
  const b = await f.invoke(save("revise_B", a.publishedVersion, { ...proposal, openQuestions: ["New question"] }));
  assert.ok("publishedVersion" in b);
  const old = await f.invoke(save()); assert.ok("currentVersion" in old);
  assert.equal(old.publishedVersion, a.publishedVersion); assert.equal(old.currentVersion, b.publishedVersion); assert.equal(old.isCurrent, false);
});
test("input cannot add author confirmation, source lookup, paths or an implicit expected version", async t => {
  const f = await fixture(t), before = await f.git("rev-parse", "HEAD");
  for (const input of [{ ...save(), confirmation: "author_confirmed" }, { ...save(), briefId: "../outside" },
    { ...save(), proposal: { ...proposal, requester: "owner" } }, { action: "save", briefId: "harbor", proposal },
    { ...read, proposal }, { ...save(), expectedVersion: "latest" }]) await assert.rejects(f.invoke(input));
  assert.equal(await f.git("rev-parse", "HEAD"), before);
});
test("unverified evidence is retained opaquely, with no file or URL resolution", async t => {
  const f = await fixture(t), next = { ...proposal, evidenceReferences: ["/nonexistent/private/credential", "https://invalid.example/never-request"] };
  await f.invoke(save("create_A", null, next)); const restored = await f.invoke(read);
  assert.ok("proposal" in restored); assert.deepEqual(restored.proposal.evidenceReferences, next.evidenceReferences);
  assert.equal(restored.evidenceStatus, "model_supplied_unverified");
});
test("missing marker, oversized proposal, dirty store and closed invocation fail explicitly", async t => {
  const f = await fixture(t);
  await assert.rejects(f.invoke(save("large", null, { ...proposal, proposedPremises: Array(16).fill("x".repeat(4000)) })), /work_brief_too_large/);
  await writeFile(path.join(f.root, "unexpected.txt"), "synthetic dirt");
  await assert.rejects(f.invoke(save()), /asset_repository_dirty/); await rm(path.join(f.root, "unexpected.txt"));
  await writeFile(path.join(f.root, DRAFT_MARKER), "{}"); await assert.rejects(f.invoke(save()), /work_brief_store_invalid/);
  f.close(); await assert.rejects(f.invoke(save()), /request_closed/);
});
function toolFixture(root?: string, owner: unknown = true) {
  let factory: any, active = true;
  plugin.register!({ pluginConfig: { publisher: false, ...(root ? { candidateDraftsRoot: root } : {}) },
    registerTool(value: unknown) { factory = value; }, registerCommand() {}, on() {},
  } as unknown as OpenClawPluginApi);
  const context = { agentId: "main", senderIsOwner: owner, assertInvocationCurrent() { if (!active) throw Error("closed"); } };
  return { tool: factory.create(context).find((x: any) => x.name === WORK_BRIEF_TOOL), context, close() { active = false; } };
}
test("actual plugin tool restores across fresh factories and keeps publisher off", async t => {
  const f = await fixture(t), a = await toolFixture(f.root).tool.execute("save_A", save());
  assert.equal(a.isError, undefined); assert.equal(a.details.persistenceStatus, "local_committed");
  const b = await toolFixture(f.root).tool.execute("new_request_read", read);
  assert.deepEqual(b.details.proposal, proposal); assert.equal(b.details.version, a.details.publishedVersion);
  assert.equal(b.details.publisher, false);
});
test("new draft tool restricts existing owner context without using it as author proof", async t => {
  const f = await fixture(t);
  for (const owner of [false, null, "true"]) await assert.rejects(toolFixture(f.root, owner).tool.execute("denied", save()), /owner_required/);
  const changed = toolFixture(f.root); changed.context.senderIsOwner = false;
  await assert.rejects(changed.tool.execute("changed", save()), /owner_required/);
  const closed = toolFixture(f.root); closed.close(); closed.context.assertInvocationCurrent = () => {};
  await assert.rejects(closed.tool.execute("closed", save()), /closed/);
  const absent = await toolFixture().tool.execute("not_configured", read); assert.equal(absent.details.code, "work_brief_not_configured");
  assert.throws(() => parseOrdinaryConfig({ candidateDraftsRoot: "relative" }));
});
test("configured drafts cannot escape a workspace-only or sandboxed Host context", async t => {
  const f = await fixture(t);
  let factory: any;
  plugin.register!({ pluginConfig: { candidateDraftsRoot: f.root }, registerTool(value: unknown) { factory = value; },
    registerCommand() {}, on() {},
  } as unknown as OpenClawPluginApi);
  const base = { agentId: "main", senderIsOwner: true, assertInvocationCurrent() {} };
  for (const context of [{ ...base, fsPolicy: { workspaceOnly: true, root: f.root + "-other" } },
    { ...base, fsPolicy: { workspaceOnly: true } }, { ...base, sandboxed: true }]) {
    const tool = factory.create(context).find((x: any) => x.name === WORK_BRIEF_TOOL);
    await assert.rejects(tool.execute("denied", save()), /workspace_denied|sandbox_unsupported/);
  }
  const tool = factory.create({ ...base, fsPolicy: { workspaceOnly: true, root: f.root } }).find((x: any) => x.name === WORK_BRIEF_TOOL);
  assert.equal((await tool.execute("allowed", save())).details.saved, true);
});
