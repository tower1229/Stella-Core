import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { stringify } from "yaml";
import {
  DECLARED_SCOPE_DISCOVERY_ADAPTER,
  discoverDeclaredScope,
  parseCorpusRegistry,
  toPublicDiscoveryReport,
} from "../src/canghai/declared-scope-discovery.js";

async function writeTree(root: string, files: Record<string, string | Buffer>): Promise<void> {
  for (const [relative, content] of Object.entries(files)) {
    const absolute = path.join(root, relative);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, content);
  }
}

function registry(corpora: Array<Record<string, unknown>>) {
  return {
    schema_version: "stella.corpus-registry/v1",
    id: "synthetic-declared-scope",
    corpora,
    memory_catalog_ref: "path:30_PersonalData/memory/catalog.json",
  };
}

test("declared scope discovery covers old corpus, drafts, feedback and attachments without registry caps", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "stella-declared-scope-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const many = Object.fromEntries(Array.from({ length: 80 }, (_, i) => [
    `30_RAG/life-log/entry-${String(i).padStart(3, "0")}.md`,
    `# entry ${i}\n`,
  ]));
  await writeTree(root, {
    ...many,
    "20_Writing/drafts/article.md": "# draft\nsee feedback\n",
    "20_Writing/feedback/article-notes.md": "# feedback\n",
    "20_Writing/attachments/chart.png": Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    "50_PersonalAgent/corpus-registry.yaml": stringify(registry([
      { id: "old-corpus", root_ref: "path:30_RAG/life-log", include: ["**/*.md"], exclude: [],
        policy_ref: "path:30_PersonalData/memory/policy.json", adapter_id: "stella-repository-file/v1" },
      { id: "in-progress", root_ref: "path:20_Writing", include: ["drafts/**/*.md", "feedback/**/*.md", "attachments/**"], exclude: [],
        policy_ref: "path:30_PersonalData/memory/policy.json", adapter_id: "stella-repository-file/v1" },
    ])),
  });
  const result = await discoverDeclaredScope({
    root,
    corpusRegistryRef: "path:50_PersonalAgent/corpus-registry.yaml",
    checkedAt: "2026-09-11T00:00:00Z",
    complete: async () => ({ text: JSON.stringify({ selected: [] }), provider: "synthetic", model: "synthetic" }),
    modelRef: "synthetic/synthetic",
  });
  assert.equal(result.status, "discovered");
  if (result.status !== "discovered") return;
  assert.equal(result.sources.length, 83);
  assert.ok(result.sources.every((source) => source.origin.adapterId === "stella-repository-file/v1"));
  assert.ok(result.sources.some((source) => source.locatorPath === "20_Writing/drafts/article.md"));
  assert.ok(result.sources.some((source) => source.locatorPath === "20_Writing/feedback/article-notes.md"));
  assert.ok(result.sources.some((source) => source.locatorPath === "20_Writing/attachments/chart.png"));
  assert.equal(result.coverage.adapterId, DECLARED_SCOPE_DISCOVERY_ADAPTER);
  assert.equal(result.coverage.completeForDeclaredScope, true);
  assert.equal(result.coverage.expectedCount, 83);
  assert.equal(result.coverage.retainedCount, 83);
  assert.equal(result.coverage.missingItems.length, 0);
});

test("discovery preserves stable Source identity, reports unknown totals and missing originals without faking completeness", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "stella-declared-scope-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeTree(root, {
    "20_Writing/drafts/piece.md": [
      "# piece",
      "See [[../attachments/missing-photo.png]] and [[../notes/related.md]].",
      "Ignore https://example.com/noise.png",
      "",
    ].join("\n"),
    "20_Writing/notes/related.md": "# related note\nPRIVATE_BODY_SENTINEL\n",
    "50_PersonalAgent/corpus-registry.yaml": stringify(registry([
      { id: "drafts-only", root_ref: "path:20_Writing/drafts", include: ["**/*.md"], exclude: [],
        policy_ref: "path:30_PersonalData/memory/policy.json", adapter_id: "stella-repository-file/v1" },
    ])),
  });
  const selectAllMaterial = async ({ prompt }: { prompt: string }) => {
    const handles = [...prompt.matchAll(/"handle":"(C\d+)"/g)].map((match) => match[1]!);
    const selected = handles.filter((handle) => {
      const start = prompt.indexOf(`"handle":"${handle}"`);
      const block = prompt.slice(start, start + 500);
      return block.includes("repoRelativePath") && !block.includes("example.com") && !block.includes("rejected");
    });
    return { text: JSON.stringify({ selected }), provider: "synthetic", model: "synthetic" };
  };
  const result = await discoverDeclaredScope({
    root,
    corpusRegistryRef: "path:50_PersonalAgent/corpus-registry.yaml",
    checkedAt: "2026-09-11T01:00:00Z",
    complete: selectAllMaterial,
    modelRef: "synthetic/synthetic",
  });
  assert.equal(result.status, "discovered");
  if (result.status !== "discovered") return;
  const draft = result.sources.find((source) => source.locatorPath === "20_Writing/drafts/piece.md");
  const related = result.sources.find((source) => source.locatorPath === "20_Writing/notes/related.md");
  assert.ok(draft);
  assert.ok(related);
  assert.match(draft!.sourceId, /^source_/);
  assert.notEqual(draft!.sourceId, related!.sourceId);
  assert.equal(draft!.origin.collectionId, "drafts-only");
  assert.equal(draft!.origin.upstreamId, "20_Writing/drafts/piece.md");
  assert.equal(related!.discoveredVia, "followed_clue");
  assert.equal(result.coverage.expectedCount, null);
  assert.equal(result.coverage.completeForDeclaredScope, false);
  assert.ok(result.coverage.missingItems.some((item) => item.reason === "attachment_missing" && item.retryable === true));
  const again = await discoverDeclaredScope({
    root,
    corpusRegistryRef: "path:50_PersonalAgent/corpus-registry.yaml",
    checkedAt: "2026-09-11T01:00:00Z",
    complete: selectAllMaterial,
    modelRef: "synthetic/synthetic",
  });
  assert.equal(again.status, "discovered");
  if (again.status !== "discovered") return;
  assert.equal(again.sources.find((source) => source.locatorPath === draft!.locatorPath)?.sourceId, draft!.sourceId);
});

