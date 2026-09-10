import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createFixture, initializeFixtureRepository, prepareInitializationFixture } from "../.test-dist/tests/consciousness-fixture.js";
import { startExactHostGateway } from "./lib/exact-host-gateway.mjs";

const run = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
const packageRoot = path.resolve(process.env.STELLA_PROBE_PACKAGE_ROOT ?? root);
const hostRoot = path.resolve(process.env.STELLA_PROBE_HOST_ROOT ?? path.join(root, "node_modules/openclaw"));
const { GatewayClient } = await import(pathToFileURL(path.join(hostRoot, "dist/plugin-sdk/gateway-runtime.js")).href);
const host = JSON.parse(await readFile(path.join(hostRoot, "package.json"), "utf8"));
assert.equal(host.version, "2026.8.2");

const temp = await mkdtemp(path.join(os.tmpdir(), "stella-capability-acceptance-"));
process.stderr.write(`Capability acceptance evidence: ${temp}\n`);
const snapshotParent = path.join(packageRoot, ".artifacts");
await mkdir(snapshotParent, { recursive: true });
const coreSnapshot = await mkdtemp(path.join(snapshotParent, "capability-probe-build-"));
const coreDist = path.join(coreSnapshot, "dist");
await cp(path.join(packageRoot, "dist"), coreDist, { recursive: true });
await cp(path.join(packageRoot, "schemas"), path.join(coreSnapshot, "schemas"), { recursive: true });
const buildModule = (relative) => pathToFileURL(path.join(coreDist, relative)).href;

