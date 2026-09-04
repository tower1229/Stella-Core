import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const compilerPath = require.resolve("typescript/bin/tsc");
const mode = process.argv[2];
const settings = {
  build: { config: "tsconfig.build.json", output: "dist" },
  test: { config: "tsconfig.test.json", output: ".test-dist" },
}[mode];

if (!settings) throw new Error("compile mode must be build or test");
await rm(path.join(projectRoot, settings.output), { recursive: true, force: true });

await new Promise((resolve, reject) => {
  const compiler = spawn(
    process.execPath,
    [compilerPath, "-p", settings.config],
    { cwd: projectRoot, stdio: "inherit" },
  );
  compiler.once("error", reject);
  compiler.once("exit", (code, signal) => {
    if (code === 0) resolve();
    else reject(new Error(`TypeScript compiler failed (${signal ?? code})`));
  });
});
