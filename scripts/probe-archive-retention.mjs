import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, writeFile, realpath, readdir } from "node:fs/promises";
import { randomUUID, createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { startExactHostGateway } from "./lib/exact-host-gateway.mjs";
import { createFixture, prepareInitializationFixture, initializeFixtureRepository } from "../.test-dist/tests/consciousness-fixture.js";

const run = promisify(execFile);
const root = await realpath(fileURLToPath(new URL("../", import.meta.url)));
const packageRoot = await realpath(process.env.STELLA_PROBE_PACKAGE_ROOT ?? root);
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
async function runtimeDigest(directory) {
  const entries = [];
  async function visit(relative) {
    for (const entry of (await readdir(path.join(directory, relative), { withFileTypes: true })).sort((a,b) => a.name.localeCompare(b.name))) {
      const location = path.join(relative, entry.name);
      assert.ok(!entry.isSymbolicLink(), "runtime artifact must not contain dependency symlinks");
      if (entry.isDirectory()) await visit(location);
      else entries.push([location, await sha256(await readFile(path.join(directory, location)))]);
    }
  }
  await visit("dist"); await visit("schemas");
  for (const file of ["package.json", "openclaw.plugin.json"]) entries.push([file, await sha256(await readFile(path.join(directory, file)))]);
  return `sha256:${await sha256(JSON.stringify(entries))}`;
}
const runtimeContentDigest = await runtimeDigest(packageRoot);
assert.equal(runtimeContentDigest, await runtimeDigest(root), "tested package must match the current compiled source artifact");
const startRevision = (await run("git", ["-C", root, "rev-parse", "HEAD"])).stdout.trim();
const startClean = (await run("git", ["-C", root, "status", "--porcelain", "--untracked-files=all"])).stdout.trim() === "";
const core = relative => import(pathToFileURL(path.join(packageRoot, "dist/src", relative)).href);
const { loadConsciousness } = await core("canghai/manifest.js");
const { loadPraxisRuntimeBinding } = await core("praxis/runtime-binding.js");
const { CatalogReader } = await core("canghai/catalog-reader.js");
const { bytesVersion } = await core("canghai/content-version.js");
const { ingestTranscript, prepareTranscriptItems } = await core("canghai/ingest.js");
const { resumeIngestCursor } = await core("canghai/ingest-progress.js");
const { verifyArchiveCoverage } = await core("canghai/archive-cleanup.js");
const { GitCangHaiDurability } = await core("canghai/durability.js");
assert.ok(process.env.STELLA_PROBE_HOST_ROOT, "Select the actual installed Host with STELLA_PROBE_HOST_ROOT");
const hostRoot = await realpath(process.env.STELLA_PROBE_HOST_ROOT);
const host = JSON.parse(await readFile(path.join(hostRoot, "package.json"), "utf8"));
assert.equal(host.version, "2026.8.2");
const temp = await mkdtemp(path.join(os.tmpdir(), "stella-host-archive-"));
const state = path.join(temp, "state"), workspace = path.join(temp, "workspace"), plugin = path.join(temp, "plugin");
await Promise.all([state, workspace, plugin].map(dir => mkdir(dir)));
const configPath = path.join(state, "openclaw.json");
// All SDK calls and Gateway processes use an isolated synthetic Host state, never the user's main profile.
process.env.OPENCLAW_STATE_DIR = state;
process.env.OPENCLAW_CONFIG_PATH = configPath;
const sdk = async name => import(pathToFileURL(path.join(hostRoot, "dist/plugin-sdk", `${name}.js`)).href);
const { GatewayClient } = await sdk("gateway-runtime");
const { upsertSessionEntry, loadTranscriptEventsSync, getSessionEntry, deleteSessionEntry } = await sdk("session-store-runtime");
const { appendSessionTranscriptMessageByIdentity, readSessionTranscriptRawDelta } = await sdk("session-transcript-runtime");
const canghaiRoot = await createFixture();
await prepareInitializationFixture(canghaiRoot, "probe");
const revision = await initializeFixtureRepository(canghaiRoot);
const remote = path.join(temp, "canghai.git");
const git = async args => (await run("git", args)).stdout.trim();
await git(["init", "--bare", "--quiet", remote]);
await git(["-C", canghaiRoot, "remote", "add", "origin", remote]);
await git(["-C", canghaiRoot, "push", "origin", "HEAD:refs/heads/main"]);
const loaded = await loadConsciousness(canghaiRoot);
const binding = await loadPraxisRuntimeBinding(loaded);
await writeFile(path.join(plugin, "package.json"), JSON.stringify({ name: "stella-archive-probe", version: "0.0.0", type: "module", openclaw: { extensions: ["./index.mjs"] } }));
await writeFile(path.join(plugin, "openclaw.plugin.json"), await readFile(path.join(packageRoot, "openclaw.plugin.json")));
await writeFile(path.join(plugin, "index.mjs"), `export { default } from ${JSON.stringify(pathToFileURL(path.join(packageRoot, "dist/src/plugin.js")).href)};\n`);
let config = { gateway: { mode: "local" }, agents: { entries: { probe: { workspace } } },
  session: { maintenance: { mode: "warn", pruneAfter: "1ms", maxEntries: 1 } },
  plugins: { allow: ["stella-core"], load: { paths: [plugin] }, entries: { "stella-core": { enabled: true,
    hooks: { allowConversationAccess: true }, config: { canghaiRoot, recoveryRevision: revision, agentId: "probe",
      initializationGatewayAccess: "local_operator_read", dataMode: "managed_durable_write", durabilityRemote: "origin", durabilityBranch: "main", archiveRetention: "hold_and_monitor" } } } },
  tools: { allow: ["read", "stella_initialize"] } };
await writeFile(configPath, JSON.stringify(config));
const env = { ...process.env, OPENCLAW_STATE_DIR: state, OPENCLAW_CONFIG_PATH: configPath };
delete env.NODE_OPTIONS;
const target = { agentId: "probe", sessionId: randomUUID(), sessionKey: "agent:probe:archive-synthetic", env };
await upsertSessionEntry({ agentId: target.agentId, sessionKey: target.sessionKey, env,
  entry: { sessionId: target.sessionId, updatedAt: 1 } });
for (let i = 0; i < 3; i++) {
  const result = await appendSessionTranscriptMessageByIdentity({ ...target, config,
    message: { role: "user", content: [{ type: "text", text: "Same synthetic content, distinct Host events." }, ...(i === 2 ? [{ type: "file", mimeType: "application/octet-stream", data: Buffer.from([0, 1, 254, 255]).toString("base64") }] : [])] }, now: 1_700_000_000_000 + i });
  assert.ok(result, "Host must durably append each original");
}
const originalEvents = loadTranscriptEventsSync(target).filter(event => event.type === "message");
assert.equal(originalEvents.length, 3);
assert.equal(new Set(originalEvents.map(event => event.id)).size, 3);
let gateway, client;
async function start() {
  gateway = await startExactHostGateway({ cwd: temp, env, openclawBin: path.join(hostRoot, "openclaw.mjs") });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Archive observer timeout")), 15000);
    client = new GatewayClient({ url: `ws://127.0.0.1:${gateway.env.OPENCLAW_GATEWAY_PORT}`, token: gateway.env.OPENCLAW_GATEWAY_TOKEN,
      env: gateway.env, clientName: "cli", mode: "cli", role: "operator", scopes: ["operator.admin"], sharedStateMode: "read-only", deviceIdentity: null,
      onHelloOk() { clearTimeout(timeout); resolve(); }, onConnectError(error) { clearTimeout(timeout); reject(error); } });
    client.start();
  });
}
async function stop() { client?.stop(); client = undefined; await gateway?.stop(); gateway = undefined; }
const probes = [];
const status = () => client.request("stella.archiveRetention", {});
const durability = () => new GitCangHaiDurability({ root: canghaiRoot, remote: "origin", branch: "main",
  criticalWritePolicy: "sync_immediately", normalWritePolicy: "sync_immediately", maxNormalRpoSeconds: 0 });