const canghaiRoot = await createFixture();
await prepareInitializationFixture(canghaiRoot, "probe");
const profilePath = path.join(canghaiRoot, "50_PersonalAgent/stella/runtime-profile.yaml");
const profile = parseYaml(await readFile(profilePath, "utf8"));
profile.agent_id = "probe";
profile.contract_profile = "full_memory";
for (const model of Object.values(profile.models ?? {})) {
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

const state = path.join(temp, "state");
const plugin = path.join(temp, "plugin");
const workspace = path.join(temp, "workspace");
await Promise.all([state, plugin, workspace].map((directory) => mkdir(directory)));
await writeFile(path.join(workspace, "AGENTS.md"), "Synthetic capability acceptance probe. No tools or private data.\n");
await writeFile(path.join(plugin, "package.json"), JSON.stringify({
  name: "stella-capability-probe", version: "0.0.0", type: "module", openclaw: { extensions: ["./index.mjs"] },
}));
await writeFile(path.join(plugin, "openclaw.plugin.json"), await readFile(path.join(packageRoot, "openclaw.plugin.json")));
await writeFile(path.join(plugin, "index.mjs"), `
import main from ${JSON.stringify(buildModule("src/plugin.js"))};
export default main;
`);

const provider = createServer((_request, response) => {
  response.statusCode = 500;
  response.end("capability acceptance must not call a model");
});
await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
const configPath = path.join(state, "openclaw.json");
await writeFile(configPath, JSON.stringify({
  gateway: { mode: "local" },
  agents: { defaults: { model: { primary: "stella-smoke/probe" } }, entries: { probe: { workspace } } },
  models: { providers: { "stella-smoke": {
    baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, apiKey: "synthetic-local-only",
    api: "openai-completions", models: [{ id: "probe", name: "probe", contextWindow: 32768, maxTokens: 256 }],
  } } },
  plugins: {
    allow: ["stella-core"], load: { paths: [plugin] },
    entries: { "stella-core": {
      enabled: true,
      llm: { allowAgentIdOverride: true },
      hooks: { allowConversationAccess: true },
      config: {
        canghaiRoot, recoveryRevision: revision, agentId: "probe",
        initializationGatewayAccess: "local_operator_read", dataMode: "read_only",
      },
    } },
  },
  tools: { allow: ["read", "stella_initialize"] },
}));
const env = { ...process.env, OPENCLAW_STATE_DIR: state, OPENCLAW_CONFIG_PATH: configPath };
delete env.NODE_OPTIONS;

let gateway;
let admin;
let visitor;
try {
  gateway = await startExactHostGateway({ cwd: temp, env, openclawBin: path.join(hostRoot, "openclaw.mjs") });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Capability admin observer timeout")), 15_000);
    admin = new GatewayClient({
      url: `ws://127.0.0.1:${gateway.env.OPENCLAW_GATEWAY_PORT}`, token: gateway.env.OPENCLAW_GATEWAY_TOKEN,
      env: gateway.env, clientName: "cli", mode: "cli", role: "operator", scopes: ["operator.admin"],
      sharedStateMode: "read-only", deviceIdentity: null,
      onHelloOk() { clearTimeout(timeout); resolve(); },
      onConnectError() { clearTimeout(timeout); reject(new Error("Capability admin observer failed")); },
    });
    admin.start();
  });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Capability visitor observer timeout")), 15_000);
    visitor = new GatewayClient({
      url: `ws://127.0.0.1:${gateway.env.OPENCLAW_GATEWAY_PORT}`, token: gateway.env.OPENCLAW_GATEWAY_TOKEN,
      env: gateway.env, clientName: "cli", mode: "cli", role: "operator", scopes: ["operator.read"],
      sharedStateMode: "read-only", deviceIdentity: null,
      onHelloOk() { clearTimeout(timeout); resolve(); },
      onConnectError() { clearTimeout(timeout); reject(new Error("Capability visitor observer failed")); },
    });
    visitor.start();
  });

  let status = await admin.request("stella.initialize", { action: "status" });
  for (let attempt = 0; status.state === "initializing" && attempt < 100; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    status = await admin.request("stella.initialize", { action: "status" });
  }
  assert.equal(status.state, "ready", JSON.stringify(status));
  assert.deepEqual(status.runtime?.blockers?.sort(), [
    "capability_acceptance_missing:host_initialization",
    "capability_acceptance_missing:memory_access",
  ].sort());

  assert.equal((await admin.request("stella.initialize", { action: "apply" })).state, "ready");

  await assert.rejects(
    visitor.request("stella.initialize", { action: "accept-capability", runId: "run_capability_visitor" }),
    /INVALID_REQUEST|operator\.admin|Initialization requires/,
  );

  const accepted = await admin.request("stella.initialize", {
    action: "accept-capability", runId: "run_capability_accept",
  });
  assert.equal(accepted.receipt.capabilityId, "host_initialization");
  assert.equal(accepted.receipt.adapterId, "stella.openclaw-host-bootstrap");
  assert.equal(accepted.receipt.result, "passed");
  assert.equal(accepted.receipt.businessAdmission, false);
  assert.equal(accepted.receipt.mode, "constrained_acceptance");
  assert.match(accepted.receipt.id, /^cap_[a-f0-9-]{36}$/);
  assert.deepEqual(accepted.runtime.blockers, ["capability_acceptance_missing:memory_access"]);
  const publicJson = JSON.stringify(accepted);
  assert.ok(!publicJson.includes(canghaiRoot));
  assert.ok(!publicJson.includes("/Users/"));
  assert.ok(!/[\u4e00-\u9fff]{8,}/.test(publicJson));

  const invalidated = await admin.request("stella.initialize", {
    action: "invalidate-capability", receiptId: accepted.receipt.id,
  });
  assert.equal(invalidated.invalidated, accepted.receipt.id);
  assert.deepEqual(invalidated.runtime.blockers.sort(), [
    "capability_acceptance_missing:host_initialization",
    "capability_acceptance_missing:memory_access",
  ].sort());

  const report = {
    schemaVersion: "stella.capability-acceptance-probe/v1",
    host: host.version,
    fixture: "synthetic",
    capabilityId: "host_initialization",
    receiptId: accepted.receipt.id,
    clearedOneBlocker: true,
    businessAdmission: false,
    invalidated: true,
    visitorDenied: true,
  };
  await writeFile(path.join(temp, "capability-acceptance-probe.json"), JSON.stringify(report, null, 2));
  process.stdout.write(`${JSON.stringify(report)}\n`);
} finally {
  try { admin?.stop?.(); } catch { /* ignore */ }
  try { visitor?.stop?.(); } catch { /* ignore */ }
  await gateway?.stop?.();
  await new Promise((resolve) => provider.close(resolve));
}
