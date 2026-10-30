import { fileURLToPath } from "node:url";
import { compile } from "./compile.mjs";
import { compiledOwnerSuite } from "./lib/owner-suite-invocation.mjs";
import { superviseOwnerSuite } from "./lib/sdk-owner-supervisor.mjs";

if (process.argv.length !== 2) throw new Error("workspace_test_arguments_unsupported");
const root = fileURLToPath(new URL("../", import.meta.url));
const cancellation = new AbortController(), abort = () => cancellation.abort();
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, abort);
try {
  for (const mode of ["build", "test"]) await compile(mode, { signal: cancellation.signal });
  cancellation.signal.throwIfAborted();
  const suite = await compiledOwnerSuite(root);
  // The acceptance parent owns its existing deadline (Experimental test: 900s;
  // prepare: job deadline). Do not add a new 600s limit to npm test/prepare.
  const result = await superviseOwnerSuite({ ...suite, cwd: root, signal: cancellation.signal, timeoutMs: null });
  process.stderr.write(`WORKSPACE_TEST_RESULT ${JSON.stringify(result)}\n`);
  process.exitCode = result.passed ? 0 : result.child.exitCode || 1;
} catch (error) {
  process.stderr.write(`WORKSPACE_TEST_ERROR ${error.code ?? error.message}\n`); process.exitCode = 1;
} finally { for (const signal of ["SIGINT", "SIGTERM"]) process.removeListener(signal, abort); }
