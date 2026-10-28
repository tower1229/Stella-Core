import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

// Test-only execution of the pinned Host caller builder. Production Core uses
// the public SDK and actual reply_dispatch context, not private Host imports.
const sdkEntry = createRequire(import.meta.url).resolve("openclaw/plugin-sdk/plugin-entry");
const hostPackage = path.resolve(path.dirname(sdkEntry), "../../package.json");
assert.equal(JSON.parse(await readFile(hostPackage, "utf8")).version, "2026.10.8");
const dist = path.join(path.dirname(hostPackage), "dist");
const candidates = (await readdir(dist)).filter(name => /^gateway-client-identity-.*\.mjs$/.test(name));
assert.equal(candidates.length, 1);
const { o: callerContext } = await import(pathToFileURL(path.join(dist, candidates[0]!)).href);
assert.equal(typeof callerContext, "function");

export function nativeProfileCaller(profileId: string) {
  const client = { authenticatedUserId: "synthetic-user", authenticatedUserProfile: { profileId, displayName: "Synthetic" },
    invalidated: false, connect: { client: { id: "openclaw-control-ui", mode: "webchat" }, scopes: ["operator.admin"] } };
  const ctx = callerContext(client);
  Object.assign(ctx, { CommandAuthorized: true, SessionCreation: { via: "operator", actor: { type: "human", source: "profile", id: profileId } } });
  return { ctx, revoke() { client.invalidated = true; } };
}
