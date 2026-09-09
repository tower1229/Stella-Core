import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { parseArgs, promisify } from "node:util";
import { parse } from "yaml";
import { resolveDefaultModelForAgent } from "openclaw/plugin-sdk/agent-runtime";
import { callGatewayFromCli } from "openclaw/plugin-sdk/gateway-runtime";
import { inspectMainReadiness } from "../dist/src/acceptance/main-readiness.js";
import { readRepositoryBytes } from "../dist/src/canghai/catalog-reader.js";
import { parseCangHaiRef } from "../dist/src/canghai/ref.js";
import { bytesVersion } from "../dist/src/canghai/content-version.js";
import { writeDeliveryLedger } from "./lib/delivery-ledger.mjs";
const { values } = parseArgs({ options: { config: { type: "string" }, output: { type: "string" }, "ledger-output": { type: "string" }, "evidence-directory": { type: "string" } } });
if (!values.config || !values.output) throw new Error("Required: --config <OpenClaw config> --output <private new JSON file>");
const original = await readFile(values.config);
const cfg = JSON.parse(original.toString("utf8"));
const entry = cfg.plugins?.entries?.["stella-core"];
if (!entry?.enabled || !entry.config || cfg.gateway?.mode === "remote") throw new Error("local_enabled_stella_required");
const c = entry.config;
const git = async (...args) => (await promisify(execFile)("git", ["-c", "core.fsmonitor=false", "-C", c.canghaiRoot, ...args])).stdout.trim();
const revision = await git("rev-parse", "HEAD");
if (revision !== c.recoveryRevision || await git("status", "--porcelain")) throw new Error("source_revision_or_cleanliness_changed");
const manifest = parse((await readRepositoryBytes(c.canghaiRoot, c.manifestPath ?? "50_PersonalAgent/stella/manifest.yaml")).toString("utf8"));
const model = resolveDefaultModelForAgent({ cfg, agentId: c.agentId });
const fallbackModelRefs = [cfg.agents?.defaults?.model, cfg.agents?.entries?.[c.agentId]?.model,
  cfg.agents?.list?.find(agent => agent.id === c.agentId)?.model].flatMap(model => typeof model === "object" ? model.fallbacks ?? [] : []);
const initialization = await callGatewayFromCli("stella.initialize", { port: String(cfg.gateway?.port ?? 18789), timeout: "15000", json: true },
  { action: "status" }, { scopes: ["operator.admin"], sharedStateMode: "read-only", progress: false });
const report = await inspectMainReadiness({ root: c.canghaiRoot, profilePath: parseCangHaiRef(manifest.identity.runtimeProfileRef).relativePath,
  agentId: c.agentId, modelRef: `${model.provider}/${model.model}`, fallbackModelRefs, initialization });
if (bytesVersion(await readFile(values.config)) !== bytesVersion(original) || await git("rev-parse", "HEAD") !== revision || await git("status", "--porcelain")) {
  throw new Error("configuration_changed_during_inspection");
}
const snapshot = { ...report, sourceRevision: revision, checkedAt: new Date().toISOString() };
await writeFile(values.output, JSON.stringify(snapshot, null, 2), { flag: "wx", mode: 0o600 });
if (values["ledger-output"]) {
  const delivery = await writeDeliveryLedger({ report: snapshot, configuration: original, output: values["ledger-output"], evidenceDirectory: values["evidence-directory"] });
  console.log(JSON.stringify({ delivery }));
}
console.log(JSON.stringify({ output: values.output, blockers: report.blockers, counts: report.counts, behavioralAcceptance: report.behavioralAcceptance }));
if (report.blockers.length) process.exitCode = 2;
