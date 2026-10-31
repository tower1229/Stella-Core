import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Ajv } from "ajv";
import plugin, { CANDIDATE_TOOL, STATUS_TOOL, parseOrdinaryConfig } from "../src/ordinary-plugin.js";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";

const proposal = { topic: "Synthetic writing task", interpretation: "A proposed argument, not a confirmed conclusion",
  proposedPremises: ["A tentative premise"], openQuestions: ["Which conclusion does the author intend?"], evidenceReferences: ["synthetic:unverified"] };
function fixture() {
  let factory: any, command: any, guardCalls = 0, active = true;
  plugin.register!({ pluginConfig: { agentId: "main", publisher: false },
    registerTool(value: unknown) { factory = value; }, registerCommand(value: unknown) { command = value; },
  } as unknown as OpenClawPluginApi);
  const context = { agentId: "main", assertInvocationCurrent() { guardCalls++; if (!active) throw Error("closed"); } };
  const tools = factory.create(context);
  return { tools, factory, context, command, close() { active = false; }, guards: () => guardCalls };
}

test("default package is ordinary and historical config is rejected without importing old runtime", async () => {
  const pkg = JSON.parse(await readFile("package.json", "utf8"));
  assert.equal(pkg.main, "./dist/src/ordinary-plugin.js"); assert.deepEqual(pkg.openclaw.extensions, [pkg.main]);
  const manifest = JSON.parse(await readFile("openclaw.plugin.json", "utf8"));
  assert.equal(manifest.kind, undefined); assert.equal(manifest.providers, undefined);
  const validate = new Ajv({ strict: false }).compile(manifest.configSchema);
  assert.equal(validate({ agentId: "main", publisher: false }), true);
  for (const config of [{ publisher: true }, { canghaiRoot: "/synthetic" }, { agentId: "" }]) {
    assert.equal(validate(config), false); assert.throws(() => parseOrdinaryConfig(config));
  }
  assert.deepEqual(parseOrdinaryConfig({}), { agentId: "main", publisher: false });
  assert.deepEqual(Object.keys(manifest.toolMetadata).sort(), [CANDIDATE_TOOL, STATUS_TOOL].sort());
});

test("registration only contributes guarded ordinary tools and a no-model command", async () => {
  const f = fixture();
  assert.equal(f.factory.contextVersion, 2); assert.equal(f.factory.create({ agentId: "other" }), null);
  assert.equal(f.command.requireAuth, true);
  const status = await f.tools.find((t: any) => t.name === STATUS_TOOL).execute("status", {});
  assert.equal(status.details.publisher, false); assert.equal(status.details.legacyRuntime, "inactive");
  assert.equal(status.details.memory, "host-owned"); assert.equal(status.details.context, "host-owned");
  assert.equal(JSON.parse(f.command.handler().text).modelCalls, false);
});

test("real tool contract returns an unsaved candidate, retaining open questions and unverified evidence", async () => {
  const f = fixture(), tool = f.tools.find((t: any) => t.name === CANDIDATE_TOOL);
  const result = await tool.execute("synthetic-call", proposal);
  assert.equal(result.details.status, "candidate"); assert.equal(result.details.saved, false);
  assert.equal(result.details.authorConfirmation, false); assert.equal(result.details.publisher, false);
  assert.equal(result.details.evidenceStatus, "model_supplied_unverified");
  assert.deepEqual(result.details.proposal, proposal); assert.equal(f.guards(), 2);
  result.details.proposal.openQuestions.push("mutated"); assert.equal(proposal.openQuestions.length, 1);
});

test("spoofed confirmation, missing fields and oversized input are rejected", async () => {
  const tool = fixture().tools.find((t: any) => t.name === CANDIDATE_TOOL);
  for (const input of [{ ...proposal, confirmed: true }, {}, { ...proposal, interpretation: "x".repeat(4001) },
    { ...proposal, evidenceReferences: Array(17).fill("x") }]) {
    const result = await tool.execute("invalid", input); assert.equal(result.isError, true); assert.equal(result.details.status, "rejected");
  }
});

test("closed invocation, replaced guard and cancellation cannot return a candidate", async () => {
  const f = fixture(), tool = f.tools.find((t: any) => t.name === CANDIDATE_TOOL);
  f.close(); f.context.assertInvocationCurrent = () => {};
  await assert.rejects(tool.execute("closed", proposal), /closed/);
  const signal = AbortSignal.abort(Error("cancelled"));
  await assert.rejects(fixture().tools[1].execute("cancelled", proposal, signal), /cancelled/);
});
