import { superviseOwnerTest } from "./lib/sdk-owner-supervisor.mjs";

const cancellation = new AbortController();
const onSignal = () => cancellation.abort();
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, onSignal);
try {
  const result = await superviseOwnerTest({ args: process.argv.slice(2), signal: cancellation.signal });
  process.stderr.write(`SDK_OWNER_RESULT ${JSON.stringify(result)}\n`);
  process.exitCode = result.passed ? 0 : result.child.exitCode || 1;
} catch (error) {
  process.stderr.write(`SDK_OWNER_ERROR ${error.code ?? error.message}\n`); process.exitCode = 1;
} finally {
  for (const signal of ["SIGINT", "SIGTERM"]) process.removeListener(signal, onSignal);
}
