import path from "node:path";

/** Prepared test files only: the acceptance parent directly owns this Node CLI,
 * avoiding npm's compound shell for the resource-owning test step. */
export function ownerSuiteInvocation(root, files, ownerFile) {
  if (!Array.isArray(files) || !files.length || typeof ownerFile !== "string") throw new Error("owner_suite_invocation_invalid");
  return { command: process.execPath, args: [path.resolve(root, "scripts/run-sdk-owner-test.mjs"),
    "--suite", "--owner-file", path.resolve(root, ownerFile), ...files.map(file => path.resolve(root, file))] };
}
