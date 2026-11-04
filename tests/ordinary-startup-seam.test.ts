import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";

// Preserve the useful old startup assertion against the actual ordinary entry.
test("ordinary plugin imports through the real SDK without identity directory enumeration", async () => {
  let scans = 0;
  const original = fsp.readdir, originalSync = fs.readdirSync;
  fsp.readdir = (() => { scans++; throw new Error("Unexpected directory enumeration during plugin import"); }) as typeof fsp.readdir;
  fs.readdirSync = (() => { scans++; throw new Error("Unexpected sync directory enumeration during plugin import"); }) as typeof fs.readdirSync;
  syncBuiltinESMExports();
  try {
    const plugin = (await import("../src/ordinary-plugin.js")).default;
    assert.equal(typeof plugin.register, "function");
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(scans, 0);
  } finally {
    fsp.readdir = original; fs.readdirSync = originalSync; syncBuiltinESMExports();
  }
});
