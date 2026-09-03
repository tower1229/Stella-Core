import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  parsePraxisEvaluationSuite,
  runPraxisEvaluation,
} from "../dist/src/acceptance/praxis-evaluation.js";
import { createModelPraxisEvaluator } from "../dist/src/acceptance/model-praxis-evaluator.js";
import { parseRequiredArguments } from "./lib/cli-args.mjs";

const options = parseRequiredArguments(
  process.argv.slice(2),
  ["suite", "adapter", "recovery-receipt", "output"],
  "Usage: --suite <json> --adapter <module> --recovery-receipt <json> --output <json>",
);
const suite = parsePraxisEvaluationSuite(await readFile(path.resolve(options.suite), "utf8"));
const adapter = await import(pathToFileURL(path.resolve(options.adapter)).href);
const recoveryReceipt = JSON.parse(
  await readFile(path.resolve(options["recovery-receipt"]), "utf8"),
);
if (
  recoveryReceipt.schemaVersion !== "stella.exact-host-recovery-receipt/v1" ||
  typeof recoveryReceipt.coreRevision !== "string" ||
  typeof recoveryReceipt.canghaiRevision !== "string" ||
  typeof recoveryReceipt.hostVersion !== "string" ||
  typeof recoveryReceipt.artifactSha256 !== "string"
) {
  throw new Error("Praxis evaluation requires a valid exact-host recovery receipt");
}
if (typeof adapter.answerCase !== "function" || typeof adapter.judge !== "function") {
  throw new Error("Praxis evaluation adapter must export answerCase(case) and judge(prompt)");
}
const report = await runPraxisEvaluation(
  suite.cases,
  createModelPraxisEvaluator({ answerCase: adapter.answerCase, judge: adapter.judge }),
  {
    coreRevision: recoveryReceipt.coreRevision,
    canghaiRevision: recoveryReceipt.canghaiRevision,
    hostVersion: recoveryReceipt.hostVersion,
    artifactSha256: recoveryReceipt.artifactSha256,
  },
);
const outputPath = path.resolve(options.output);
await mkdir(path.dirname(outputPath), { recursive: true });
const stagingPath = `${outputPath}.${process.pid}.staging`;
await writeFile(stagingPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
await rename(stagingPath, outputPath);
process.stdout.write(`${JSON.stringify({ output: outputPath, ...report })}\n`);
