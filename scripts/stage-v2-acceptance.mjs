import { execFile } from "node:child_process";
import { readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs, promisify } from "node:util";
import { createHash } from "node:crypto";

const { values } = parseArgs({ options: { staging: { type: "string" } } });
if (!values.staging) throw new Error("Required: --staging <inactive migration copy>");
const staging = await realpath(values.staging);
const migration = JSON.parse(await readFile(path.join(staging, "migration.json"), "utf8"));
const root = await realpath(path.join(staging, "canghai"));
if (migration.schemaVersion !== "stella.v2-source-staging/v1" || migration.activated !== false || await realpath(migration.root) !== root) {
  throw new Error("Explicit inactive v2 staging copy required");
}
const git = (args) => promisify(execFile)("git", ["-C", root, ...args]);
if ((await git(["remote"])).stdout.trim() || (await git(["rev-parse", "HEAD"])).stdout.trim() !== migration.sourceRevision) {
  throw new Error("Staging source changed or has a push remote");
}
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const relative = "50_PersonalAgent/stella/acceptance/v2-recovery-adapter.mjs";
const old = await readFile(path.join(root, "50_PersonalAgent/stella/acceptance/alpha-adapter.mjs"));
const template = await readFile(new URL("./templates/v2-recovery-adapter.mjs", import.meta.url));
const reportPath = path.join(staging, "acceptance-migration.json");
let previous;
try { previous = JSON.parse(await readFile(reportPath, "utf8")); }
catch (error) { if (error.code !== "ENOENT") throw error; }
if (previous && (previous.activated !== false || previous.acceptancePassed !== false ||
  previous.oldAdapterSha256 !== hash(old) || previous.newAdapterRef !== `path:${relative}` ||
  previous.newAdapterSha256 !== hash(await readFile(path.join(root, relative))))) {
  throw new Error("Acceptance staging was modified outside this migration");
}
await writeFile(path.join(root, relative), template, { flag: previous ? "w" : "wx", mode: 0o600 });
const report = { schemaVersion: "stella.acceptance-adapter-migration/v1", sourceRevision: migration.sourceRevision,
  oldAdapterSha256: hash(old), newAdapterSha256: hash(template), newAdapterRef: `path:${relative}`,
  priorAdapterSha256: previous?.newAdapterSha256 ?? null,
  originalPreserved: true, activated: false, acceptancePassed: false,
  disabledLegacyPaths: ["generated feedback replay", "unknown view rebuilt by generic hash record", "CLI continuity judge", "forced nonempty historical learning"],
  remaining: ["actual required capability acceptance", "original action/outcome mapping", "private exact Host recovery"] };
await writeFile(reportPath, JSON.stringify(report, null, 2), { flag: previous ? "w" : "wx", mode: 0o600 });
console.log(JSON.stringify({ ...report, staging }));
