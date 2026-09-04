import assert from "node:assert/strict";
import test from "node:test";
import { parseExactHostPraxisReceipt } from "../src/acceptance/exact-host-praxis.js";

const receipt = {
  schemaVersion: "stella.exact-host-praxis-receipt/v1",
  coreRevision: "1".repeat(40),
  initialCanghaiRevision: "2".repeat(40),
  finalCanghaiRevision: "3".repeat(40),
  hostVersion: "2026.8.2",
  artifactSha256: "4".repeat(64),
  dataMode: "managed_durable_write",
  predictionSealedBeforeOutcome: true,
  recommendationPersisted: true,
  actualRecorded: true,
  outcomeClosed: true,
  learningPersisted: true,
  learningRetrievedAfterRestart: true,
  finalRevisionRemoteSynchronized: true,
  sourceClean: true,
  exactHostAgentTurns: 3,
  episodeRefHash: "5".repeat(64),
  learningRefHash: "6".repeat(64),
  privateFixtureIncluded: true,
};

test("accepts only complete private managed-write Praxis evidence", () => {
  assert.deepEqual(parseExactHostPraxisReceipt(receipt), receipt);
  assert.throws(
    () => parseExactHostPraxisReceipt({ ...receipt, dataMode: "local_write" }),
    /Invalid exact-host Praxis receipt/,
  );
  assert.throws(
    () => parseExactHostPraxisReceipt({ ...receipt, learningRetrievedAfterRestart: false }),
    /Invalid exact-host Praxis receipt/,
  );
  assert.throws(
    () => parseExactHostPraxisReceipt({ ...receipt, finalCanghaiRevision: receipt.initialCanghaiRevision }),
    /Invalid exact-host Praxis receipt/,
  );
});
