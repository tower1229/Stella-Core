import { spawn } from "node:child_process";

/** Only this newly spawned native suite's POSIX group. No caller supplies IDs,
 * no process discovery, and no ownership of descendants that leave the group. */
export function spawnOwnedNodeTestSuite(files, { cwd, env }) {
  if (!["darwin", "linux"].includes(process.platform)) throw new Error("owner_suite_platform_unsupported");
  if (!Array.isArray(files) || !files.length || !files.every(file => typeof file === "string" && file.startsWith("/") && /\.test\.(m?js)$/.test(file)))
    throw new Error("owner_suite_files_invalid");
  const child = spawn(process.execPath, ["--test", "--test-concurrency=4", "--test-reporter=tap", ...files], {
    cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"],
  });
  let pid = null, confirmedGone = false, requested = false, escalated = false, unexpectedSurvivors = false;
  let error = null, stopping, failControl;
  const signals = [], failure = new Promise(resolve => { failControl = resolve; });
  const status = () => ({ pid, confirmedGone, terminationRequested: requested, escalated, unexpectedSurvivors, signals: [...signals], error });
  const fail = cause => { error ??= cause.code ?? cause.message; failControl(status()); };
  // POSIX encodes an exact process-group target as -PGID. The PGID must be
  // positive and captured from this successful spawn, never 0, 1 or an input.
  function target() {
    if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error("owner_group_identity_invalid");
    return -pid;
  }
  function absent() {
    if (confirmedGone) return true;
    if (error) return false;
    try { process.kill(target(), 0); return false; }
    catch (cause) {
      if (cause.code === "ESRCH") { confirmedGone = true; return true; }
      fail(cause); return false;
    }
  }
  function send(signal) {
    if (confirmedGone || error) return;
    try { process.kill(target(), signal); signals.push(signal); }
    catch (cause) { if (cause.code === "ESRCH") confirmedGone = true; else fail(cause); }
  }
  function interrupt() {
    requested = true;
    if (!pid || stopping || confirmedGone || error) return;
    stopping = (async () => {
      const start = performance.now(); send("SIGTERM");
      while (!confirmedGone && !error) {
        if (absent()) break;
        const elapsed = performance.now() - start;
        if (elapsed >= 1000 && !escalated) { escalated = true; send("SIGKILL"); }
        if (elapsed >= 2000 && !confirmedGone) { fail(new Error("owner_group_exit_unconfirmed")); break; }
        // Bounded kernel-state polling, not a delay used to assume quiescence.
        if (!confirmedGone && !error) await new Promise(resolve => setTimeout(resolve, 10));
      }
    })().catch(fail);
  }
  child.once("spawn", () => {
    if (!Number.isSafeInteger(child.pid) || child.pid <= 1) { fail(new Error("owner_group_identity_invalid")); return; }
    pid = child.pid;
    if (requested) interrupt();
  });
  child.once("exit", () => {
    // Leader exit does not release ownership of the remaining group members.
    if (pid && !stopping && !error && !absent()) { unexpectedSurvivors = true; interrupt(); }
  });
  return { child, interrupt, failure, status, async settle() {
    if (!pid) { fail(new Error("owner_group_not_created")); return status(); }
    if (!confirmedGone && !stopping && !error && !absent()) { unexpectedSurvivors = true; interrupt(); }
    await stopping; return status();
  } };
}
