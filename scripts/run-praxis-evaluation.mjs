import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  parsePraxisEvaluationSuite,
  runPraxisEvaluation,
} from "../dist/src/acceptance/praxis-evaluation.js";

function parseArguments(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index];
    const value = values[index + 1];
    if (!key?.startsWith("--") || !value) {
      throw new Error("Usage: --suite <json> --adapter <module> --output <json>");
    }
    result[key.slice(2)] = value;
  }
  for (const key of ["suite", "adapter", "output"]) {
    if (!result[key]) throw new Error(`Missing --${key}`);
  }
  return result;
}

const options = parseArguments(process.argv.slice(2));
const suite = parsePraxisEvaluationSuite(await readFile(path.resolve(options.suite), "utf8"));
const adapter = await import(pathToFileURL(path.resolve(options.adapter)).href);
if (typeof adapter.executePraxisCase !== "function") {
  throw new Error("Praxis evaluation adapter must export executePraxisCase(case)");
}
const report = await runPraxisEvaluation(suite.cases, adapter.executePraxisCase);
const outputPath = path.resolve(options.output);
await mkdir(path.dirname(outputPath), { recursive: true });
const stagingPath = `${outputPath}.${process.pid}.staging`;
await writeFile(stagingPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
await rename(stagingPath, outputPath);
process.stdout.write(`${JSON.stringify({ output: outputPath, ...report })}\n`);
