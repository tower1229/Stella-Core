import assert from "node:assert/strict";
import { readFile, realpath, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

// Public package metadata/exports only. This does not authenticate a Host tree.
export async function probeHost(root) {
  const hostRoot = await realpath(process.env.STELLA_PROBE_HOST_ROOT ?? path.join(root, "node_modules/openclaw"));
  const metadata = JSON.parse(await readFile(path.join(hostRoot, "package.json"), "utf8"));
  assert.equal(metadata.name, "openclaw"); assert.equal(metadata.version, "2026.8.2");
  const sdk = createRequire(path.join(hostRoot, "package.json")).resolve("openclaw/plugin-sdk/gateway-runtime");
  return { hostRoot, openclawBin: path.join(hostRoot, "openclaw.mjs"),
    GatewayClient: (await import(pathToFileURL(sdk))).GatewayClient,
    evidence: { root: hostRoot, version: metadata.version, launcher: path.join(hostRoot, "openclaw.mjs"), controllerSdk: sdk, fullTreeVerified: false } };
}

export async function isolatedProbeCommand({ root, out, state, home, hostRoot, args }) {
  if (process.platform !== "darwin") {
    assert.ok(process.platform === "linux" && process.env.GITHUB_ACTIONS === "true",
      "Non-Mac execution is restricted to isolated Linux GitHub Actions runners");
    return { command: process.execPath, args, sandboxed: false, isolation: "ephemeral Linux CI runner; isolated synthetic HOME/state/cache/provider" };
  }
  const dependencies = await realpath(path.join(root, "node_modules"));
  const readable = [root, dependencies, hostRoot, path.dirname(process.execPath)];
  const writable = [out, state, home];
  const ancestors = new Set();
  for (const readablePath of readable) {
    for (let p = path.dirname(readablePath); p !== path.dirname(p); p = path.dirname(p)) {
      if (p === "/Users/zangtao" || p.startsWith("/Users/zangtao/")) ancestors.add(p);
    }
  }
  const sandbox = `(version 1)
(allow default)
(deny file-read* (subpath "/Users/zangtao"))
(allow file-read-metadata ${[...ancestors].map(p => `(literal ${JSON.stringify(p)})`).join(" ")})
(allow file-read* ${readable.map(p => `(subpath ${JSON.stringify(p)})`).join(" ")})
(deny file-write* (subpath "/Users/zangtao"))
(allow file-write* ${writable.map(p => `(subpath ${JSON.stringify(p)})`).join(" ")})
(deny network-outbound)
(allow network-outbound (remote ip "localhost:*"))
(deny process-exec (literal "/bin/ps") (literal "/usr/bin/ps"))
`;
  const profile = path.join(out, "host-sandbox.sb"); await writeFile(profile, sandbox);
  return { command: "/usr/bin/sandbox-exec", args: ["-f", profile, process.execPath, ...args], sandboxed: true, isolation: "Mac sandbox: local synthetic writes and loopback only" };
}

// A probe owns its Gateway child. Cancellation waits for its normal cleanup,
// rather than relying on Node's default immediate SIGTERM exit or querying PIDs.
export function onProbeCancellation(cancel, cleanup) {
  let pending;
  const handler = signal => {
    if (pending) return;
    cancel(signal);
    pending = (async () => {
      try { await cleanup(); }
      catch (error) { process.stderr.write(`Probe cancellation cleanup failed: ${error}\n`); }
      finally { process.exit(1); }
    })();
  };
  process.on("SIGTERM", () => handler("SIGTERM")); process.on("SIGINT", () => handler("SIGINT"));
}
