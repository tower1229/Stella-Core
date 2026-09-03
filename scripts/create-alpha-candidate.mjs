import { execFile } from "node:child_process";
import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { createAlphaCandidateReceipt } from "../dist/src/acceptance/alpha-candidate.js";
import { parseExactHostRecoveryReceipt } from "../dist/src/acceptance/exact-host-evidence.js";
import { parseRequiredArguments } from "./lib/cli-args.mjs";

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const options = parseRequiredArguments(
  process.argv.slice(2),
  [
    "canghai-root",
    "canghai-revision",
    "artifact",
    "evaluation-report",
    "recovery-receipt",
    "durability-evidence",
    "output-dir",
  ],
  "Usage: --canghai-root <path> --canghai-revision <sha> --artifact <tgz> --evaluation-report <json> --recovery-receipt <json> --durability-evidence <json> --output-dir <path>",
);

function assertOutputOutsideSource(outputDirectory) {
  const relative = path.relative(projectRoot, outputDirectory);
  if (!relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Alpha candidate output directory must be outside the Core source tree");
  }
}

const outputDirectory = path.resolve(options["output-dir"]);
assertOutputOutsideSource(outputDirectory);
await mkdir(outputDirectory, { recursive: true });

const [{ stdout: coreRevision }, evaluation, recovery, durability] = await Promise.all([
  execFileAsync("git", ["-C", projectRoot, "rev-parse", "HEAD"]),
  readFile(path.resolve(options["evaluation-report"]), "utf8").then(JSON.parse),
  readFile(path.resolve(options["recovery-receipt"]), "utf8")
    .then(JSON.parse)
    .then(parseExactHostRecoveryReceipt),
  readFile(path.resolve(options["durability-evidence"]), "utf8").then(JSON.parse),
]);
const sourceArtifactPath = path.resolve(options.artifact);
const artifactPath = path.join(outputDirectory, path.basename(sourceArtifactPath));
if (sourceArtifactPath !== artifactPath) await copyFile(sourceArtifactPath, artifactPath);

const receipt = await createAlphaCandidateReceipt({
  core: { root: projectRoot, revision: coreRevision.trim() },
  canghai: {
    root: path.resolve(options["canghai-root"]),
    revision: options["canghai-revision"],
  },
  hostVersion: "2026.8.2",
  artifactPath,
  recovery,
  durability,
  evaluation,
});
const receiptPath = path.join(outputDirectory, "alpha-candidate-receipt.json");
const stagingPath = `${receiptPath}.${process.pid}.staging`;
await writeFile(stagingPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
await rename(stagingPath, receiptPath);
process.stdout.write(`${JSON.stringify({ artifactPath, receiptPath })}\n`);
