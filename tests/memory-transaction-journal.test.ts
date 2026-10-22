import assert from "node:assert/strict";
import test from "node:test";
import { bytesVersion, canonicalJson } from "../src/canghai/content-version.js";
import { MemoryTransactionJournalError, parseMemoryTransactionJournal, serializeMemoryTransactionJournal } from "../src/canghai/memory-transaction-journal.js";
import type { MemoryTransactionPlan } from "../src/canghai/memory-transaction-plan.js";

// Literal canonical bytes and hashes were independently generated, not by this codec.
const GOLDEN_V1 = String.raw`{"contextArchive":{"archiveRoot":"archive","digest":"sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"},"files":[{"after":"Synthetic note\n","before":null,"path":"memory/note.md"},{"after":"AgM=","before":"AAE=","encoding":"base64","path":"memory/bytes.bin"}],"journalPath":"operations/journal_golden.json","operationId":"journal_golden","planHash":"sha256:c0ff52007a892ae3b85bf1abe22ff4b2d0ff70aea7e35498ac85611f7de340d5","schemaVersion":"stella.memory-transaction/v1"}`;
const GOLDEN_V2 = String.raw`{"contextArchive":{"archiveRoot":"archive","digest":"sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"},"files":[{"after":"Synthetic note\n","before":null,"path":"memory/note.md"},{"after":"AgM=","before":"AAE=","encoding":"base64","path":"memory/bytes.bin"}],"journalPath":"operations/journal_golden.json","operationId":"journal_golden","planHash":"sha256:5feb8ba203fae11c8c3c8b51d7fca3b4e9ad7877b898fb1260a6620647f85161","recoveryCheckpoint":{"binding":{"agentId":"synthetic-agent","manifestPath":"memory-manifest.json","repositoryRoot":"/synthetic/canghai"},"expected":{"revision":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","token":"original-token-A"}},"schemaVersion":"stella.memory-transaction/v2"}`;
function v1(): MemoryTransactionPlan {
  return { operationId: "journal_golden", journalPath: "operations/journal_golden.json", files: [
    { path: "memory/note.md", before: null, after: "Synthetic note\n" },
    { path: "memory/bytes.bin", before: "AAE=", after: "AgM=", encoding: "base64" },
  ], contextArchive: { archiveRoot: "archive", digest: `sha256:${"c".repeat(64)}` } };
}
function v2(): MemoryTransactionPlan {
  return { ...v1(), recoveryCheckpoint: {
    binding: { agentId: "synthetic-agent", repositoryRoot: "/synthetic/canghai", manifestPath: "memory-manifest.json" },
    expected: { revision: "a".repeat(40), token: "original-token-A" },
  } };
}
function envelope(plan: object, schemaVersion = "stella.memory-transaction/v2"): string {
  return canonicalJson({ schemaVersion, ...plan, planHash: bytesVersion(canonicalJson(plan)) });
}
function invalid(bytes: string): void {
  assert.throws(() => parseMemoryTransactionJournal(bytes), error =>
    error instanceof MemoryTransactionJournalError && error.category === "invalid_transaction_journal" &&
    error.message === "Memory transaction failed: invalid_transaction_journal");
}

test("v1 canonical golden bytes preserve the existing journal contract, archive and base64", () => {
  assert.equal(serializeMemoryTransactionJournal(v1()), GOLDEN_V1);
  const decoded = parseMemoryTransactionJournal(GOLDEN_V1, "journal_golden");
  assert.deepEqual(decoded, v1());
  assert.equal(serializeMemoryTransactionJournal(decoded), GOLDEN_V1);
  assert.equal(decoded.recoveryCheckpoint, undefined);
  assert.equal(decoded.files[0]!.after, "Synthetic note\n");
  assert.equal(decoded.files[1]!.encoding, "base64");
});

test("v2 canonical golden bytes preserve the original expected revision and opaque token", () => {
  assert.equal(serializeMemoryTransactionJournal(v2()), GOLDEN_V2);
  assert.deepEqual(parseMemoryTransactionJournal(GOLDEN_V2, "journal_golden"), v2());
  assert.equal(serializeMemoryTransactionJournal(parseMemoryTransactionJournal(GOLDEN_V2)), GOLDEN_V2);
});

test("unknown top-level and file fields fail even with a correctly recomputed planHash", () => {
  for (const schemaVersion of ["stella.memory-transaction/v1", "stella.memory-transaction/v2"]) {
    const plan = schemaVersion.endsWith("/v1") ? v1() : v2();
    invalid(envelope({ ...plan, unknown: "untrusted" }, schemaVersion));
    invalid(envelope({ ...plan, files: plan.files.map(file => ({ ...file, unknown: true })) }, schemaVersion));
    invalid(envelope({ ...plan, contextArchive: { ...plan.contextArchive, unknown: true } }, schemaVersion));
  }
  const plan = v2(), original = plan.recoveryCheckpoint!;
  invalid(envelope({ ...plan, recoveryCheckpoint: { ...original, observedToken: "token-now" } }));
  invalid(envelope({ ...plan, recoveryCheckpoint: { ...original, binding: { ...original.binding, unknown: true } } }));
  invalid(envelope({ ...plan, recoveryCheckpoint: { ...original, expected: { ...original.expected, unknown: true } } }));
});

