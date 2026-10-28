import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createAgentSupplyFixtureLifecycle, assertOwnerPreparation } from "./checkpoint-agent-supply-lifecycle.js";

function barrier() {
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; }), released = new Promise<void>(resolve => { release = resolve; });
  return { entered, release, async wait() { enter(); await released; } };
}

test("legacy FIFO deletion can prevent service stop, while eager success diagnostics perform 65 RPCs", async () => {
  // Matches the Node after-hook execution already reproduced in the isolated
  // child evidence: first failure stops the remaining registration-order hooks.
  const events: string[] = [], failure = Object.assign(new Error("synthetic deletion failure"), { code: "ENOTEMPTY" });
  const hooks = [async () => { events.push("remove"); throw failure; }, async () => { events.push("stop"); }];
  await assert.rejects(async () => { for (const hook of hooks) await hook(); }, error => error === failure);
  assert.deepEqual(events, ["remove"]);
  let statusCalls = 0;
  const status = async () => { statusCalls++; return { state: "prepared" }; };
  for (let index = 0; index < 65; index++) assert.equal(undefined, undefined, `completed request ${index + 1}: ${JSON.stringify(await status())}`);
  assert.equal(statusCalls, 65);
});

test("fixture cleanup waits for stop and all known work before deleting directories", { timeout: 2000 }, async () => {
  const lifecycle = createAgentSupplyFixtureLifecycle(new AbortController().signal), stop = barrier(), work = barrier();
  let stopped!: () => void; const stopCompleted = new Promise<void>(resolve => { stopped = resolve; });
  const events: string[] = [];
  lifecycle.stops.push(async () => { events.push("stop"); await stop.wait(); events.push("stopped"); stopped(); });
  const pending = lifecycle.track((async () => { await work.wait(); events.push("work-settled"); })());
  lifecycle.removals.push(() => { events.push("remove-source"); }, () => { events.push("remove-parent"); });
  const closing = lifecycle.close();
  await stop.entered;
  assert.equal(lifecycle.controller.signal.aborted, true); assert.deepEqual(events, ["stop"]);
  stop.release(); await stopCompleted;
  // Once stop settles, held known work still prevents directory removal.
  assert.deepEqual(events, ["stop", "stopped"]); work.release(); await pending; await closing;
  assert.deepEqual(events, ["stop", "stopped", "work-settled", "remove-source", "remove-parent"]);
});

test("a removal error cannot prevent stop or the other removal and is not swallowed or retried", async () => {
  const lifecycle = createAgentSupplyFixtureLifecycle(new AbortController().signal), events: string[] = [];
  const failure = Object.assign(new Error("synthetic ENOTEMPTY"), { code: "ENOTEMPTY" });
  lifecycle.stops.push(() => { events.push("stop"); });
  lifecycle.removals.push(() => { events.push("remove-source"); throw failure; }, () => { events.push("remove-parent"); });
  const first = lifecycle.close(); assert.strictEqual(lifecycle.close(), first);
  await assert.rejects(first, error => error instanceof AggregateError && error.errors.length === 1 && error.errors[0] === failure);
  assert.deepEqual(events, ["stop", "remove-source", "remove-parent"]);
});

test("all stops are attempted, but failed shutdown retains directories with the original error", async () => {
  const lifecycle = createAgentSupplyFixtureLifecycle(new AbortController().signal), events: string[] = [];
  const failure = new Error("synthetic stop failure");
  lifecycle.stops.push(() => { events.push("first-stop"); }, () => { events.push("last-stop"); throw failure; });
  lifecycle.removals.push(() => { events.push("remove"); });
  await assert.rejects(lifecycle.close(), error => error instanceof AggregateError && error.errors[0] === failure);
  assert.deepEqual(events, ["last-stop", "first-stop"]);
});

