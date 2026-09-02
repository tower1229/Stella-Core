import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const schemaFiles = [
  "consciousness-manifest.schema.json",
  "framework-ir.schema.json",
  "praxis-episode.schema.json",
  "twin-hypothesis.schema.json",
];
const ajv = new Ajv2020({ allErrors: true, strict: true });
ajv.addFormat("date-time", true);

for (const file of schemaFiles) {
  const source = await readFile(path.join(projectRoot, "schemas", file), "utf8");
  ajv.compile(JSON.parse(source));
}

process.stdout.write(`Validated ${schemaFiles.length} JSON schemas.\n`);
