import path from "node:path";
import { readdir, lstat } from "node:fs/promises";

/** Same complete, top-level *.test.js set as the former shell expansion. */
export async function compiledTestSuite(root) {
  const directory = path.join(root, ".test-dist/tests"), files = [];
  for (const name of (await readdir(directory)).filter(name => name.endsWith(".test.js")).sort()) {
    const file = path.join(directory, name), stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("compiled_test_file_invalid");
    files.push(file);
  }
  if (!files.length) throw new Error("compiled_test_suite_empty");
  return { files };
}
