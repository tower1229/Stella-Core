import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdtemp, open, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const schemaVersion = "stella.test-owned-work/v1";
const rootKey = "STELLA_TEST_OWNER_ROOT", runKey = "STELLA_TEST_OWNER_RUN";
const receiptName = "owned-work.json";
const fail = code => Object.assign(new Error(code), { code });

function validateState(value, runId) {
  if (!value || Object.keys(value).sort().join() !== "pending,pendingFailures,runId,schemaVersion,status,stopFailures" ||
    value.schemaVersion !== schemaVersion || value.runId !== runId ||
    !["complete", "shutdown_failed"].includes(value.status) ||
    ![value.pending, value.stopFailures, value.pendingFailures].every(n => Number.isSafeInteger(n) && n >= 0) ||
    value.status === "complete" && (value.pending || value.stopFailures || value.pendingFailures)) throw fail("owned_work_state_invalid");
  return value;
}

/** Child-side test protocol only. This reports test-owned work, not SDK drain.
 * One supervised file owns this terminal report; failure cannot become complete. */
export async function recordOwnedWorkState({ status, pending = 0, stopFailures = 0, pendingFailures = 0 }) {
  const root = process.env[rootKey], runId = process.env[runKey];
  if (!root || !runId) throw fail("owned_work_binding_missing");
  const value = validateState({ schemaVersion, runId, status, pending, stopFailures, pendingFailures }, runId);
  const target = path.join(root, receiptName);
  let previous;
  try { previous = validateState(JSON.parse(await readFile(target, "utf8")), runId); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  if (previous?.status === "shutdown_failed") return;
  const partial = path.join(root, `owned-work-${randomUUID()}.partial`);
  await writeFile(partial, JSON.stringify(value), { mode: 0o600, flag: "wx" });
  await rename(partial, target);
}

function validateArgs(args) {
  if (!Array.isArray(args)) throw fail("owner_test_args_invalid");
  const files = [];
  for (const arg of args) {
    if (typeof arg !== "string" || !arg || arg.includes("\0")) throw fail("owner_test_args_invalid");
    if (arg.startsWith("--")) {
      if (files.length) throw fail("owner_test_option_order_invalid");
      if (!/^--test-reporter=(tap|spec)$/.test(arg) && !/^--test-name-pattern=.+$/s.test(arg) &&
        !/^--test-timeout=[1-9][0-9]*$/.test(arg)) throw fail("owner_test_option_unsupported");
    } else files.push(arg);
  }
  // This first slice supervises exactly one file process and its threads. It is
  // not a shell/npm launcher or a general process-tree management interface.
  if (files.length !== 1 || !/\.test\.(m?js)$/.test(files[0])) throw fail("owner_test_file_required");
  return files[0];
}

async function captureRoot() {
  const base = await realpath(os.tmpdir());
  const root = await mkdtemp(path.join(base, "stella-sdk-owner-"));
  const identity = await assertRoot(root);
  return { root, identity };
}

async function assertRoot(root, identity) {
  const stat = await lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o700 ||
    await realpath(root) !== root || identity && (stat.dev !== identity.dev || stat.ino !== identity.ino)) throw fail("owner_root_identity_invalid");
  return { dev: stat.dev, ino: stat.ino };
}

async function readOwnedWork(root, runId) {
  const handle = await open(path.join(root, receiptName), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 4096) throw fail("owned_work_state_invalid");
    return validateState(JSON.parse(await handle.readFile("utf8")), runId);
  } finally { await handle.close(); }
}

/** No deletion path is accepted from a caller, environment, or child receipt.
 * A direct file process provides the owner lifetime, including worker_threads.
 * Detached/external descendants are outside this contract. Interruptions before
 * removal retain the root; after rm starts, report failure and its actual outcome.
 * No inferred descendant termination unlocks removal. */
