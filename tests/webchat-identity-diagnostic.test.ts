import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { deviceRequesterId, profileRequesterId, resolveCheckpointRequestIdentity, registerCheckpointIdentityDiagnostic } from "../src/openclaw/checkpoint-request-identity.js";
import { parseCheckpointPluginConfig } from "../src/openclaw/checkpoint-plugin-runtime.js";
import { createPersonalContextAccess, loadPersonalContextAccess } from "../src/canghai/personal-context-access.js";
import { Ajv } from "ajv";
import { readFile } from "node:fs/promises";
import { resolveCommandAuthorization } from "openclaw/plugin-sdk/command-auth-native";
import { assertInitialOwnerTranscript } from "../src/openclaw/checkpoint-host-request.js";
import { snapshotTurnRequest } from "../src/openclaw/turn-request.js";
import { nativeProfileCaller } from "./openclaw-native-caller-fixture.js";

// Entirely synthetic. Never reads a real session, source, credential or profile.
test("public WebChat admin ownership does not manufacture a transport sender", () => {
  const authorization = resolveCommandAuthorization({ cfg: {}, commandAuthorized: true, ctx: { Provider: "webchat", Surface: "webchat", ChatType: "direct", GatewayClientScopes: ["operator.admin"] } });
  assert.equal(authorization.senderIsOwner, true);
  assert.equal(authorization.senderId, undefined);
});

test("authorizing a current profile must not adopt unknown prior conversation", () => {
  const request = snapshotTurnRequest({ agentId: "synthetic", sessionKey: "agent:synthetic:identity", sessionId: "synthetic-session", prompt: "Synthetic current input",
    senderId: "openclaw-profile:synthetic-profile", senderIsOwner: true, chatType: "direct" }, "synthetic-profile-run");
  assert.throws(() => assertInitialOwnerTranscript([{ type: "message", message: { role: "assistant", content: "Synthetic unknown prior content" } }], request), /checkpoint_agent_history_owner_unknown/);
  for (const version of [3, 4]) assert.doesNotThrow(() => assertInitialOwnerTranscript([
    { type: "session", version, id: request.sessionId, timestamp: "2026-10-27T00:00:00.000Z", cwd: "/tmp/synthetic-workspace" },
  ], request));
});

const profileId = "synthetic-profile", requester = "openclaw-profile:" + profileId;
const envelope = () => nativeProfileCaller(profileId).ctx;
const resolve = (ctx: any = envelope(), selected: string | undefined = profileId) => resolveCheckpointRequestIdentity(ctx, {}, { webchatOwnerProfileId: selected });

test("a current trusted profile requires exact owner selection, without manufacturing a Host sender", () => {
  const ctx: any = envelope(), identity = resolve(ctx);
  assert.equal(identity.senderId, requester); assert.equal(identity.kind, "gateway_profile");
  assert.equal(identity.toolSenderId, undefined); assert.equal(ctx.SenderId, undefined);
  assert.throws(() => resolve(ctx, "another-profile"), /checkpoint_webchat_profile_not_bound/);
  assert.throws(() => resolveCheckpointRequestIdentity(ctx, {}, {}), /checkpoint_webchat_profile_not_bound/);
});

test("a revoked native profile capability cannot reuse a profile stamp or admin scope", () => {
  const { ctx, revoke } = nativeProfileCaller(profileId);
  assert.equal(resolve(ctx).senderId, requester);
  revoke();
  assert.equal(ctx.SenderId, undefined);
  assert.throws(() => resolve(ctx), /checkpoint_webchat_profile_required/);
});

test("missing profile, device names and untrusted claims never fill the profile principal", () => {
  for (const actor of [undefined, { type: "human", source: "unknown", id: profileId }, { type: "agent", id: profileId }, { type: "human", source: "profile", id: "" }]) {
    const ctx: any = { ...envelope(), SessionCreation: { via: "operator", actor }, SenderName: profileId, ApprovalReviewerDeviceId: profileId };
    assert.throws(() => resolve(ctx), /checkpoint_webchat_profile_required/);
  }
  assert.throws(() => resolve({ ...envelope(), GatewayClientScopes: [] }), /private_context_audience_forbidden/);
  assert.throws(() => resolve({ ...envelope(), ChatType: "group" }), /private_context_audience_forbidden/);
  assert.throws(() => resolve({ ...envelope(), SenderId: requester }), /private_context_audience_forbidden/);
});

