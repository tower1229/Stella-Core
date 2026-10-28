import { spawn, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { realpathSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const compilerPath = require.resolve("typescript/bin/tsc");
export async function compile(mode, { signal } = {}) {
  signal?.throwIfAborted();
  const settings = {
    build: { config: "tsconfig.build.json", output: "dist" },
    test: { config: "tsconfig.test.json", output: ".test-dist" },
  }[mode];

  if (!settings) throw new Error("compile mode must be build or test");
  await rm(path.join(projectRoot, settings.output), { recursive: true, force: true });
  signal?.throwIfAborted();

  await new Promise((resolve, reject) => {
    const compiler = spawn(
      process.execPath,
      [compilerPath, "-p", settings.config],
      { cwd: projectRoot, stdio: "inherit" },
    );
    let failure, timer;
    const abort = () => { compiler.kill("SIGTERM"); timer ??= setTimeout(() => compiler.kill("SIGKILL"), 1000); };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    compiler.once("error", error => { failure = error; });
    compiler.once("close", (code, endedSignal) => {
      clearTimeout(timer); signal?.removeEventListener("abort", abort);
      if (failure || signal?.aborted) reject(failure ?? signal.reason);
      else if (code === 0 && endedSignal === null) resolve();
      else reject(new Error(`TypeScript compiler failed (${endedSignal ?? code})`));
    });
  });
  signal?.throwIfAborted();

  const git = (args) => execFileSync("git", args, { cwd: projectRoot, encoding: "utf8" }).trim();
  await writeFile(path.join(projectRoot, settings.output, "build-identity.json"), JSON.stringify({
    coreRevision: git(["rev-parse", "HEAD"]), sourceClean: git(["status", "--porcelain"]) === "",
  }));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  const cancellation = new AbortController(), abort = () => cancellation.abort();
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, abort);
  try { await compile(process.argv[2], { signal: cancellation.signal }); }
  finally { for (const signal of ["SIGINT", "SIGTERM"]) process.removeListener(signal, abort); }
}
