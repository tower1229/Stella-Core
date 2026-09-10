import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { OpenClawConfig, OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { registerStellaInitialization } from "../src/openclaw/initialization-registration.js";
import { createFixture, initializeFixtureRepository, prepareInitializationFixture } from "./consciousness-fixture.js";

type GatewayClient = {
  connect: { role: string; scopes?: string[] };
  connId?: string;
  authenticatedUserId?: string | null;
};

type GatewayHandler = (input: {
  params: unknown;
  client: GatewayClient;
  req: { id: string };
  signal: AbortSignal;
  respond: (ok: boolean, payload?: unknown, error?: { code: string; message: string }) => void;
}) => Promise<void>;

async function invokeGateway(
  handler: GatewayHandler,
  params: unknown,
  options: { client?: GatewayClient; signal?: AbortSignal; reqId?: string } = {},
) {
  return new Promise<{ ok: boolean; payload?: unknown; error?: { code: string; message: string } }>((resolve, reject) => {
    handler({
      params,
      client: options.client ?? {
        connect: { role: "operator", scopes: ["operator.admin"] },
        connId: "conn-capability",
        authenticatedUserId: "operator-admin",
      },
      req: { id: options.reqId ?? "req-capability" },
      signal: options.signal ?? new AbortController().signal,
      respond(ok, payload, error) { resolve({ ok, payload, error }); },
    }).catch(reject);
  });
}

test("gateway accept-capability clears one blocker, keeps business closed, and supports invalidate/cancel/auth/G-10", async (t) => {
  const canghaiRoot = await createFixture();
  t.after(() => rm(canghaiRoot, { recursive: true, force: true }));
  await prepareInitializationFixture(canghaiRoot, "stella");
  const profilePath = path.join(canghaiRoot, "50_PersonalAgent/stella/runtime-profile.yaml");
  const profile = parseYaml(await readFile(profilePath, "utf8")) as Record<string, unknown>;
  profile.contract_profile = "full_memory";
  for (const model of Object.values(profile.models as Record<string, { required_capabilities?: string[] }>)) {
    model.required_capabilities = [];
  }
  profile.capabilities = [
    {
      id: "host_initialization", required: true, adapter_id: "stella.openclaw-host-bootstrap", adapter_version: "1",
      config_ref: "path:50_PersonalAgent/stella/praxis-binding.json",
      acceptance_ref: "path:50_PersonalAgent/stella/capability-acceptance.json", required_secret_refs: [],
    },
    {
      id: "memory_access", required: true, adapter_id: "synthetic", adapter_version: "1",
      config_ref: "path:50_PersonalAgent/stella/praxis-binding.json",
      acceptance_ref: "path:50_PersonalAgent/stella/capability-acceptance.json", required_secret_refs: [],
    },
  ];
  await writeFile(profilePath, stringifyYaml(profile));
  const revision = await initializeFixtureRepository(canghaiRoot);

  const temp = await mkdtemp(path.join(os.tmpdir(), "stella-cap-gw-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const workspace = path.join(temp, "workspace");
  const state = path.join(temp, "state");
  await Promise.all([mkdir(workspace), mkdir(state)]);

  const pluginConfig = {
    canghaiRoot, recoveryRevision: revision, manifestPath: "50_PersonalAgent/stella/manifest.yaml", agentId: "stella",
  };
  const hooks = new Map<string, (event: unknown, ctx: unknown) => Promise<unknown>>();
  let service: Parameters<OpenClawPluginApi["registerService"]>[0] | undefined;
  let gatewayHandler: GatewayHandler | undefined;
  const hostConfig: OpenClawConfig = {
    agents: { entries: { stella: { workspace } } },
    plugins: { entries: { "stella-core": { enabled: true, config: pluginConfig } } },
  };
  const api = {
    config: hostConfig,
    source: "synthetic-capability-gateway",
    runtime: {
      version: "2026.8.2",
      config: {
        current: () => hostConfig,
        async mutateConfigFile(input: { mutate(config: OpenClawConfig): unknown }) {
          await input.mutate(hostConfig);
          return {};
        },
      },
      agent: {
        async ensureAgentWorkspace(input: { dir: string }) {
          return { dir: input.dir, bootstrapPending: false };
        },
      },
      gateway: {
        async request(method: string, params: { name?: string }) {
          if (method === "agents.files.list") return { workspace };
          if (method === "skills.status") {
            return {
              workspaceDir: workspace,
              skills: [{
                name: "stella-initialization-probe",
                eligible: true,
                filePath: path.join(workspace, "skills/stella-initialization-probe/SKILL.md"),
              }],
            };
          }
          if (method === "agents.files.get") {
            return { file: { content: await readFile(path.join(workspace, params.name!), "utf8") } };
          }
          throw new Error("unexpected Host method");
        },
      },
    },
    logger: { error() {} },
    registerService(value: typeof service) { service = value; },
    registerCommand() {},
    registerTool() {},
    registerGatewayMethod(_name: string, handler: GatewayHandler) { gatewayHandler = handler; },
    on(name: string, handler: (event: unknown, ctx: unknown) => Promise<unknown>) { hooks.set(name, handler); },
  };

  const initialization = registerStellaInitialization(api as never, pluginConfig, async (method, params) =>
    api.runtime.gateway.request(method, params));
  assert.ok(gatewayHandler);
  await service!.start({ config: api.config, stateDir: state, logger: api.logger } as never);
  await hooks.get("gateway_start")!({}, {});
  assert.equal(initialization.status().state, "ready");
  assert.deepEqual(initialization.status().runtime, {
    state: "blocked",
    blockers: [
      "capability_acceptance_missing:host_initialization",
      "capability_acceptance_missing:memory_access",
    ],
  });
  await assert.rejects(initialization.assertReady(), /runtime_capabilities_unavailable/);

  const denied = await invokeGateway(gatewayHandler!, { action: "accept-capability", runId: "run_denied" }, {
    client: { connect: { role: "operator", scopes: ["operator.read"] }, connId: "conn-denied" },
  });
  assert.equal(denied.ok, false);
  assert.equal(denied.error?.code, "INVALID_REQUEST");

  const aborted = new AbortController();
  aborted.abort();
  const cancelled = await invokeGateway(gatewayHandler!, { action: "accept-capability", runId: "run_cancelled" }, {
    signal: aborted.signal,
  });
  assert.equal(cancelled.ok, false);
  assert.match(cancelled.error?.message ?? "", /operation_cancelled|capability_acceptance_failed/);
  assert.deepEqual(initialization.status().runtime?.blockers, [
    "capability_acceptance_missing:host_initialization",
    "capability_acceptance_missing:memory_access",
  ]);

  const runId = "run_capability_accept";
  const accepted = await invokeGateway(gatewayHandler!, { action: "accept-capability", runId });
  assert.equal(accepted.ok, true, JSON.stringify(accepted));
  const payload = accepted.payload as {
    receipt: {
      id: string; capabilityId: string; adapterId: string; result: string; businessAdmission: boolean;
      mode: string; locator: string; checkedAt: string; expiresAt: string;
    };
    runtime: { state: string; blockers: string[] };
  };
  assert.equal(payload.receipt.capabilityId, "host_initialization");
  assert.equal(payload.receipt.adapterId, "stella.openclaw-host-bootstrap");
  assert.equal(payload.receipt.result, "passed");
  assert.equal(payload.receipt.businessAdmission, false);
  assert.equal(payload.receipt.mode, "constrained_acceptance");
  assert.match(payload.receipt.id, /^cap_[a-f0-9-]{36}$/);
  assert.deepEqual(payload.runtime.blockers, ["capability_acceptance_missing:memory_access"]);
  assert.equal(payload.runtime.state, "blocked");
  await assert.rejects(initialization.assertReady(), /runtime_capabilities_unavailable/);

  const publicJson = JSON.stringify(accepted.payload);
  assert.ok(!publicJson.includes(canghaiRoot));
  assert.ok(!publicJson.includes("/Users/"));
  assert.ok(!publicJson.includes("operator-admin"));
  assert.ok(!publicJson.includes("private"));

  const again = await invokeGateway(gatewayHandler!, { action: "accept-capability", runId }, { reqId: "req-capability-2" });
  assert.equal(again.ok, true, JSON.stringify(again));
  const againPayload = again.payload as { receipt: { id: string }; runtime: { blockers: string[] } };
  assert.deepEqual(againPayload.runtime.blockers, ["capability_acceptance_missing:memory_access"]);
  assert.notEqual(againPayload.receipt.id, payload.receipt.id);

  const badInvalidate = await invokeGateway(gatewayHandler!, {
    action: "invalidate-capability",
    receiptId: "cap_00000000-0000-4000-8000-000000000000",
  });
  assert.equal(badInvalidate.ok, false);
  assert.match(badInvalidate.error?.message ?? "", /capability_receipt_required|invalid_capability_receipt|capability_acceptance_failed/);

  const receiptsRoot = path.join(state, "stella-core", "initialization", "stella", "capability-receipts");
  await mkdir(receiptsRoot, { recursive: true });
  await writeFile(path.join(receiptsRoot, "cap_11111111-1111-4111-8111-111111111111.json"), "{not-json\n");
  const invalidBody = await invokeGateway(gatewayHandler!, {
    action: "invalidate-capability",
    receiptId: "cap_11111111-1111-4111-8111-111111111111",
  });
  assert.equal(invalidBody.ok, false);
  assert.match(invalidBody.error?.message ?? "", /invalid_capability_receipt/);

  for (const receiptId of [payload.receipt.id, againPayload.receipt.id]) {
    const invalidated = await invokeGateway(gatewayHandler!, {
      action: "invalidate-capability",
      receiptId,
    });
    assert.equal(invalidated.ok, true, JSON.stringify(invalidated));
  }
  const afterInvalidate = await invokeGateway(gatewayHandler!, { action: "status" });
  assert.equal(afterInvalidate.ok, true);
  assert.deepEqual((afterInvalidate.payload as { runtime: { blockers: string[] } }).runtime.blockers, [
    "capability_acceptance_missing:host_initialization",
    "capability_acceptance_missing:memory_access",
  ]);
  await assert.rejects(initialization.assertReady(), /runtime_capabilities_unavailable/);

  await service!.stop!({ config: api.config, stateDir: state, logger: api.logger } as never);
});