export async function superviseOwnerTest(options) {
  const allowed = ["args", "cwd", "env", "signal", "timeoutMs", "stdout", "stderr"];
  if (!options || Object.keys(options).some(key => !allowed.includes(key))) throw fail("owner_options_invalid");
  const file = validateArgs(options.args), cwd = await realpath(options.cwd ?? process.cwd());
  const fileStat = await lstat(path.resolve(cwd, file));
  if (!fileStat.isFile() || fileStat.isSymbolicLink()) throw fail("owner_test_file_invalid");
  const timeoutMs = options.timeoutMs ?? 600_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 600_000) throw fail("owner_timeout_invalid");
  const env = { ...(options.env ?? process.env) };
  if (env.NODE_OPTIONS) throw fail("owner_node_options_unsupported");
  delete env.NODE_OPTIONS; delete env.NODE_PATH; delete env.NODE_TEST_CONTEXT;
  const { root, identity } = await captureRoot(), runId = randomUUID();
  env[rootKey] = root; env[runKey] = runId;
  const logErrors = [], errors = [], writes = new Set();
  let child, timer, killTimer, stdioTimer, closed = false, interrupted, timedOut = false;
  const destinations = [options.stdout ?? process.stdout, options.stderr ?? process.stderr];
  const interrupt = reason => {
    interrupted ??= reason;
    if (child && !closed) {
      try { child.kill("SIGTERM"); } catch (error) { errors.push(error.code ?? error.message); }
      killTimer ??= setTimeout(() => {
        if (!closed) {
          try { child.kill("SIGKILL"); } catch (error) { errors.push(error.code ?? error.message); }
          child.stdout.destroy(); child.stderr.destroy();
        }
      }, 1000);
    }
  };
  const abort = () => interrupt("cancelled");
  const logFailure = error => { logErrors.push(error.code ?? error.message); interrupt("log_failure"); };
  for (const stream of destinations) stream.on("error", logFailure);
  let exitCode = null, signal = null, closeObserved = false;
  try {
    if (options.signal?.aborted) interrupted = "cancelled";
    else {
      options.signal?.addEventListener("abort", abort, { once: true });
      child = spawn(process.execPath, options.args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
      for (const [index, source] of [child.stdout, child.stderr].entries()) {
        source.on("error", logFailure);
        source.on("data", bytes => {
          source.pause();
          let resolve;
          const work = new Promise(done => { resolve = done; }); writes.add(work);
          const done = error => { if (error) logFailure(error); writes.delete(work); resolve(); source.resume(); };
          try { destinations[index].write(bytes, done); } catch (error) { done(error); }
        });
      }
      child.on("error", error => { errors.push(error.code ?? error.message); });
      child.once("exit", () => {
        // A stalled destination can pause the pipe and prevent ChildProcess
        // close even after exit. Bound that wait independently of close.
        stdioTimer = setTimeout(() => {
          if (writes.size || !child.stdout.readableEnded || !child.stderr.readableEnded) {
            logFailure(fail("owner_log_drain_timeout")); child.stdout.destroy(); child.stderr.destroy();
          }
        }, 1000);
      });
      timer = setTimeout(() => { timedOut = true; interrupt("timeout"); }, timeoutMs);
      await new Promise(resolve => child.once("close", (code, endedSignal) => {
        closed = true; closeObserved = true; exitCode = code; signal = endedSignal; resolve();
      }));
      let drainTimer;
      try {
        await Promise.race([Promise.all([...writes]), new Promise(resolve => {
          drainTimer = setTimeout(() => { logFailure(fail("owner_log_drain_timeout")); resolve(); }, 1000);
        })]);
      } finally { clearTimeout(drainTimer); }
    }
  } catch (error) { errors.push(error.code ?? error.message); }
  finally {
    clearTimeout(timer); clearTimeout(killTimer); clearTimeout(stdioTimer);
  }
  try {
    const stdioComplete = child?.stdout.readableEnded === true && child?.stderr.readableEnded === true;
    let ownedWork = null, rootValid = false, cleanup = "retained", cleanupStarted = false;
    try { await assertRoot(root, identity); rootValid = true; ownedWork = await readOwnedWork(root, runId); }
    catch (error) { errors.push(error.code ?? error.message); }
    const mayRemove = () => rootValid && ownedWork?.status === "complete" && closeObserved && !interrupted &&
      signal === null && stdioComplete && !errors.length && !logErrors.length;
    if (mayRemove()) try {
      // Revalidate first, then check live failure state. No await separates this
      // last gate from the one rm call. Once submitted, rm cannot be rolled back.
      await assertRoot(root, identity);
      if (mayRemove()) {
        cleanupStarted = true; await rm(root, { recursive: true }); cleanup = "removed";
      }
    } catch (error) {
      if (cleanupStarted) cleanup = "removal_failed";
      errors.push(error.code ?? error.message);
    }
    return { passed: exitCode === 0 && mayRemove() && cleanup === "removed",
      child: { exitCode, signal, killed: child?.killed ?? false, closeObserved },
      interrupted: interrupted ?? null, timedOut, stdioComplete, logErrors, errors,
      ownedWork, cleanup: { root, status: cleanup, started: cleanupStarted } };
  } finally {
    options.signal?.removeEventListener("abort", abort);
    for (const stream of destinations) stream.removeListener("error", logFailure);
  }
}
