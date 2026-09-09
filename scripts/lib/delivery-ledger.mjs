import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { buildDeliveryLedger } from "../../dist/src/acceptance/delivery-ledger.js";
import { deliveryCatalog } from "../../dist/src/acceptance/delivery-catalog.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
const hash = value => createHash("sha256").update(value).digest("hex");
const git = async (...args) => (await promisify(execFile)("git", ["-C", root, ...args])).stdout.trim();
async function artifactDigest(directory) {
  const entries = [];
  async function visit(dir) {
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) await visit(file);
      else if (entry.isFile()) entries.push([path.relative(directory, file), hash(await readFile(file))]);
      else throw new Error("unsafe_delivery_artifact");
    }
  }
  await visit(directory);
  return hash(JSON.stringify(entries));
}

/** Called after the existing read-only main preflight; never invokes models or applies initialization. */
export async function writeDeliveryLedger({ report, configuration, output, evidenceDirectory }) {
  const core = await git("rev-parse", "HEAD");
  const status = await git("status", "--porcelain");
  const require = createRequire(import.meta.url);
  const hostSdk = await readFile(require.resolve("openclaw/plugin-sdk/gateway-runtime"));
  const version = { core, sourceClean: status === "", artifact: await artifactDigest(path.join(root, "dist")),
    host: hash(hostSdk), harness: hash(Buffer.concat([Buffer.from(process.version), await readFile(fileURLToPath(import.meta.url)),
      await readFile(path.join(root, "scripts/inspect-main-readiness.mjs"))])),
    source: hash(report.sourceRevision), profile: report.profileSha256.replace(/^sha256:/, ""),
    // Source revision binds all retained policy/config resources without exposing private locators.
    policy: hash(`source-policy:${report.sourceRevision}`), configuration: hash(configuration), model: hash(report.modelRef),
    cases: hash(JSON.stringify(deliveryCatalog)) };
  const evidence = evidenceDirectory ? JSON.parse(await readFile(path.join(evidenceDirectory, "manifest.json"), "utf8")) : [];
  if (!Array.isArray(evidence)) throw new Error("invalid_delivery_evidence_manifest");
  const ledger = await buildDeliveryLedger({ version, checkedAt: report.checkedAt, preflight: report, evidence, contractRoot: root,
    readEvidence: async sha256 => readFile(path.join(evidenceDirectory, `${sha256}.evidence`)) });
  if (core !== await git("rev-parse", "HEAD") || status !== await git("status", "--porcelain")) throw new Error("delivery_source_changed");
  await writeFile(output, JSON.stringify({ ...ledger, preflight: { ...ledger.preflight, caseId: "spec6-01-real_main_preflight",
    environment: "real_main_preflight", recordedAt: report.checkedAt, version, result: report.blockers.length ? "blocked" : "observed",
    evidenceRef: `sha256:${hash(JSON.stringify(report, null, 2))}` }, complete: false, versionLimitations: ["host_runtime_version_unverified", "model_route_configuration_only"] }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  return { complete: false, works: ledger.works.length, acceptances: ledger.acceptances.length,
    gaps: ledger.preflight.gaps };
}
