#!/usr/bin/env node
/**
 * Record synthetic_contract DeliveryEvidence for Issue #19 continuable multi-round retrieval.
 * Writes result "implemented" only — does not claim Exact Host / real_main verified.
 *
 * Usage:
 *   npm run build && node scripts/compile.mjs test
 *   node scripts/record-retrieve-evidence.mjs --evidence-directory /path/to/private-evidence
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

const TARGETS = ["12", "19", "22", "G-01", "M-04", "M-05", "M-06", "M-07"];
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
  path.join(root, "dist/src/canghai/retrieve.js"),
  path.join(root, "dist/src/canghai/semantic-retrieval.js"),
  path.join(root, "dist/src/canghai/retrieval-progress.js"),
  path.join(root, "dist/src/praxis/episode-evidence.js"),
  path.join(root, "dist/src/praxis/temporal-scope.js"),
  path.join(root, "dist/src/acceptance/retrieval-capability.js"),
];
const testEntries = [
  path.join(root, ".test-dist/tests/retrieve.test.js"),
  path.join(root, ".test-dist/tests/semantic-retrieval.test.js"),
  path.join(root, ".test-dist/tests/retrieval-progress.test.js"),
  path.join(root, ".test-dist/tests/temporal-scope.test.js"),
];
try {
  for (const modulePath of modules) await readFile(modulePath);
  for (const testEntry of testEntries) await readFile(testEntry);
} catch {
  throw new Error("Run `npm run build` and `node scripts/compile.mjs test` before recording evidence");
}

const { stdout: testOutput, stderr: testErr } = await execFileAsync(
  process.execPath,
  ["--test", ...testEntries],
  { cwd: root, maxBuffer: 8 * 1024 * 1024 },
).catch((error) => {
  process.stderr.write(error.stdout ?? "");
  process.stderr.write(error.stderr ?? "");
  throw new Error("synthetic_retrieve_failed");
});
if (testErr) process.stderr.write(testErr);

const require = createRequire(import.meta.url);
const hostSdk = await readFile(require.resolve("openclaw/plugin-sdk/routing"));
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
    ...(await Promise.all(testEntries.map((entry) => readFile(entry)))),
  ])),
  source: hash("stella-core:issue-19:continuable-retrieval"),
  profile: hash("synthetic-profile:continuable-retrieval"),
  policy: hash("synthetic-policy:continuable-retrieval"),
  configuration: hash("synthetic-config:continuable-retrieval"),
  model: hash("synthetic-model:none"),
  cases: hash(JSON.stringify(deliveryCatalog)),
};

const recordedAt = new Date().toISOString();
const expiresAt = new Date(Date.parse(recordedAt) + expiresDays * 24 * 60 * 60 * 1000).toISOString();

const summary = {
  schemaVersion: "stella.retrieve-evidence/v1",
  issue: 19,
  environment: ENVIRONMENT,
  result: "implemented",
  note: "synthetic_contract only; implemented ≠ verified; Exact Host / real_main / native Codex not claimed. G-01/M-04..M-07 = multi-round semantic selection, counterevidence, temporal knownBy/eventWindow, and failure-class slice only. G-03 remains on the existing question-evidence role/kind path and is not claimed by this harness. Work 19/22 = Core constrained capability receipt slice; full capability close-out remains Issue #35. Public retrieve is the catalog multi-round/continuable stage; EvidenceBundle assessment remains prepareQuestionEvidence.",
  targets: TARGETS,
  recordedAt,
  testSummary: testOutput.trim().split("\n").slice(-30),
  publicSeam: [
    "retrieve",
    "resumeRetrieve",
    "resolveTemporalPurpose",
    "parseRetrievalCheckpoint",
    "toPublicRetrieveReport",
    "retrieveCatalogEvidence",
    "createMemoryAccessCapabilityAdapter",
    "createSemanticRetrievalCapabilityAdapter",
    "createDefaultMemoryAccessVerify",
    "createDefaultSemanticRetrievalVerify",
    "classifyQuestionTemporalScope",
    "persistRetrievalCheckpoint",
  ],
  syntheticHarness: "tests/retrieve.test.ts",
};

let manifest = [];
try {
  manifest = JSON.parse(await readFile(path.join(evidenceDirectory, "manifest.json"), "utf8"));
  if (!Array.isArray(manifest)) throw new Error("invalid_manifest");
} catch (error) {
  if (error && typeof error === "object" && "code" in error && error.code !== "ENOENT") throw error;
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
  schemaVersion: "stella.retrieve-evidence-report/v1",
  environment: ENVIRONMENT,
  result: "implemented",
  sourceClean: version.sourceClean,
  written,
}, null, 2)}\n`);