test("test cancellation reaches existing cancellable work; cleanup joins its completion", { timeout: 2000 }, async () => {
  const testController = new AbortController(), lifecycle = createAgentSupplyFixtureLifecycle(testController.signal), work = barrier();
  const reason = new Error("synthetic test cancellation"), events: string[] = [];
  const pending = lifecycle.track(new Promise<void>(resolve => lifecycle.controller.signal.addEventListener("abort", () => {
    events.push("cancelled"); void work.wait().then(() => { events.push("settled"); resolve(); });
  }, { once: true })));
  lifecycle.stops.push(() => { events.push("stop"); }); lifecycle.removals.push(() => { events.push("remove"); });
  testController.abort(reason); assert.strictEqual(lifecycle.controller.signal.reason, reason);
  const closing = lifecycle.close(); await work.entered; assert.deepEqual(events, ["cancelled", "stop"]);
  work.release(); await pending; await closing; assert.deepEqual(events, ["cancelled", "stop", "settled", "remove"]);
});

test("rejected known work keeps its rejection, runs late stops and fails cleanup without deletion", async () => {
  const lifecycle = createAgentSupplyFixtureLifecycle(new AbortController().signal), gate = barrier(), events: string[] = [];
  const failure = new Error("synthetic operation failed");
  const pending = lifecycle.track((async () => { await gate.wait(); lifecycle.stops.push(() => { events.push("late-stop"); }); throw failure; })());
  lifecycle.removals.push(() => { events.push("remove"); });
  const observed = assert.rejects(pending, error => error === failure), closing = lifecycle.close();
  const cleanupFailed = assert.rejects(closing, error => error instanceof AggregateError && error.errors.includes(failure));
  gate.release(); await observed; await cleanupFailed; assert.deepEqual(events, ["late-stop"]);
});

test("work rejection during a held stop remains a cleanup error after the work leaves the pending set", async () => {
  const lifecycle = createAgentSupplyFixtureLifecycle(new AbortController().signal), stop = barrier(), work = barrier();
  const failure = new Error("synthetic failure during stop"); let removals = 0;
  const pending = lifecycle.track((async () => { await work.wait(); throw failure; })());
  const observed = assert.rejects(pending, error => error === failure);
  lifecycle.stops.push(() => stop.wait()); lifecycle.removals.push(() => { removals++; });
  const closing = lifecycle.close(), failed = assert.rejects(closing, error => error instanceof AggregateError && error.errors.includes(failure));
  await stop.entered; work.release(); await observed; stop.release(); await failed; assert.equal(removals, 0);
});

test("tracking does not hide an ignored rejection from Node's strict unhandled-rejection behavior", async () => {
  const helper = new URL("./checkpoint-agent-supply-lifecycle.js", import.meta.url).href;
  const script = `import {createAgentSupplyFixtureLifecycle} from ${JSON.stringify(helper)};
const lifecycle=createAgentSupplyFixtureLifecycle(new AbortController().signal);
lifecycle.track(Promise.reject(new Error('SYNTHETIC_IGNORED_WORK_FAILURE')));`;
  await assert.rejects(promisify(execFile)(process.execPath, ["--unhandled-rejections=strict", "--input-type=module", "-e", script], { timeout: 2000 }),
    (error: any) => error.code === 1 && error.stderr.includes("SYNTHETIC_IGNORED_WORK_FAILURE"));
});

test("pre-cancelled fixtures are aborted and successful cleanup is idempotent", async () => {
  const controller = new AbortController(); controller.abort("synthetic cancellation");
  const lifecycle = createAgentSupplyFixtureLifecycle(controller.signal); assert.equal(lifecycle.controller.signal.aborted, true);
  const events: string[] = []; lifecycle.stops.push(() => { events.push("stop"); }); lifecycle.removals.push(() => { events.push("remove"); });
  const closing = lifecycle.close(); await closing; assert.strictEqual(lifecycle.close(), closing); assert.deepEqual(events, ["stop", "remove"]);
  assert.equal(lifecycle.track("synchronous hook value"), "synchronous hook value");
});

test("65 successful preparations never evaluate status; failed preparation evaluates it once and still fails", async () => {
  let calls = 0; const diagnostic = async () => { calls++; return { state: "blocked", category: "synthetic refusal" }; };
  for (let index = 0; index < 65; index++) await assertOwnerPreparation(undefined, index, diagnostic);
  assert.equal(calls, 0);
  await assert.rejects(assertOwnerPreparation({ handled: true }, 64, diagnostic), /completed request 65.*synthetic refusal/);
  assert.equal(calls, 1);
});
