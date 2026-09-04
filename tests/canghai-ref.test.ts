import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { parseCangHaiRef, resolveCangHaiRef } from "../src/canghai/ref.js";

test("parses a repository-relative path ref with fragment", () => {
  const ref = parseCangHaiRef("path:50_PersonalAgent/corpus-registry.yaml#canonical_subject");
  assert.equal(ref.relativePath, "50_PersonalAgent/corpus-registry.yaml");
  assert.equal(ref.fragment, "canonical_subject");
});

test("rejects unsupported reference schemes", () => {
  assert.throws(() => parseCangHaiRef("http:https://example.com"));
});

test("rejects repository traversal", () => {
  assert.throws(() => parseCangHaiRef("path:../outside.yaml"));
});

test("resolves inside the CangHai root", () => {
  const root = path.resolve("tmp", "canghai");
  const resolved = resolveCangHaiRef(root, "path:50_PersonalAgent/stella/manifest.yaml");
  assert.equal(resolved.absolutePath, path.join(root, "50_PersonalAgent/stella/manifest.yaml"));
});
