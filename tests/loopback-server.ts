import type { Server } from "node:http";
import type { TestContext } from "node:test";

export async function listenOnLoopback(t: TestContext, server: Server): Promise<void> {
  t.after(async () => {
    if (server.listening) {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      server.removeListener("error", onError);
      server.removeListener("listening", onListening);
    };
    const onError = (error: Error) => { cleanup(); reject(error); };
    const onListening = () => { cleanup(); resolve(); };
    server.once("error", onError);
    server.once("listening", onListening);
    try { server.listen(0, "127.0.0.1"); }
    catch (error) { cleanup(); reject(error); }
  });
}