test("discovery distinguishes coverage gap, not-ready and source fault; public report keeps G-10", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "stella-declared-scope-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeTree(root, {
    "20_Writing/drafts/empty-scope.md": "# only declared when include matches\n",
    "50_PersonalAgent/corpus-registry.yaml": stringify(registry([
      { id: "empty", root_ref: "path:20_Writing/drafts", include: ["**/*.nope"], exclude: [],
        policy_ref: "path:30_PersonalData/memory/policy.json", adapter_id: "stella-repository-file/v1" },
    ])),
  });
  const gap = await discoverDeclaredScope({
    root,
    corpusRegistryRef: "path:50_PersonalAgent/corpus-registry.yaml",
    checkedAt: "2026-09-11T02:00:00Z",
    complete: async () => ({ text: JSON.stringify({ selected: [] }), provider: "synthetic", model: "synthetic" }),
    modelRef: "synthetic/synthetic",
  });
  assert.equal(gap.status, "coverage_gap");
  if (gap.status !== "coverage_gap") return;
  assert.equal(gap.coverage.retainedCount, 0);
  assert.equal(gap.coverage.completeForDeclaredScope, true);
  assert.equal(gap.coverage.expectedCount, 0);

  const notReady = await discoverDeclaredScope({
    root,
    corpusRegistryRef: "path:50_PersonalAgent/corpus-registry.yaml",
    checkedAt: "2026-09-11T02:00:00Z",
    indexState: "rebuilding",
    complete: async () => ({ text: JSON.stringify({ selected: [] }), provider: "synthetic", model: "synthetic" }),
    modelRef: "synthetic/synthetic",
  });
  assert.equal(notReady.status, "not_ready");
  if (notReady.status !== "not_ready") return;
  assert.equal(notReady.category, "index_not_ready");

  const faultRoot = await mkdtemp(path.join(os.tmpdir(), "stella-declared-scope-"));
  t.after(() => rm(faultRoot, { recursive: true, force: true }));
  await writeTree(faultRoot, {
    "50_PersonalAgent/corpus-registry.yaml": stringify(registry([
      { id: "broken-root", root_ref: "path:missing-root", include: ["**/*"], exclude: [],
        policy_ref: "path:30_PersonalData/memory/policy.json", adapter_id: "stella-repository-file/v1" },
    ])),
  });
  const fault = await discoverDeclaredScope({
    root: faultRoot,
    corpusRegistryRef: "path:50_PersonalAgent/corpus-registry.yaml",
    checkedAt: "2026-09-11T02:00:00Z",
    complete: async () => ({ text: JSON.stringify({ selected: [] }), provider: "synthetic", model: "synthetic" }),
    modelRef: "synthetic/synthetic",
  });
  assert.equal(fault.status, "fault");
  if (fault.status !== "fault") return;
  assert.equal(fault.category, "source_unavailable");

  await writeTree(root, {
    "20_Writing/drafts/piece.md": [
      "# piece",
      `See [[${root}/secret/private.md]]`,
      "PRIVATE_BODY_SENTINEL",
      "",
    ].join("\n"),
    "50_PersonalAgent/corpus-registry.yaml": stringify(registry([
      { id: "drafts", root_ref: "path:20_Writing/drafts", include: ["piece.md"], exclude: [],
        policy_ref: "path:30_PersonalData/memory/policy.json", adapter_id: "stella-repository-file/v1" },
    ])),
  });
  const discovered = await discoverDeclaredScope({
    root,
    corpusRegistryRef: "path:50_PersonalAgent/corpus-registry.yaml",
    checkedAt: "2026-09-11T02:00:00Z",
    complete: async () => ({ text: JSON.stringify({ selected: ["C1"] }), provider: "synthetic", model: "synthetic" }),
    modelRef: "synthetic/synthetic",
  });
  assert.equal(discovered.status, "discovered");
  if (discovered.status !== "discovered") return;
  const publicReport = toPublicDiscoveryReport(discovered);
  const serialized = JSON.stringify(publicReport);
  assert.equal(serialized.includes(root), false);
  assert.equal(serialized.includes("PRIVATE_BODY_SENTINEL"), false);
  assert.equal(serialized.includes("secret/private.md"), false);
  assert.ok(typeof publicReport.discoveredCount === "number");
  assert.ok(Array.isArray(publicReport.missingReasons));
  assert.ok(publicReport.sources.every((source) => source.sourceId && source.collectionId && !("locatorPath" in source)));
});

test("parseCorpusRegistry rejects unknown schema", () => {
  assert.throws(() => parseCorpusRegistry({ schema_version: "other", id: "x", corpora: [] }), /invalid_corpus_registry/);
  const parsed = parseCorpusRegistry(registry([
    { id: "a", root_ref: "path:30_RAG", include: ["**/*.md"], exclude: ["**/tmp/**"],
      policy_ref: "path:30_PersonalData/memory/policy.json", adapter_id: "stella-repository-file/v1" },
  ]));
  assert.equal(parsed.corpora[0]!.include[0], "**/*.md");
});
