import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { listenOnLoopback } from "./loopback-server.js";

test("loopback startup rejects the original asynchronous bind error", async t => {
  const server = createServer();
  const listeningListeners = server.listenerCount("listening");
  const denied = Object.assign(new Error("Synthetic listener permission denial"), { code: "EPERM" });
  t.mock.method(server, "listen", () => {
    process.nextTick(() => server.emit("error", denied));
    return server;
  });
  await assert.rejects(listenOnLoopback(t, server), error => error === denied);
  assert.equal(server.listening, false);
  assert.equal(server.listenerCount("error"), 0);
  assert.equal(server.listenerCount("listening"), listeningListeners);
});

test("loopback startup preserves synchronous failure without leaving listeners", async t => {
  const server = createServer();
  const listeningListeners = server.listenerCount("listening");
  const failed = new Error("Synthetic synchronous listener failure");
  t.mock.method(server, "listen", () => { throw failed; });
  await assert.rejects(listenOnLoopback(t, server), error => error === failed);
  assert.equal(server.listenerCount("error"), 0);
  assert.equal(server.listenerCount("listening"), listeningListeners);
});
