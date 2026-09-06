import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { startExactHostGateway } from "./lib/exact-host-gateway.mjs";
import { runExactHostEvaluationChat } from "../dist/src/acceptance/exact-host-chat.js";

const { values } = parseArgs({ options: Object.fromEntries(["host-root", "adapter", "canghai-root", "canghai-revision"].map((key) => [key, { type: "string" }])) });
for (const key of ["host-root", "adapter", "canghai-root", "canghai-revision"]) assert.ok(values[key], `Required: --${key}`);
const hostRoot = path.resolve(values["host-root"]);
const hostVersion = JSON.parse(await readFile(path.join(hostRoot, "package.json"), "utf8")).version;
assert.equal(hostVersion, "2026.8.2");
const root = await mkdtemp(path.join(os.tmpdir(), "stella-gemini-capability-"));
const state = path.join(root, "state"); await mkdir(state);
const configPath = path.join(state, "openclaw.json");
await writeFile(configPath, "{}", { mode: 0o600 });
const hostEnv = { OPENCLAW_STATE_DIR: state, OPENCLAW_CONFIG_PATH: configPath };
const adapter = await import(pathToFileURL(path.resolve(values.adapter)).href);
const harness = await adapter.createEvaluationHarness({ agentId: "main", canghaiRoot: path.resolve(values["canghai-root"]),
  canghaiRevision: values["canghai-revision"], dataMode: "read_only", hostEnv, hostVersion,
  runtimeStateRoot: state, consumerRoot: root, openclawBin: path.join(hostRoot, "openclaw.mjs") });
const config = JSON.parse(await readFile(configPath, "utf8"));
const agentId = harness.judgeAgentId;
assert.ok(agentId && agentId !== "main");
assert.equal(config.agents.entries[agentId].model, "google/gemini-3.1-pro-preview");
// Provider discovery is itself a bundled plugin. Allow only Google, without
// Stella or business plugins, so repository context cannot enter this probe.
config.plugins = { enabled: true, allow: ["google"], entries: { google: { enabled: true }, "stella-core": { enabled: false } } };
await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
process.stderr.write(`Gemini capability evidence: ${root}\n`);
const { GatewayClient } = await import(pathToFileURL(path.join(hostRoot, "dist/plugin-sdk/gateway-runtime.js")).href);
let client, gateway;
const events = []; const listeners = new Set();
const observations = [];
const secretValues = [];
function collectSecrets(value) {
  if (!value || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value)) {
    if (/key|token|password|secret/i.test(key) && typeof item === "string" && item.length > 4) secretValues.push(item);
    else collectSecrets(item);
  }
}
collectSecrets(config); collectSecrets(hostEnv);
for (const key of ["GEMINI_API_KEY", "GOOGLE_API_KEY"]) if (process.env[key]) secretValues.push(process.env[key]);
const redact = (value) => {
  let text = String(value ?? "");
  for (const secret of secretValues) text = text.replaceAll(secret, "<REDACTED>");
  return text.replace(/https?:\/\/\S+|AIza[\w-]+|Bearer\s+\S+/g, "<REDACTED>").slice(0, 2000);
};
try {
  gateway = await startExactHostGateway({ cwd: root, env: hostEnv, openclawBin: path.join(hostRoot, "openclaw.mjs") });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("gemini_probe_connection_timeout")), 15_000);
    client = new GatewayClient({ url: `ws://127.0.0.1:${gateway.env.OPENCLAW_GATEWAY_PORT}`, token: gateway.env.OPENCLAW_GATEWAY_TOKEN,
      env: gateway.env, clientName: "cli", mode: "cli", role: "operator", scopes: ["operator.admin"], sharedStateMode: "read-only", deviceIdentity: null,
      onHelloOk() { clearTimeout(timer); resolve(); }, onConnectError() { clearTimeout(timer); reject(new Error("gemini_probe_connection_failed")); },
      onEvent(event) { if (event.event === "chat") events.push(event); for (const listener of listeners) listener(event); } });
    client.start();
  });
  const id = randomUUID();
  const expected = { probe: id, status: "ok", values: [3, 5, 8] };
  const result = await runExactHostEvaluationChat({ request: async (method, params) => {
    const response = await client.request(method, params, { timeoutMs: 35_000 });
    observations.push({ method, runId: response.runId, status: response.status, error: redact(response.error) });
    return response;
  },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); } }, {
    sessionKey: `agent:${agentId}:capability-${id}`, idempotencyKey: id,
    message: `This is a synthetic connectivity and JSON-output test. Return exactly this JSON object, without markdown or any other text: ${JSON.stringify(expected)}` });
  assert.deepEqual(JSON.parse(result.text), expected);
  const finals = events.filter((event) => event.payload?.runId === result.runId && event.payload?.state === "final");
  assert.equal(finals.length, 1);
  // Native final envelopes can omit provider metadata. Verify the persisted
  // assistant event in this fresh, single-request agent database instead.
  const db = new DatabaseSync(path.join(state, "agents", agentId, "agent", "openclaw-agent.sqlite"), { readOnly: true });
  let assistant;
  try {
    const replies = db.prepare("SELECT event_json FROM transcript_events").all()
      .map((row) => JSON.parse(row.event_json)).filter((event) => event.type === "message" && event.message?.role === "assistant");
    assert.equal(replies.length, 1);
    assistant = replies[0].message;
    assert.equal(assistant.provider, "google");
    assert.equal(assistant.model, "gemini-3.1-pro-preview");
    assert.equal(assistant.content.filter((part) => part.type === "text").map((part) => part.text).join("\n"), result.text);
  } finally { db.close(); }
  const receipt = { schemaVersion: "stella.gemini-capability-probe/v1", hostVersion, configuredModel: "google/gemini-3.1-pro-preview",
    transport: "chat.send", runId: result.runId, singleNativeFinal: true, strictJsonMatched: true, privateContextSent: false,
    responseSha256: createHash("sha256").update(result.text).digest("hex"),
    observedProvider: assistant.provider, observedModel: assistant.model, persistedAssistantMatched: true,
    scope: "provider connectivity and exact JSON echo only; not complete structured semantic capability, private recovery or learning acceptance" };
  await writeFile(path.join(root, "receipt.json"), JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify(receipt));
} catch (error) {
  await writeFile(path.join(root, "failure.json"), JSON.stringify({ schemaVersion: "stella.gemini-capability-failure/v1",
    category: /^evaluation_chat_[a-z_]+$/.test(error.message ?? "") ? error.message : "gemini_probe_failed",
    submissionsNotRetried: true, privateContextSent: false, observations, error: redact(error.message) }, null, 2));
  throw new Error("Gemini capability probe failed; inspect isolated evidence, no request replayed");
} finally {
  await client?.stopAndWait({ timeoutMs: 2_000 });
  await gateway?.stop();
}
