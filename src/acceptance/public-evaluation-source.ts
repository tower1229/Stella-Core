import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { bytesVersion, canonicalJson } from "../canghai/content-version.js";
import { isRecord } from "../shared/type-guards.js";

const declarationPath = ".stella-public-evaluation-source.json";
const schemaVersion = "stella.public-evaluation-source/v1";
const contextPolicy = "case_only";

async function inventory(root: string, relative = ""): Promise<Record<string, string>> {
  const files = new Map<string, string>();
  for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
    if (!relative && (entry.name === ".git" || entry.name === declarationPath)) continue;
    const file = path.posix.join(relative, entry.name);
    if (entry.isDirectory()) {
      for (const [name, hash] of Object.entries(await inventory(root, file))) files.set(name, hash);
    } else if (entry.isFile()) files.set(file, bytesVersion(await readFile(path.join(root, file))));
    else throw new Error("public_evaluation_source_non_regular_entry");
  }
  return Object.fromEntries(files);
}

/** Generator provenance and drift detection, not semantic certification of arbitrary repositories. */
export async function declarePublicEvaluationSource(root: string): Promise<void> {
  const files = await inventory(root);
  await writeFile(path.join(root, declarationPath), canonicalJson({ schemaVersion, contextPolicy, files }), { flag: "wx" });
}

/** Check the initial source before any case writes or model calls. Never filter personal prose. */
export async function assertPublicEvaluationSource(root: string): Promise<void> {
  let value: unknown;
  try { value = JSON.parse(await readFile(path.join(root, declarationPath), "utf8")); }
  catch { throw new Error("public_evaluation_source_declaration_required: run npm run prepare:evaluation-source"); }
  if (!isRecord(value) || value.schemaVersion !== schemaVersion || value.contextPolicy !== contextPolicy ||
      Object.keys(value).length !== 3 || !isRecord(value.files)) {
    throw new Error("public_evaluation_source_declaration_invalid");
  }
  if (canonicalJson(value.files) !== canonicalJson(await inventory(root))) {
    throw new Error("public_evaluation_source_changed: regenerate the public source; do not reseal a personal repository");
  }
}
