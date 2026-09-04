import { isRecord } from "../shared/type-guards.js";
import { ALPHA_HOST_VERSION } from "./exact-host-evidence.js";

const SHA_PATTERN = /^[0-9a-f]{40}$/iu;
const SHA256_PATTERN = /^[0-9a-f]{64}$/iu;

export type ExactHostPraxisReceipt = {
  schemaVersion: "stella.exact-host-praxis-receipt/v1";
  coreRevision: string;
  initialCanghaiRevision: string;
  finalCanghaiRevision: string;
  hostVersion: typeof ALPHA_HOST_VERSION;
  artifactSha256: string;
  dataMode: "managed_durable_write";
  predictionSealedBeforeOutcome: true;
  recommendationPersisted: true;
  actualRecorded: true;
  outcomeClosed: true;
  learningPersisted: true;
  learningRetrievedAfterRestart: true;
  finalRevisionRemoteSynchronized: true;
  sourceClean: true;
  exactHostAgentTurns: number;
  episodeRefHash: string;
  learningRefHash: string;
  privateFixtureIncluded: true;
};

export function parseExactHostPraxisReceipt(value: unknown): ExactHostPraxisReceipt {
  if (!isRecord(value)) throw new Error("Invalid exact-host Praxis receipt");
  const requiredTrue = [
    "predictionSealedBeforeOutcome",
    "recommendationPersisted",
    "actualRecorded",
    "outcomeClosed",
    "learningPersisted",
    "learningRetrievedAfterRestart",
    "finalRevisionRemoteSynchronized",
    "sourceClean",
    "privateFixtureIncluded",
  ];
  if (
    value.schemaVersion !== "stella.exact-host-praxis-receipt/v1" ||
    typeof value.coreRevision !== "string" ||
    !SHA_PATTERN.test(value.coreRevision) ||
    typeof value.initialCanghaiRevision !== "string" ||
    !SHA_PATTERN.test(value.initialCanghaiRevision) ||
    typeof value.finalCanghaiRevision !== "string" ||
    !SHA_PATTERN.test(value.finalCanghaiRevision) ||
    value.initialCanghaiRevision === value.finalCanghaiRevision ||
    value.hostVersion !== ALPHA_HOST_VERSION ||
    typeof value.artifactSha256 !== "string" ||
    !SHA256_PATTERN.test(value.artifactSha256) ||
    value.dataMode !== "managed_durable_write" ||
    requiredTrue.some((field) => value[field] !== true) ||
    !Number.isInteger(value.exactHostAgentTurns) ||
    (value.exactHostAgentTurns as number) < 3 ||
    typeof value.episodeRefHash !== "string" ||
    !SHA256_PATTERN.test(value.episodeRefHash) ||
    typeof value.learningRefHash !== "string" ||
    !SHA256_PATTERN.test(value.learningRefHash)
  ) {
    throw new Error("Invalid exact-host Praxis receipt");
  }
  return value as ExactHostPraxisReceipt;
}