test("existing transport identities remain exact and do not need profile configuration", () => {
  const ctx: any = { Provider: "webchat", Surface: "webchat", ChatType: "direct", GatewayClientScopes: ["operator.admin"], SenderId: "cli" };
  const identity = resolveCheckpointRequestIdentity(ctx, {}, {});
  assert.equal(identity.kind, "transport"); assert.equal(identity.senderId, "cli"); assert.equal(identity.toolSenderId, "cli");
});

test("source processing grant remains a separate exact authorization", async t => {
  const root = await mkdtemp("/tmp/stella-synthetic-profile-grant-"); t.after(() => rm(root, { recursive: true, force: true }));
  const purpose = { readPurpose: "retrieve", derivePurpose: "answer", deliveryScope: "owner-direct" };
  const grant = { schemaVersion: "stella.personal-context-access/v1", ownerId: "synthetic-owner", requesterIds: ["synthetic-telegram-owner"],
    modelRefs: ["google/gemini-3.8-flash"], purpose, descriptors: [] };
  const request = snapshotTurnRequest({ agentId: "synthetic", sessionKey: "agent:synthetic:identity", sessionId: "synthetic-session", prompt: "Synthetic input",
    senderId: requester, senderIsOwner: true, chatType: "direct" }, "synthetic-run");
  let llmCalls = 0;
  const create = async () => createPersonalContextAccess({ request, modelRef: "google/gemini-3.8-flash", binding: await loadPersonalContextAccess(root, "access.json"),
    async assertRequestCurrent() {}, async complete() { llmCalls++; throw Error("No LLM permitted"); } });
  await writeFile(root + "/access.json", JSON.stringify(grant)); await assert.rejects(create, /personal_context_requester_forbidden/);
  grant.requesterIds.push(requester); await writeFile(root + "/access.json", JSON.stringify(grant));
  assert.equal(typeof await create(), "function"); assert.equal(llmCalls, 0);
});

test("identity RPC touches only the actual caller metadata, with no runtime or source access", async () => {
  let handler: Function | undefined, options: unknown;
  const api = { registerGatewayMethod(name: string, fn: Function, opts: unknown) { assert.equal(name, "stella.identity"); handler = fn; options = opts; },
    get runtime() { throw Error("Identity diagnostic must not read runtime config, source, state or LLM"); } } as unknown as OpenClawPluginApi;
  registerCheckpointIdentityDiagnostic(api); assert.deepEqual(options, { scope: "operator.admin", profileAccess: "independent" });
  const call = async (params: any, client: any) => { let result: any; await handler!({ params, client, respond: (ok: boolean, payload: any, error: any) => { result = { ok, payload, error }; } }); return result; };
  const client = { connect: { role: "operator", scopes: ["operator.admin"], client: { id: "openclaw-control-ui" } }, authenticatedUserProfile: { profileId, displayName: "Not disclosed", linkedEmails: ["not-disclosed.invalid"] } };
  const result = await call({}, client); assert.equal(result.ok, true); assert.equal(result.payload.requesterId, requester);
  assert.doesNotMatch(JSON.stringify(result), /Not disclosed|not-disclosed/);
  assert.equal(result.payload.sourceAuthorization, "not_checked");
  const missing = await call({}, { ...client, authenticatedUserProfile: undefined });
  assert.equal(missing.ok, true); assert.equal(missing.payload.profileStatus, "missing"); assert.equal(missing.payload.deviceStatus, "missing");
  assert.equal(missing.payload.requesterId, undefined);
  const deviceId = "a".repeat(64), device = await call({}, { connect: { ...client.connect, device: { id: deviceId } } });
  assert.equal(device.ok, true); assert.equal(device.payload.deviceId, deviceId);
  assert.equal(device.payload.deviceRequesterId, deviceRequesterId(deviceId)); assert.equal(device.payload.profileStatus, "missing");
  assert.equal((await call({}, { ...client, connect: { ...client.connect, scopes: [] } })).error.message, "checkpoint_identity_operator_required");
  assert.equal((await call({ profileId: "forged" }, client)).error.code, "INVALID_REQUEST");
  assert.equal((await call({}, { ...client, connect: { ...client.connect, role: "node" } })).error.message, "checkpoint_identity_operator_required");
});

const deviceId = "d".repeat(64);
const deviceEnvelope = () => ({ Provider: "webchat", Surface: "webchat", ChatType: "direct", CommandAuthorized: true,
  GatewayClientScopes: ["operator.admin"], SessionCreation: { via: "operator" as const }, ApprovalReviewerDeviceId: deviceId });
