import assert from "node:assert/strict";
import test from "node:test";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { resolveCommandAuthorization } from "openclaw/plugin-sdk/command-auth-native";
import plugin from "../src/plugin.js";
import { resolveCheckpointRequestIdentity } from "../src/openclaw/checkpoint-request-identity.js";

test("native command authorization and exact device binding survive the SDK facade change", () => {
  const device = "e".repeat(64);
  const ctx = { Provider: "webchat", Surface: "webchat", ChatType: "direct", CommandAuthorized: true,
    GatewayClientScopes: ["operator.admin"], SessionCreation: { via: "operator" as const }, ApprovalReviewerDeviceId: device };
  const config = { webchatOwnerDeviceId: device };
  const admitted = resolveCheckpointRequestIdentity(ctx, {}, config);
  assert.equal(admitted.senderId, `openclaw-device:${device}`);
  assert.equal(admitted.kind, "gateway_device");
  assert.equal(admitted.toolSenderId, undefined);
  assert.equal(resolveCommandAuthorization({ ctx, cfg: {}, commandAuthorized: true }).senderId, undefined);

  // These are changing synthetic Host facts, not a model-supplied context or a
  // modification to a real device, profile, permission, or processing grant.
  ctx.GatewayClientScopes = [];
  assert.throws(() => resolveCheckpointRequestIdentity(ctx, {}, config), /private_context_audience_forbidden/);
  ctx.GatewayClientScopes = ["operator.admin"];
  ctx.ApprovalReviewerDeviceId = "f".repeat(64);
  assert.throws(() => resolveCheckpointRequestIdentity(ctx, {}, config), /checkpoint_webchat_device_not_bound/);
});

test("new Host rejects the unported legacy coordinator before registering or accessing memory", () => {
  const api = { pluginConfig: { recoveryAuthority: "legacy_config" }, runtime: { version: "2026.10.7" } } as unknown as OpenClawPluginApi;
  assert.throws(() => plugin.register(api), /legacy_host_version_unsupported/);
});
