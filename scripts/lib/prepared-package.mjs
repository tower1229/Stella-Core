import assert from "node:assert/strict";
import { cp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileManifest, sha256, treeManifest } from "./package-evidence.mjs";
import { PACKAGE_PLAN_VERSION } from "./package-shards.mjs";

export async function writePreparedPackage(directory, receipt, source) {
  assert.equal(receipt.status, "prepared");
  for (const key of ["sourceUnchanged", "workspaceHostUnchanged", "fixturesUnchanged", "buildUnchanged", "artifactUnchanged"])
    assert.equal(receipt[key], true, `Cannot freeze a failed preparation: ${key}`);
  const { preparedData, ...summary } = receipt;
  const prepared = { ...summary, ...preparedData, schemaVersion: "stella.prepared-package/v1", source };
  // The uploaded descriptor is written only after every producer integrity check.
  await writeFile(path.join(directory, "prepared.json"), JSON.stringify(prepared, null, 2));
}

export async function loadPreparedPackage(directory, root, source, { restore = false } = {}) {
  const bytes = await readFile(path.join(directory, "prepared.json"));
  const prepared = { ...JSON.parse(bytes), preparedSha256: sha256(bytes) };
  assert.equal(prepared.schemaVersion, "stella.prepared-package/v1");
  assert.equal(prepared.planVersion, PACKAGE_PLAN_VERSION);
  assert.equal(prepared.status, "prepared");
  assert.equal(prepared.coreRevision, source.coreRevision, "Frozen package checkout mismatch");
  assert.equal(prepared.sourceManifestSha256, source.digest, "Frozen package source mismatch");
  assert.deepEqual(prepared.source, source, "Frozen source manifest mismatch");
  assert.equal(path.basename(prepared.packed.filename), prepared.packed.filename);
  assert.equal(sha256(await readFile(path.join(directory, prepared.packed.filename))), prepared.artifactSha256, "Frozen tarball changed");
  for (const [bundle, target, expected, key] of [
    ["compiled-fixtures", ".test-dist", prepared.fixtures, "compiledFixtureSha256"],
    ["compiled-build", "dist", prepared.build, "compiledBuildSha256"],
  ]) {
    assert.equal((await treeManifest(path.join(directory, bundle))).digest, expected.digest, `Frozen ${bundle} changed`);
    assert.equal(expected.digest, prepared[key]);
    assert.deepEqual(JSON.parse(await readFile(path.join(directory, bundle, "build-identity.json"), "utf8")),
      { coreRevision: source.coreRevision, sourceClean: true });
    if (restore) {
      // Fresh CI checkouts must not already contain a different compiled tree.
      await cp(path.join(directory, bundle), path.join(root, target), { recursive: true, errorOnExist: true, force: false });
      assert.equal((await treeManifest(path.join(root, target))).digest, expected.digest);
    }
  }
  const runtimeFiles = prepared.packed.files.map(entry => entry.path).filter(file => file !== "package.json");
  // Runtime files outside dist must also match the producer checkout. Compiled
  // bytes are verified above and every installed file is checked by each shard.
  const sourceFiles = runtimeFiles.filter(file => !file.startsWith("dist/"));
  const expected = prepared.extracted.entries.filter(entry => sourceFiles.includes(entry.path));
  assert.deepEqual((await fileManifest(root, sourceFiles)).entries, expected);
  return prepared;
}
