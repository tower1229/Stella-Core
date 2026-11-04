import { fileURLToPath } from "node:url";
import { compile } from "./compile.mjs";
import { compiledTestSuite } from "./lib/compiled-test-suite.mjs";
import { superviseTestSuite } from "./lib/sdk-owner-supervisor.mjs";

if (process.argv.length !== 2) throw new Error("workspace_test_arguments_unsupported");
const root = fileURLToPath(new URL("../", import.meta.url));
const cancellation = new AbortController(), abort = () => cancellation.abort();
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, abort);
try {
  for (const mode of ["build", "test"]) await compile(mode, { signal: cancellation.signal });
  cancellation.signal.throwIfAborted();
  const suite = await compiledTestSuite(root);
  // The caller owns the workspace deadline. Standalone owner probes retain
  // their bounded timeout; ordinary tests need no fabricated fixture owner.
  const result = await superviseTestSuite({ ...suite, cwd: root, signal: cancellation.signal, timeoutMs: null });
  process.stderr.write(`WORKSPACE_TEST_RESULT ${JSON.stringify(result)}\n`);
  process.exitCode = result.passed ? 0 : result.child.exitCode || 1;
} catch (error) {
  process.stderr.write(`WORKSPACE_TEST_ERROR ${error.code ?? error.message}\n`); process.exitCode = 1;
} finally { for (const signal of ["SIGINT", "SIGTERM"]) process.removeListener(signal, abort); }
