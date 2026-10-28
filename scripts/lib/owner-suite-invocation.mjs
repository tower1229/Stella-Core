import path from "node:path";
import { readdir, lstat } from "node:fs/promises";

/** Same complete, top-level *.test.js set as the former shell expansion. */
export async function compiledOwnerSuite(root) {
  const directory = path.join(root, ".test-dist/tests"), files = [];
  for (const name of (await readdir(directory)).filter(name => name.endsWith(".test.js")).sort()) {
    const file = path.join(directory, name), stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("compiled_test_file_invalid");
    files.push(file);
  }
  const ownerFile = path.join(directory, "checkpoint-agent-supply.test.js");
  if (!files.length || !files.includes(ownerFile)) throw new Error("compiled_owner_test_missing");
  return { files, ownerFile };
}

/** Prepared test files only: the acceptance parent directly owns this Node CLI,
 * avoiding npm's compound shell for the resource-owning test step. */
export function ownerSuiteInvocation(root, files, ownerFile) {
  if (!Array.isArray(files) || !files.length || typeof ownerFile !== "string") throw new Error("owner_suite_invocation_invalid");
  return { command: process.execPath, args: [path.resolve(root, "scripts/run-sdk-owner-test.mjs"),
    "--suite", "--owner-file", path.resolve(root, ownerFile), ...files.map(file => path.resolve(root, file))] };
}
