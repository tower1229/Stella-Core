import assert from "node:assert/strict";
import test from "node:test";
import { readFile, mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";
import { HOST_COMPATIBILITY, hostModuleHash, parseHostCompatibility, patchPrivateDraftHost, assertSameHostCompatibility } from "../src/acceptance/host-compatibility.js";
import { parseExactHostRecoveryReceipt } from "../src/acceptance/exact-host-evidence.js";

test("compatibility patch is byte-pinned, idempotent, and refuses unrelated module changes", async () => {
  const require = createRequire(import.meta.url);
  const dist = path.resolve(path.dirname(require.resolve("openclaw/plugin-sdk/plugin-entry")), "..");
  const original = await readFile(path.join(dist, path.basename(HOST_COMPATIBILITY.module)));
  assert.equal(hostModuleHash(original), HOST_COMPATIBILITY.originalSha256);
  const patched = patchPrivateDraftHost(original);
  assert.equal(hostModuleHash(patched), HOST_COMPATIBILITY.patchedSha256);
  assert.deepEqual(patchPrivateDraftHost(patched), patched);
  assert.throws(() => patchPrivateDraftHost(Buffer.concat([original, Buffer.from("\n")])), /original_module_mismatch/);
  assert.deepEqual(parseHostCompatibility(HOST_COMPATIBILITY), HOST_COMPATIBILITY);
  assert.throws(() => parseHostCompatibility({ ...HOST_COMPATIBILITY, patchedSha256: "0".repeat(64) }), /compatibility_mismatch/);
  assert.throws(() => parseExactHostRecoveryReceipt({ hostCompatibility: { id: HOST_COMPATIBILITY.id } }), /compatibility_mismatch/);
});

test("candidate evidence cannot mix original and compatibility-patched Hosts", () => {
  assert.doesNotThrow(() => assertSameHostCompatibility(undefined, undefined, undefined));
  assert.doesNotThrow(() => assertSameHostCompatibility(HOST_COMPATIBILITY, { ...HOST_COMPATIBILITY }, HOST_COMPATIBILITY));
  assert.throws(() => assertSameHostCompatibility(HOST_COMPATIBILITY, undefined, HOST_COMPATIBILITY), /compatibility_mismatch/);
});

test("isolated installer supports every acceptance runner but rejects unrelated consumers", async () => {
  const { installHostCompatibility } = await import(pathToFileURL(path.resolve("scripts/lib/install-host-compatibility.mjs")).href);
  const require = createRequire(import.meta.url);
  const dist = path.resolve(path.dirname(require.resolve("openclaw/plugin-sdk/plugin-entry")), "..");
  const original = await readFile(path.join(dist, path.basename(HOST_COMPATIBILITY.module)));
  const root = await mkdtemp(path.join(os.tmpdir(), "stella-host-installer-test-"));
  try {
    const hostRoot = path.join(root, "node_modules/openclaw");
    const target = path.join(hostRoot, HOST_COMPATIBILITY.module);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(path.join(hostRoot, "package.json"), JSON.stringify({ version: HOST_COMPATIBILITY.hostVersion }));
    for (const name of ["stella-private-recovery", "stella-private-evaluation", "stella-private-praxis"]) {
      await writeFile(path.join(root, "package.json"), JSON.stringify({ name, private: true }));
      await writeFile(target, original);
      assert.deepEqual(await installHostCompatibility(root), HOST_COMPATIBILITY);
      assert.equal(hostModuleHash(await readFile(target)), HOST_COMPATIBILITY.patchedSha256);
    }
    for (const manifest of [{ name: "unrelated", private: true }, { name: "stella-private-praxis", private: false }]) {
      await writeFile(path.join(root, "package.json"), JSON.stringify(manifest));
      await writeFile(target, original);
      await assert.rejects(() => installHostCompatibility(root), /requires_isolated_consumer/);
      assert.deepEqual(await readFile(target), original);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