async function ports() { return { reader: await CatalogReader.load(canghaiRoot, binding.catalogPath), durability: durability(),
  objectRoot: binding.archive.objectRoot, payloadRoot: binding.archive.payloadRoot,
  retentionGuarantees: { transcript: false, staging: false, backup: false } }; }
try {
  await start();
  let inspected = await status();
  assert.equal(inspected.state, "held", JSON.stringify(inspected));
  assert.equal(inspected.backlogEvents, 3);
  assert.equal(inspected.fullRetention, false);
  probes.push("production-plugin-observes-real-host-backlog");
  const cleanup = await run(process.execPath, [path.join(hostRoot, "openclaw.mjs"), "sessions", "cleanup", "--agent", "probe", "--json"], { cwd: temp, env: gateway.env, timeout: 60000 });
  await writeFile(path.join(temp, "maintenance.json"), cleanup.stdout);
  assert.ok(getSessionEntry({ ...target }));
  assert.deepEqual(loadTranscriptEventsSync(target).filter(event => event.type === "message"), originalEvents);
  probes.push("native-maintenance-keeps-unarchived-originals");
  await stop();
  // Read an actual Host opaque cursor page; the first raw page can contain the session header.
  const first = await readSessionTranscriptRawDelta({ ...target, maxEvents: 2, maxBytes: 65536 });
  assert.equal(first.kind, "page");
  assert.equal(first.hasMore, true);
  const request = (page, cursor, expectedRevision, operationId) => {
    const messages = page.events.map(row => row.event).filter(event => event.type === "message").map(event => ({
      upstreamId: event.id, parentUpstreamId: event.parentId, timestamp: event.timestamp, message: event.message, event }));
    const hostInput = { hostVersion: host.version, agentId: target.agentId, sessionId: target.sessionId, sessionKey: target.sessionKey, messages };
    const items = prepareTranscriptItems(hostInput);
    return { ...hostInput, operationId, expectedRevision, resumeKey: "real-host-export", branchPolicy: "declared_subset", declaredBranches: messages.map(message => message.upstreamId),
      policyRef: binding.archive.policyRef, purpose: binding.purpose,
      coverage: { branchPolicy: "declared_subset", declaredBranches: messages.map(message => message.upstreamId), upstreamSnapshot: target.sessionId,
        fromCursor: cursor, toCursor: page.cursor, expectedCount: items.length,
        manifest: { schemaVersion: "stella.archive-manifest/v1", items: items.map(item => ({ upstreamId: item.upstreamId, textSha256: bytesVersion(item.text), attachments: (item.attachments ?? []).map(attachment => ({ upstreamId: attachment.upstreamId, sha256: bytesVersion(attachment.bytes) })) })) } } };
  };
  const firstInput = request(first, null, revision, "host-page-one");
  const interruptedPorts = await ports();
  await interruptedPorts.durability.diagnostics();
  await git(["-C", canghaiRoot, "remote", "set-url", "origin", path.join(temp, "offline.git")]);
  await assert.rejects(ingestTranscript(firstInput, interruptedPorts), /persistence_failed/);
  const pending = await resumeIngestCursor("real-host-export", await ports());
  assert.deepEqual(pending, { state: "pending", cursor: null, operationId: "host-page-one" });
  probes.push("real-transport-failure-keeps-input-cursor");
  await git(["-C", canghaiRoot, "remote", "set-url", "origin", remote]);
  const completed = await ingestTranscript(firstInput, await ports());
  assert.equal(completed.state, "synchronized");
  const resumed = await resumeIngestCursor("real-host-export", await ports());
  assert.equal(resumed.cursor, first.cursor);
  const second = await readSessionTranscriptRawDelta({ ...target, cursor: resumed.cursor, maxEvents: 32, maxBytes: 65536 });
  assert.equal(second.kind, "page");
  assert.equal(second.hasMore, false);
  const secondInput = request(second, resumed.cursor, await git(["-C", canghaiRoot, "rev-parse", "HEAD"]), "host-page-two");
  await ingestTranscript(secondInput, await ports());
  await ingestTranscript(firstInput, await ports());
  assert.equal((await resumeIngestCursor("real-host-export", await ports())).cursor, second.cursor);
  const reader = await CatalogReader.load(canghaiRoot, binding.catalogPath);
  assert.equal(reader.catalog.sources.length, 3);
  probes.push("opaque-host-cursor-resume-no-event-loss-or-duplicate");
  const clone = path.join(temp, "recovered");
  await git(["clone", "--quiet", "--branch", "main", remote, clone]);
  const recovered = await CatalogReader.load(clone, binding.catalogPath);
  for (const coverage of recovered.catalog.coverage) await verifyArchiveCoverage(recovered, coverage);
  const restored = [];
  for (const ref of recovered.catalog.sources) {
    const source = await recovered.read(ref, "sources");
    restored.push(JSON.parse((await recovered.readPayload(ref, source.payloads[0].sha256)).bytes.toString()).event);
  }
  assert.deepEqual(restored.sort((a,b) => a.id.localeCompare(b.id)), originalEvents.sort((a,b) => a.id.localeCompare(b.id)));
  const binaryPayloads = [];
  for (const ref of recovered.catalog.sources) {
    const source = await recovered.read(ref, "sources");
    for (const payload of source.payloads.filter(payload => payload.mediaType === "application/octet-stream")) binaryPayloads.push((await recovered.readPayload(ref, payload.sha256)).bytes);
  }
  assert.ok(binaryPayloads.some(bytes => bytes.equals(Buffer.from([0, 1, 254, 255]))));
  probes.push("independent-git-clone-restores-exact-host-originals-and-attachment");
  config = JSON.parse(await readFile(configPath, "utf8"));
  config.plugins.entries["stella-core"].config.recoveryRevision = await git(["-C", canghaiRoot, "rev-parse", "HEAD"]);
  await writeFile(configPath, JSON.stringify(config));
  await start();
  inspected = await status();
  assert.equal(inspected.state, "held", JSON.stringify(inspected));
  assert.equal(inspected.backlogEvents, 0, JSON.stringify(inspected));
  probes.push("gateway-restart-reconciles-synchronized-archive");
  // A newly observed original deleted outside normal maintenance must stay in the durable backlog journal.
  await appendSessionTranscriptMessageByIdentity({ ...target, config, message: { role: "user", content: "Unarchived synthetic original." } });
  // Do not request status: the scheduled service must discover this event itself.
  await new Promise(resolve => setTimeout(resolve, 65_000));
  await stop();
  assert.equal(await deleteSessionEntry({ ...target, expectedSessionId: target.sessionId }), true);
  await start();
  inspected = await status();
  assert.equal(inspected.backlogEvents, 1);
  assert.equal(inspected.originalUnavailableEvents, 1);
  probes.push("scheduled-monitor-retains-deleted-original-backlog-after-restart");
  await stop();
  config = JSON.parse(await readFile(configPath, "utf8")); config.session.maintenance.mode = "enforce";
  await writeFile(configPath, JSON.stringify(config));
  await start();
  inspected = await status();
  assert.equal(inspected.state, "blocked");
  assert.deepEqual(inspected.blockers, ["host_early_cleanup_enabled"]);
  assert.equal(inspected.backlogEvents, null);
  probes.push("unsafe-maintenance-configuration-blocks-retention");
  const sourceRevision = await git(["-C", root, "rev-parse", "HEAD"]);
  const sourceClean = startClean && (await git(["-C", root, "status", "--porcelain", "--untracked-files=all"])) === "";
  assert.equal(sourceRevision, startRevision, "source changed during acceptance");
  assert.equal(await runtimeDigest(packageRoot), runtimeContentDigest, "tested runtime changed during acceptance");
  assert.equal(await runtimeDigest(root), runtimeContentDigest, "source runtime changed during acceptance");
  const receipt = { schemaVersion: "stella.host-archive-probe/v1", sourceRevision, sourceClean, hostVersion: host.version, hostRoot, installedArtifactTested: packageRoot !== root, runtimeContentDigest,
    hostVersionOutput: (await run(process.execPath, [path.join(hostRoot, "openclaw.mjs"), "--version"], { env })).stdout.trim(),
    hostEntrypointSha256: bytesVersion(await readFile(path.join(hostRoot, "openclaw.mjs"))),
    harnessSha256: bytesVersion(await readFile(fileURLToPath(import.meta.url))), fixture: "synthetic", model: "not_used",
    coordination: "native_maintenance_hold_and_monitor", scope: "observed_message_events", fullRetention: false,
    archiveRevision: await git(["-C", clone, "rev-parse", "HEAD"]), probes };
  await writeFile(path.join(temp, "receipt.json"), JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify({ evidence: path.join(temp, "receipt.json"), ...receipt }, null, 2));
} finally { await stop(); }
