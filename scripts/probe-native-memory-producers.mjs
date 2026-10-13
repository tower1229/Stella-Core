import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { startExactHostGateway } from "./lib/exact-host-gateway.mjs";

// Produce native artifacts through public Host lifecycles. Core consumption is
// tested separately against these retained bytes, never against a hand-written
// imitation of a session summary or a wiki compiler output.
const root = fileURLToPath(new URL("../", import.meta.url));
const packageRoot = path.resolve(process.env.STELLA_PROBE_PACKAGE_ROOT ?? root);
const hostRoot = path.resolve(process.env.STELLA_PROBE_HOST_ROOT ?? path.join(root, "node_modules/openclaw"));
assert.equal(JSON.parse(await readFile(path.join(hostRoot, "package.json"))).version, "2026.8.2");
const { GatewayClient } = await import(pathToFileURL(path.join(hostRoot, "dist/plugin-sdk/gateway-runtime.js")).href);
const { runExactHostEvaluationChat } = await import(pathToFileURL(path.join(packageRoot, "dist/src/acceptance/exact-host-chat.js")).href);
const temp = await mkdtemp(path.join(os.tmpdir(), "stella-native-producers-"));
const state = path.join(temp, "state"), workspace = path.join(temp, "workspace"), vault = path.join(temp, "vault");
await Promise.all([state, workspace, vault].map(directory => mkdir(directory)));
await mkdir(path.join(workspace, "memory"));
await writeFile(path.join(workspace, "AGENTS.md"), "Synthetic native producer acceptance.\n");
await writeFile(path.join(workspace, "memory/retained.md"), "SYNTHETIC_ALLOWED_FRAGMENT\n");
const wikiInput = path.join(temp, "wiki-input.md");
await writeFile(wikiInput, "# Synthetic retained observation\n\nSYNTHETIC_ALLOWED_FRAGMENT\n");
const inputs = [];
let failure, client, gateway;
const listeners = new Set();
const provider = createServer(async (request, response) => {
  try {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const input = JSON.parse(Buffer.concat(chunks)); inputs.push(input);
    assert.ok(inputs.length <= 3);
    await writeFile(path.join(temp, `producer-model-${inputs.length}.json`), JSON.stringify(input, null, 2));
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ id: "native-producer", object: "chat.completion", created: 1, model: "probe",
      choices: [{ index: 0, message: { role: "assistant", content: "SYNTHETIC_ALLOWED_FRAGMENT" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
  } catch (error) { failure ??= error; response.writeHead(400); response.end("{}"); }
});
try {
  await new Promise((resolve, reject) => { provider.once("error", reject); provider.listen(0, "127.0.0.1", resolve); });
  const configPath = path.join(state, "openclaw.json");
  await writeFile(configPath, JSON.stringify({ gateway: { mode: "local" },
    agents: { defaults: { model: { primary: "stella-native/probe" } }, entries: { probe: { workspace } } },
    models: { providers: { "stella-native": { api: "openai-completions", baseUrl: `http://127.0.0.1:${provider.address().port}/v1`,
      apiKey: "synthetic-local-only", models: [{ id: "probe", name: "synthetic", contextWindow: 32768, maxTokens: 256 }] } } },
    hooks: { internal: { enabled: true, entries: { "session-memory": { enabled: true, messages: 25, llmSlug: false } } } },
    plugins: { allow: ["memory-core", "memory-wiki"], entries: {
      "memory-core": { enabled: true, config: { dreaming: { enabled: false } } },
      "memory-wiki": { enabled: true, config: { vaultMode: "isolated", vault: { scope: "global", path: vault },
        obsidian: { enabled: false, useOfficialCli: false }, bridge: { enabled: false }, ingest: { autoCompile: true, allowUrlIngest: false },
        search: { backend: "local", corpus: "wiki" }, context: { includeCompiledDigestPrompt: false } } },
    } }, tools: { allow: [] },
  }), { mode: 0o600 });
  gateway = await startExactHostGateway({ cwd: temp, env: { OPENCLAW_STATE_DIR: state, OPENCLAW_CONFIG_PATH: configPath },
    openclawBin: path.join(hostRoot, "openclaw.mjs"), diagnosticPrefixes: ["session-memory", "memory-wiki"] });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("producer_connection_timeout")), 15000);
    client = new GatewayClient({ url: `ws://127.0.0.1:${gateway.env.OPENCLAW_GATEWAY_PORT}`, token: gateway.env.OPENCLAW_GATEWAY_TOKEN,
      env: gateway.env, clientName: "cli", mode: "cli", role: "operator", scopes: ["operator.admin"], deviceIdentity: null,
      sharedStateMode: "read-only", onHelloOk() { clearTimeout(timer); resolve(); }, onConnectError: reject,
      onEvent(event) { for (const listener of listeners) listener(event); } }); client.start();
  });
  const rpc = async (method, params) => {
    const result = await client.request(method, params, { timeoutMs: 45000 });
    await writeFile(path.join(temp, `${method}.json`), JSON.stringify(result, null, 2)); return result;
  };
  await rpc("wiki.init", { agentId: "probe" });
  const ingested = await rpc("wiki.ingest", { agentId: "probe", inputPath: wikiInput, title: "Synthetic retained observation" });
  const claimId = "synthetic-retained-claim";
  await rpc("wiki.apply", { agentId: "probe", op: "update_metadata", lookup: ingested.pagePath,
    claims: [{ id: claimId, text: "SYNTHETIC_ALLOWED_FRAGMENT", status: "active", confidence: 1,
      evidence: [{ kind: "local-file", path: wikiInput, lines: "1-4" }] }] });
  await rpc("wiki.compile", { agentId: "probe" });
  const hits = await rpc("wiki.search", { agentId: "probe", query: "SYNTHETIC_ALLOWED_FRAGMENT", backend: "local", corpus: "wiki", maxResults: 32 });
  assert.ok(Array.isArray(hits) && hits.length > 0, JSON.stringify({ ingested, hits }));
  const wiki = await rpc("wiki.get", { agentId: "probe", lookup: hits[0].path, fromLine: 1, lineCount: 120, backend: "local", corpus: "wiki" });
  assert.ok(wiki.content.includes("SYNTHETIC_ALLOWED_FRAGMENT") && wiki.totalLines <= 120);
  const wikiExact = await rpc("wiki.get", { agentId: "probe", lookup: wiki.path, fromLine: 1, lineCount: wiki.totalLines, backend: "local", corpus: "wiki" });
  const claimRead = await rpc("wiki.get", { agentId: "probe", lookup: `claim:${claimId}`, fromLine: 1, lineCount: wiki.totalLines, backend: "local", corpus: "wiki" });
  assert.deepEqual(claimRead, wikiExact, "Compiled claim alias must resolve the exact retained page through native cache");
  await runExactHostEvaluationChat({ request: (method, params) => client.request(method, params, { timeoutMs: 35000 }),
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); } },
  { sessionKey: "agent:probe:main", message: "Retain this synthetic observation: SYNTHETIC_ALLOWED_FRAGMENT", idempotencyKey: "producer-session", timeoutMs: 90000 });
  await client.request("chat.send", { sessionKey: "agent:probe:main", message: "/new", idempotencyKey: "producer-new" });
  let sessionFile;
  const deadline = Date.now() + 20000;
  do {
    sessionFile = (await readdir(path.join(workspace, "memory"))).find(name => name !== "retained.md" && name.endsWith(".md"));
    if (sessionFile) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  assert.ok(sessionFile, "Actual /new must produce a native session-memory file");
  if (failure) throw failure;
  const artifacts = [];
  for (const [providerId, nativePath, rawPath, content, lineCount] of [
    ["memory-core", "memory/retained.md", path.join(workspace, "memory/retained.md"), "SYNTHETIC_ALLOWED_FRAGMENT\n", 1],
    ["session-memory", `memory/${sessionFile}`, path.join(workspace, "memory", sessionFile)],
    ["memory-wiki", wikiExact.path, path.join(vault, wikiExact.path), wikiExact.content, wikiExact.lineCount],
  ]) {
    const raw = await readFile(rawPath, "utf8"), text = content ?? raw;
    assert.ok(text.includes("SYNTHETIC_ALLOWED_FRAGMENT"));
    const start = raw.indexOf(text); assert.ok(start >= 0 && raw.indexOf(text, start + 1) === -1);
    artifacts.push({ provider: providerId, nativePath, rawPath, rawSha256: createHash("sha256").update(raw).digest("hex"),
      text, segmentStart: Buffer.byteLength(raw.slice(0, start)), segmentEnd: Buffer.byteLength(raw.slice(0, start) + text),
      fromLine: 1, lineCount: lineCount ?? raw.trimEnd().split("\n").length,
      ...(providerId === "memory-wiki" ? { claimId } : {}) });
  }
  const cron = await rpc("cron.list", { includeDisabled: true });
  assert.ok(!cron.jobs.some(job => job.declarationKey === "memory-core:memory-dreaming-promotion" && job.enabled));
  const report = { schemaVersion: "stella.native-memory-producers/v1", hostVersion: "2026.8.2", evidenceDirectory: temp,
    workspace, vault, artifacts, nativeSessionNewExecuted: true, nativeWikiIngestExecuted: true, nativeWikiCompileExecuted: true,
    nativeCompiledClaimRead: true, dreamingEnabled: false, realModelAccepted: false, stellaConsumptionVerified: false, modelRequests: inputs.length };
  await writeFile(path.join(temp, "native-memory-producers.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} catch (error) {
  await writeFile(path.join(temp, "failure.json"), JSON.stringify({ error: String(error), diagnostics: gateway?.diagnostics() }, null, 2));
  process.stderr.write(`Native producer evidence retained: ${temp}\n`); throw error;
} finally {
  await client?.stopAndWait({ timeoutMs: 2000 }); await gateway?.stop();
  provider.closeAllConnections(); if (provider.listening) await new Promise(resolve => provider.close(resolve));
}
