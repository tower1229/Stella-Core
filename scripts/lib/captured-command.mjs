import { execFile } from "node:child_process";
import { createWriteStream } from "node:fs";
import { finished } from "node:stream/promises";
import { promisify } from "node:util";

const exec = promisify(execFile);

/** Capture one owned child without depending on its stdio emitting normal end.
 * createLog/drainTimeoutMs allow deterministic stream-failure tests. */
export async function captureCommand(command, args, options, {
  stdoutPath, stderrPath, children, drainTimeoutMs = 5_000, createLog = createWriteStream,
}) {
  if (!Number.isSafeInteger(drainTimeoutMs) || drainTimeoutMs <= 0) throw new RangeError("capture_drain_timeout_invalid");
  const logs = [], drains = [], logErrors = [];
  let child, result, failure, settled = false;
  const logError = (file, error) => {
    logErrors.push({ file, code: error.code ?? null, message: error.message ?? String(error) });
    if (child && child.exitCode === null && child.signalCode === null) {
      try { child.kill("SIGTERM"); }
      catch (killError) { logErrors.push({ code: killError.code ?? null, message: killError.message }); }
    }
  };
  try {
    for (const file of [stdoutPath, stderrPath]) {
      const log = createLog(file); logs.push(log);
      // Handle rejection now, not after a potentially long child command.
      drains.push(finished(log, { cleanup: true }).catch(error => logError(file, error)));
    }
    const pending = exec(command, args, options);
    child = pending.child; children?.add(child);
    child.stdout.pipe(logs[0]); child.stderr.pipe(logs[1]);
    result = await pending;
  } catch (error) { failure = error; }
  finally {
    child?.stdout?.unpipe(logs[0]); child?.stderr?.unpipe(logs[1]);
    for (const [index, log] of logs.entries()) if (!log.destroyed && !log.writableEnded) {
      try { log.end(); }
      catch (error) { logError([stdoutPath, stderrPath][index], error); log.destroy(); }
    }
    let timer;
    try {
      // Keep this timer referenced: an unresolved drain alone cannot keep Node
      // alive, which was the source of the unsettled top-level-await exit13.
      settled = await Promise.race([
        Promise.all(drains).then(() => true),
        new Promise(resolve => { timer = setTimeout(() => resolve(false), drainTimeoutMs); }),
      ]);
      if (!settled) {
        logErrors.push({ code: "ERR_CAPTURE_LOG_DRAIN_TIMEOUT", message: "Captured logs did not drain before their deadline" });
        for (const log of logs) if (!log.destroyed) log.destroy();
      }
    } finally { clearTimeout(timer); children?.delete(child); }
  }
  const capture = {
    childExit: { code: child?.exitCode ?? null, signal: child?.signalCode ?? null, killed: child?.killed ?? false },
    stdioComplete: child?.stdout?.readableEnded === true && child?.stderr?.readableEnded === true,
    logsDrained: settled && logErrors.length === 0, logErrors,
  };
  // execFile may resolve when a timeout's SIGTERM handler exits0. Require
  // normal child completion and complete stdio independently of that Promise.
  const interrupted = capture.childExit.killed || capture.childExit.signal !== null;
  const completedNormally = capture.childExit.code === 0 && !interrupted && capture.stdioComplete;
  if (failure || logErrors.length || !completedNormally) {
    // Keep the original execFile error, including its code/signal/killed and
    // partial stdout/stderr. Log failures are additional facts, never success.
    const error = failure ?? Object.assign(new Error(logErrors.length ? "captured_command_logs_failed" : "captured_command_incomplete"), {
      ...result,
      code: logErrors.length ? "ERR_CAPTURE_LOG_FAILURE" : interrupted ? "ERR_CAPTURE_COMMAND_INTERRUPTED" : "ERR_CAPTURE_STDIO_INCOMPLETE",
      signal: capture.childExit.signal, killed: capture.childExit.killed,
    });
    error.capture = capture;
    throw error;
  }
  return { ...result, capture };
}
