#!/usr/bin/env node
/**
 * Record synthetic_contract DeliveryEvidence for Issue #13 unified ingest.
 * Writes result "implemented" only — does not claim Exact Host / real_main verified.
 *
 * Usage:
 *   npm run build && node scripts/compile.mjs test
 *   node scripts/record-ingest-evidence.mjs --evidence-directory /path/to/private-evidence
 */
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { deliveryCatalog } from "../dist/src/acceptance/delivery-catalog.js";

const execFileAsync = promisify(execFile);
const root = fileURLToPath(new URL("..", import.meta.url));
const hash = (value) => createHash("sha256").update(value).digest("hex");
const git = async (...args) => (await execFileAsync("git", ["-C", root, ...args])).stdout.trim();

const TARGETS = ["M-01", "M-02", "G-03", "G-06", "G-10"];
const ENVIRONMENT = "synthetic_contract";

const { values } = parseArgs({
  options: {
    "evidence-directory": { type: "string" },
    "expires-days": { type: "string", default: "30" },
  },
});

if (!values["evidence-directory"]) {
  throw new Error("Missing --evidence-directory <private evidence directory>");
}

const evidenceDirectory = path.resolve(values["evidence-directory"]);
const expiresDays = Number(values["expires-days"] ?? "30");
if (!Number.isInteger(expiresDays) || expiresDays < 1) throw new Error("invalid_expires_days");

for (const target of TARGETS) {
  const known = [...deliveryCatalog.works, ...deliveryCatalog.acceptances].some((row) => row.id === target);
  if (!known) throw new Error(`unknown_delivery_target:${target}`);
}

await mkdir(evidenceDirectory, { recursive: true, mode: 0o700 });

const modules = [
  path.join(root, "dist/src/canghai/ingest.js"),
];
const testEntry = path.join(root, ".test-dist/tests/ingest.test.js");
try {
  for (const modulePath of modules) await readFile(modulePath);
  await readFile(testEntry);
} catch {
  throw new Error("Run `npm run build` and `node scripts/compile.mjs test` before recording evidence");
}

const { stderr: testErr } = await execFileAsync(
  process.execPath,
  ["--test", testEntry],
  { cwd: root, maxBuffer: 8 * 1024 * 1024 },
).catch((error) => {
  process.stderr.write(error.stdout ?? "");
  process.stderr.write(error.stderr ?? "");
  throw new Error("synthetic_ingest_failed");
});
if (testErr) process.stderr.write(testErr);

const require = createRequire(import.meta.url);
const hostSdk = await readFile(require.resolve("openclaw/plugin-sdk/gateway-runtime"));
const core = await git("rev-parse", "HEAD");
const status = await git("status", "--porcelain");
const version = {
  core,
  sourceClean: status === "",
  artifact: hash(Buffer.concat(await Promise.all(modules.map((modulePath) => readFile(modulePath))))),
  host: hash(hostSdk),
  harness: hash(Buffer.concat([
    Buffer.from(process.version),
    await readFile(fileURLToPath(import.meta.url)),
    await readFile(testEntry),
  ])),
  source: hash("stella-core:issue-13:unified-ingest"),
  profile: hash("synthetic-profile:unified-ingest"),
  policy: hash("synthetic-policy:unified-ingest"),
  configuration: hash("synthetic-config:unified-ingest"),
  model: hash("none:deterministic-ingest"),
  cases: hash(JSON.stringify(deliveryCatalog)),
};

const recordedAt = new Date().toISOString();
const expiresAt = new Date(Date.parse(recordedAt) + expiresDays * 24 * 60 * 60 * 1000).toISOString();

const summary = {
  schemaVersion: "stella.ingest-evidence/v1",
  issue: 13,
  environment: ENVIRONMENT,
  result: "implemented",
  note: "synthetic_contract only; implemented ≠ verified; Exact Host / real_main not claimed. Claims T07 slice of M-01 / M-02 / G-03 / G-06 / G-10 only (Host+explicit ingest state machine, upstream identity versions, do_not_retain admission). Does not mark work 08 complete; five-entry ingest, transcript archive (09), and resume coverage (10) remain open.",
  targets: TARGETS,
  recordedAt,
  publicSeam: [
    "ingest",
    "ingestHostMessage",
    "ingestExplicitRecord",
    "prepareHostMessageItems",
    "prepareExplicitRecordItems",
    "assertRetentionAdmission",
  ],
  syntheticHarness: "tests/ingest.test.ts",
};

let manifest = [];
try {
  manifest = JSON.parse(await readFile(path.join(evidenceDirectory, "manifest.json"), "utf8"));
  if (!Array.isArray(manifest)) throw new Error("invalid_delivery_evidence_manifest");
} catch (error) {
  if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") manifest = [];
  else if (error instanceof SyntaxError || error.message === "invalid_delivery_evidence_manifest") {
    throw new Error("invalid_delivery_evidence_manifest");
  } else throw error;
}

const written = [];
for (const target of TARGETS) {
  const caseId = `spec6-${target}-${ENVIRONMENT}`;
  const artifactBody = `${JSON.stringify({ ...summary, target, caseId }, null, 2)}\n`;
  const artifactSha256 = hash(artifactBody);
  const previous = manifest
    .filter((row) => row.target === target && row.caseId === caseId)
    .sort((a, b) => Date.parse(a.recordedAt) - Date.parse(b.recordedAt));
  const supersedes = previous.length ? [previous[previous.length - 1].id] : [];
  const id = hash(`${caseId}:${artifactSha256}:${recordedAt}:${core}`);
  const record = {
    id,
    target,
    caseId,
    environment: ENVIRONMENT,
    version,
    recordedAt,
    expiresAt,
    result: "implemented",
    artifactSha256,
    supersedes,
  };
  await writeFile(path.join(evidenceDirectory, `${artifactSha256}.evidence`), artifactBody, { mode: 0o600 });
  manifest.push(record);
  written.push({ target, caseId, id, artifactSha256, result: "implemented" });
}

await writeFile(path.join(evidenceDirectory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
process.stdout.write(`${JSON.stringify({
  schemaVersion: "stella.ingest-evidence-report/v1",
  environment: ENVIRONMENT,
  result: "implemented",
  sourceClean: version.sourceClean,
  written,
}, null, 2)}\n`);