test("v1/v2 envelopes cannot silently add, remove or change checkpoint mode", () => {
  invalid(envelope(v2(), "stella.memory-transaction/v1"));
  invalid(envelope(v1(), "stella.memory-transaction/v2"));
  invalid(envelope(v2(), "stella.memory-transaction/v3"));
  invalid(envelope({ ...v2(), recoveryCheckpoint: null }));
  assert.throws(() => serializeMemoryTransactionJournal({ ...v1(), recoveryCheckpoint: undefined }), MemoryTransactionJournalError);
});

test("missing or invalid original expected tokens are rejected without filling an observed value", () => {
  const plan = v2(), checkpoint = plan.recoveryCheckpoint!;
  for (const expected of [
    { revision: checkpoint.expected.revision },
    { revision: checkpoint.expected.revision, token: "" },
    { revision: checkpoint.expected.revision, token: "bad token" },
    { revision: checkpoint.expected.revision, token: "token-A", observedToken: "token-B" },
    { revision: "A".repeat(40), token: "token-A" },
    { revision: "a".repeat(39), token: "token-A" },
  ]) invalid(envelope({ ...plan, recoveryCheckpoint: { ...checkpoint, expected } }));
  invalid(envelope({ ...plan, recoveryCheckpoint: { binding: checkpoint.binding,
    expected: { revision: checkpoint.expected.revision }, observed: checkpoint.expected } }));
});

test("v2 rejects invalid binding locations and identities", () => {
  const plan = v2(), checkpoint = plan.recoveryCheckpoint!;
  for (const binding of [
    { ...checkpoint.binding, agentId: "../agent" },
    { ...checkpoint.binding, repositoryRoot: "relative" },
    { ...checkpoint.binding, repositoryRoot: "/synthetic/../canghai" },
    ...["../manifest", "/manifest", ".git/config", "nested//manifest", "name:stream", "dir\\file"].map(manifestPath => ({ ...checkpoint.binding, manifestPath })),
  ]) invalid(envelope({ ...plan, recoveryCheckpoint: { ...checkpoint, binding } }));
});

test("planHash binds business writes and the original expected tuple, never the newly observed tuple", () => {
  const original = v2(), checkpoint = original.recoveryCheckpoint!;
  const hash = (bytes: string) => (JSON.parse(bytes) as { planHash: string }).planHash;
  const replacements = [
    { ...checkpoint, expected: { ...checkpoint.expected, token: "token-now-B" } },
    { ...checkpoint, expected: { ...checkpoint.expected, revision: "b".repeat(40) } },
    { ...checkpoint, binding: { ...checkpoint.binding, agentId: "another-agent" } },
  ];
  for (const recoveryCheckpoint of replacements) {
    const changed = { ...original, recoveryCheckpoint }, bytes = serializeMemoryTransactionJournal(changed);
    assert.notEqual(hash(bytes), hash(GOLDEN_V2));
    const tampered = JSON.parse(GOLDEN_V2) as Record<string, unknown>;
    tampered.recoveryCheckpoint = recoveryCheckpoint;
    invalid(canonicalJson(tampered));
  }
  const business = { ...original, files: original.files.map(file => ({ ...file, after: "different synthetic bytes" })) };
  assert.notEqual(hash(serializeMemoryTransactionJournal(business)), hash(GOLDEN_V2));
  assert.deepEqual(parseMemoryTransactionJournal(GOLDEN_V2).recoveryCheckpoint, checkpoint);
});

test("wrong operation, hash, noncanonical bytes and malformed JSON are rejected", () => {
  assert.throws(() => parseMemoryTransactionJournal(GOLDEN_V1, "another-operation"), MemoryTransactionJournalError);
  for (const golden of [GOLDEN_V1, GOLDEN_V2]) {
    const badHash = JSON.parse(golden) as Record<string, unknown>;
    badHash.planHash = `sha256:${"0".repeat(64)}`; invalid(canonicalJson(badHash));
    invalid(`${golden}\n`); invalid(` ${golden}`); invalid(JSON.stringify(JSON.parse(golden), null, 2));
  }
  for (const bytes of ["", "{", "null", "[]"]) invalid(bytes);
});


test("schema versions must be strings, never coercible arrays", () => {
  for (const schemaVersion of [["stella.memory-transaction/v1"], [["stella.memory-transaction/v1"]],
    ["stella.memory-transaction/v2"], [["stella.memory-transaction/v2"]]]) {
    for (const plan of [v1(), v2()]) invalid(canonicalJson({ schemaVersion, ...plan, planHash: bytesVersion(canonicalJson(plan)) }));
  }
});


test("explicit legacy utf8 encoding remains accepted and retains journal identity", () => {
  const original = v1();
  const plan: MemoryTransactionPlan = { ...original, files: original.files.map((file, index) => index === 0 ? { ...file, encoding: "utf8" } : file) };
  const bytes = envelope(plan, "stella.memory-transaction/v1");
  assert.equal(serializeMemoryTransactionJournal(plan), bytes);
  assert.deepEqual(parseMemoryTransactionJournal(bytes), plan);
  assert.equal(parseMemoryTransactionJournal(bytes).files[0]!.encoding, "utf8");
});
