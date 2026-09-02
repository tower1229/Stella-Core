import assert from "node:assert/strict";
import { readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  loadConsciousness,
  MAX_CANGHAI_DOCUMENT_BYTES,
} from "../src/canghai/manifest.js";
import {
  createFixture,
  initializeFixtureRepository,
  updateFixtureManifest,
} from "./consciousness-fixture.js";

test("loads and validates a minimal recoverable consciousness manifest", async () => {
  const root = await createFixture();
  try {
    const loaded = await loadConsciousness(root);
    assert.equal(loaded.manifest.instance.id, "stella");
    assert.ok(loaded.requiredReferences.length >= 8);
    assert.deepEqual(
      loaded.bootstrapDocuments.map((document) => document.category),
      ["identity", "identity", "twin", "framework"],
    );
    assert.match(loaded.bootstrapDocuments[2]?.content ?? "", /reversible experiments/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fails when a required durable reference is missing", async () => {
  const root = await createFixture();
  try {
    await rm(path.join(root, "50_PersonalAgent/stella/twin/hypotheses-registry.yaml"));
    await assert.rejects(
      () => loadConsciousness(root),
      (error: unknown) =>
        error instanceof Error &&
        "category" in error &&
        error.category === "stella_reference_invalid",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fails when a nested Twin record is missing", async () => {
  const root = await createFixture();
  try {
    await rm(path.join(root, "30_PersonalData/twin/hypotheses/twin_fixture.md"));
    await assert.rejects(
      () => loadConsciousness(root),
      (error: unknown) =>
        error instanceof Error &&
        "category" in error &&
        error.category === "stella_reference_invalid",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects a CangHai record above the per-document hard limit", async () => {
  const root = await createFixture();
  try {
    await writeFile(
      path.join(root, "30_PersonalData/twin/hypotheses/twin_fixture.md"),
      "x".repeat(MAX_CANGHAI_DOCUMENT_BYTES + 1),
      "utf8",
    );
    await assert.rejects(
      () => loadConsciousness(root),
      (error: unknown) =>
        error instanceof Error &&
        "category" in error &&
        error.category === "stella_record_invalid" &&
        error.message.includes("hard limit"),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("accepts only an active compatible manifest at the explicit recovery revision", async () => {
  const root = await createFixture();
  try {
    const recoveryRevision = await initializeFixtureRepository(root);
    const loaded = await loadConsciousness(root, undefined, {
      recoveryRevision,
      coreVersion: "3.0.0-alpha.0",
      openclawVersion: "2026.8.2",
    });
    assert.equal(loaded.recoveryRevision, recoveryRevision);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("classifies a migration-required consciousness as unavailable", async () => {
  const root = await createFixture();
  try {
    await updateFixtureManifest(root, (manifest) =>
      manifest.replace("activationStatus: active", "activationStatus: migration_required"),
    );
    const recoveryRevision = await initializeFixtureRepository(root);
    await assert.rejects(
      () =>
        loadConsciousness(root, undefined, {
          recoveryRevision,
          coreVersion: "3.0.0-alpha.0",
          openclawVersion: "2026.8.2",
        }),
      (error: unknown) =>
        error instanceof Error &&
        "category" in error &&
        error.category === "stella_migration_required",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("classifies degraded and incompatible activation states", async () => {
  for (const [replacement, expectedCategory] of [
    ["activationStatus: degraded", "stella_activation_degraded"],
    ['openclaw: ">=2027.1.0"', "stella_host_incompatible"],
  ] as const) {
    const root = await createFixture();
    try {
      await updateFixtureManifest(root, (manifest) =>
        replacement.startsWith("activationStatus")
          ? manifest.replace("activationStatus: active", replacement)
          : manifest.replace('openclaw: ">=2026.8.1"', replacement),
      );
      const recoveryRevision = await initializeFixtureRepository(root);
      await assert.rejects(
        () =>
          loadConsciousness(root, undefined, {
            recoveryRevision,
            coreVersion: "3.0.0-alpha.0",
            openclawVersion: "2026.8.2",
          }),
        (error: unknown) =>
          error instanceof Error &&
          "category" in error &&
          error.category === expectedCategory,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("rejects a checkout that does not match the explicit recovery revision", async () => {
  const root = await createFixture();
  try {
    await initializeFixtureRepository(root);
    await assert.rejects(
      () =>
        loadConsciousness(root, undefined, {
          recoveryRevision: "2".repeat(40),
          coreVersion: "3.0.0-alpha.0",
          openclawVersion: "2026.8.2",
        }),
      (error: unknown) =>
        error instanceof Error &&
        "category" in error &&
        error.category === "stella_recovery_revision_invalid",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects a declared source blob that does not match recovery content", async () => {
  const root = await createFixture();
  try {
    const registryPath = path.join(
      root,
      "50_PersonalAgent/stella/frameworks/source-registry.yaml",
    );
    const registry = await readFile(registryPath, "utf8");
    await writeFile(
      registryPath,
      registry.replace(
        "source_ref: path:30_RAG/frameworks/fixture.md",
        `source_ref: path:30_RAG/frameworks/fixture.md\n    source_blob_sha: ${"f".repeat(40)}`,
      ),
      "utf8",
    );
    await initializeFixtureRepository(root);
    await assert.rejects(
      () => loadConsciousness(root),
      (error: unknown) =>
        error instanceof Error &&
        "category" in error &&
        error.category === "stella_record_invalid" &&
        !error.message.includes("Framework source"),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects untracked recovery content even when HEAD matches", async () => {
  const root = await createFixture();
  try {
    const recoveryRevision = await initializeFixtureRepository(root);
    await writeFile(path.join(root, "untracked-personal-state.md"), "not in recovery commit", "utf8");
    await assert.rejects(
      () =>
        loadConsciousness(root, undefined, {
          recoveryRevision,
          coreVersion: "3.0.0-alpha.0",
          openclawVersion: "2026.8.2",
        }),
      (error: unknown) =>
        error instanceof Error &&
        "category" in error &&
        error.category === "stella_recovery_revision_invalid",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects a repository path reference that resolves through an escaping symlink", async () => {
  const root = await createFixture();
  const outsidePath = `${root}-outside.md`;
  try {
    const soulPath = path.join(root, "50_PersonalAgent/openclaw/workspace/SOUL.md");
    await writeFile(outsidePath, "outside private content", "utf8");
    await rm(soulPath);
    await symlink(outsidePath, soulPath);
    await assert.rejects(
      () => loadConsciousness(root),
      (error: unknown) =>
        error instanceof Error &&
        "category" in error &&
        error.category === "stella_reference_invalid" &&
        !error.message.includes("outside private content"),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outsidePath, { force: true });
  }
});

test("rejects a manifest locator that resolves through an escaping symlink", async () => {
  const root = await createFixture();
  const outsidePath = `${root}-manifest.yaml`;
  try {
    const manifestPath = path.join(root, "50_PersonalAgent/stella/manifest.yaml");
    await writeFile(outsidePath, await readFile(manifestPath, "utf8"), "utf8");
    await rm(manifestPath);
    await symlink(outsidePath, manifestPath);
    await assert.rejects(
      () => loadConsciousness(root),
      (error: unknown) =>
        error instanceof Error &&
        "category" in error &&
        error.category === "stella_manifest_invalid",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outsidePath, { force: true });
  }
});

test("rejects a tracked symlink whose in-repository target is ignored", async () => {
  const root = await createFixture();
  try {
    const soulPath = path.join(root, "50_PersonalAgent/openclaw/workspace/SOUL.md");
    const ignoredPath = path.join(root, "ignored-private.md");
    await writeFile(path.join(root, ".gitignore"), "ignored-private.md\n", "utf8");
    await writeFile(ignoredPath, "ignored private content", "utf8");
    await rm(soulPath);
    await symlink("../../../ignored-private.md", soulPath);
    const recoveryRevision = await initializeFixtureRepository(root);
    await assert.rejects(
      () =>
        loadConsciousness(root, undefined, {
          recoveryRevision,
          coreVersion: "3.0.0-alpha.0",
          openclawVersion: "2026.8.2",
        }),
      (error: unknown) =>
        error instanceof Error &&
        "category" in error &&
        error.category === "stella_reference_invalid" &&
        !error.message.includes("ignored private content"),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