const deviceConfig = { webchatOwnerDeviceId: deviceId };
test("explicit device identity consumes current public Host device facts without aliasing a person or transport", () => {
  const ctx = deviceEnvelope(), identity = resolveCheckpointRequestIdentity(ctx, {}, deviceConfig);
  assert.equal(identity.kind, "gateway_device"); assert.equal(identity.senderId, "openclaw-device:" + deviceId);
  assert.equal(identity.toolSenderId, undefined); assert.equal("SenderId" in ctx, false);
  assert.throws(() => resolveCheckpointRequestIdentity(ctx, {}, {}), /checkpoint_webchat_profile_required/);
  assert.throws(() => resolveCheckpointRequestIdentity(ctx, {}, { ...deviceConfig, webchatOwnerProfileId: profileId }), /checkpoint_configuration_invalid/);
});

test("device owner admission refuses missing, mismatched and non-WebChat or profiled claims", () => {
  for (const override of [
    { ApprovalReviewerDeviceId: undefined }, { ApprovalReviewerDeviceId: "claimed-device" }, { ApprovalReviewerDeviceId: "c".repeat(64) },
    { GatewayClientScopes: [] }, { ChatType: "group" }, { CommandAuthorized: false }, { Surface: "telegram" },
    { SessionCreation: undefined }, { SessionCreation: { via: "run" } },
    { SessionCreation: envelope().SessionCreation }, { SessionCreation: { via: "operator", actor: { type: "agent", id: "synthetic" } } },
    { SenderId: "cli" }, { OriginatingChannel: "telegram" },
  ]) assert.throws(() => resolveCheckpointRequestIdentity({ ...deviceEnvelope(), ...override } as any, {}, deviceConfig));
  for (const prefix of ["openclaw-device:", "openclaw-profile:"]) assert.throws(() => resolveCheckpointRequestIdentity({
    ...deviceEnvelope(), SenderId: prefix + deviceId,
  }, {}, {}), /private_context_audience_forbidden/);
  assert.equal(deviceRequesterId("a".repeat(63)), undefined);
});

test("profile binding is optional, validated and restricted to checkpoint configuration", async () => {
  const value = { recoveryAuthority: "core_checkpoint", checkpointStateDirectory: "/synthetic/state", canghaiRoot: "/synthetic/source", dataMode: "read_only", webchatOwnerProfileId: profileId };
  assert.equal(parseCheckpointPluginConfig(value).webchatOwnerProfileId, profileId);
  for (const invalid of ["", " spaced ", "bad\nprofile", 7, "x".repeat(513)]) assert.throws(() => parseCheckpointPluginConfig({ ...value, webchatOwnerProfileId: invalid }), /checkpoint_configuration_invalid/);
  assert.equal(profileRequesterId("bad\nprofile"), undefined);
  const manifest = JSON.parse(await readFile("legacy/openclaw.plugin.json", "utf8"));
  const validate = new Ajv({ strict: false }).compile(manifest.configSchema);
  assert.equal(validate(value), true, JSON.stringify(validate.errors));
  assert.equal(validate({ ...value, recoveryAuthority: "legacy_config", recoveryRevision: "a".repeat(40) }), false);
  const { webchatOwnerProfileId: _profileId, ...base } = value;
  const device = { ...base, agentMemory: "fresh_tools", webchatOwnerDeviceId: deviceId };
  assert.equal(parseCheckpointPluginConfig(device).webchatOwnerDeviceId, deviceId);
  assert.equal(validate(device), true, JSON.stringify(validate.errors));
  for (const invalid of ["", "a".repeat(63), "A".repeat(64), 7, "a".repeat(64) + "\n"]) {
    assert.throws(() => parseCheckpointPluginConfig({ ...device, webchatOwnerDeviceId: invalid }), /checkpoint_configuration_invalid/);
    assert.equal(validate({ ...device, webchatOwnerDeviceId: invalid }), false);
  }
  assert.throws(() => parseCheckpointPluginConfig({ ...value, webchatOwnerDeviceId: deviceId }), /checkpoint_configuration_invalid/);
  assert.equal(validate({ ...value, webchatOwnerDeviceId: deviceId }), false);
  assert.equal(validate({ ...device, recoveryAuthority: "legacy_config", recoveryRevision: "a".repeat(40) }), false);
});
