import { superviseOwnerTest, superviseOwnerSuite } from "./lib/sdk-owner-supervisor.mjs";

const cancellation = new AbortController();
const onSignal = () => cancellation.abort();
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, onSignal);
try {
  const args = process.argv.slice(2);
  let result;
  if (args[0] === "--suite") {
    if (args[1] !== "--owner-file" || !args[2] || args.length < 4) throw new Error("owner_suite_cli_invalid");
    result = await superviseOwnerSuite({ ownerFile: args[2], files: args.slice(3), signal: cancellation.signal });
  } else result = await superviseOwnerTest({ args, signal: cancellation.signal });
  process.stderr.write(`SDK_OWNER_RESULT ${JSON.stringify(result)}\n`);
  process.exitCode = result.passed ? 0 : result.child.exitCode || 1;
} catch (error) {
  process.stderr.write(`SDK_OWNER_ERROR ${error.code ?? error.message}\n`); process.exitCode = 1;
} finally {
  for (const signal of ["SIGINT", "SIGTERM"]) process.removeListener(signal, onSignal);
}
