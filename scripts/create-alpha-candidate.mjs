import { execFile } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { createAlphaCandidateReceipt } from "../dist/src/acceptance/alpha-candidate.js";

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function parseArguments(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index];
    const value = values[index + 1];
    if (!key?.startsWith("--") || !value) {
      throw new Error(
        "Usage: --canghai-root <path> --canghai-revision <sha> --evaluation-report <json> --acceptance-evidence <json> --output-dir <path>",
      );
    }
    result[key.slice(2)] = value;
  }
  for (const key of [
    "canghai-root",
    "canghai-revision",
    "evaluation-report",
    "acceptance-evidence",
    "output-dir",
  ]) {
    if (!result[key]) throw new Error(`Missing --${key}`);
  }
  return result;
}

function assertOutputOutsideSource(outputDirectory) {
  const relative = path.relative(projectRoot, outputDirectory);
  if (!relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Alpha candidate output directory must be outside the Core source tree");
  }
}

const options = parseArguments(process.argv.slice(2));
const outputDirectory = path.resolve(options["output-dir"]);
assertOutputOutsideSource(outputDirectory);
await mkdir(outputDirectory, { recursive: true });

const [{ stdout: coreRevision }, evaluation, evidence] = await Promise.all([
  execFileAsync("git", ["-C", projectRoot, "rev-parse", "HEAD"]),
  readFile(path.resolve(options["evaluation-report"]), "utf8").then(JSON.parse),
  readFile(path.resolve(options["acceptance-evidence"]), "utf8").then(JSON.parse),
]);
const { stdout: packOutput } = await execFileAsync(
  "npm",
  ["pack", "--json", "--pack-destination", outputDirectory],
  { cwd: projectRoot, maxBuffer: 10 * 1024 * 1024 },
);
const packEntries = JSON.parse(packOutput);
const artifactName = packEntries[0]?.filename;
if (typeof artifactName !== "string") throw new Error("npm pack did not return an artifact");
const artifactPath = path.join(outputDirectory, artifactName);

const receipt = await createAlphaCandidateReceipt({
  core: { root: projectRoot, revision: coreRevision.trim() },
  canghai: {
    root: path.resolve(options["canghai-root"]),
    revision: options["canghai-revision"],
  },
  hostVersion: "2026.8.2",
  artifactPath,
  recovery: evidence.recovery,
  durability: evidence.durability,
  evaluation,
  privateEvaluationIncluded: evidence.privateEvaluationIncluded === true,
});
const receiptPath = path.join(outputDirectory, "alpha-candidate-receipt.json");
const stagingPath = `${receiptPath}.${process.pid}.staging`;
await writeFile(stagingPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
await rename(stagingPath, receiptPath);
process.stdout.write(`${JSON.stringify({ artifactPath, receiptPath })}\n`);
