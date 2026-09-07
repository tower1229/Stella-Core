import { isRecord } from "../shared/type-guards.js";
import { ALPHA_HOST_VERSION } from "./exact-host-evidence.js";
import { parseHostCompatibility, type HostCompatibility } from "./host-compatibility.js";

const SHA_PATTERN = /^[0-9a-f]{40}$/iu;
const SHA256_PATTERN = /^[0-9a-f]{64}$/iu;

export type ExactHostPraxisReceipt = {
  hostCompatibility?: HostCompatibility;
  schemaVersion: "stella.exact-host-praxis-receipt/v2";
  episodeSchemaVersion: "stella.praxis-episode/v2";
  transport: "chat.send";
  adviceRevisionPersisted: true;
  predictionStatus: "sealed" | "not_applicable";
  coreRevision: string;
  initialCanghaiRevision: string;
  finalCanghaiRevision: string;
  hostVersion: typeof ALPHA_HOST_VERSION;
  artifactSha256: string;
  dataMode: "managed_durable_write";
  predictionSealedBeforeOutcome: boolean;
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
  if (value.hostCompatibility !== undefined) parseHostCompatibility(value.hostCompatibility);
  const requiredTrue = [
    "adviceRevisionPersisted",
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
    value.schemaVersion !== "stella.exact-host-praxis-receipt/v2" ||
    value.episodeSchemaVersion !== "stella.praxis-episode/v2" || value.transport !== "chat.send" ||
    !["sealed", "not_applicable"].includes(String(value.predictionStatus)) ||
    value.predictionSealedBeforeOutcome !== (value.predictionStatus === "sealed") ||
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
    (value.exactHostAgentTurns as number) < 4 ||
    typeof value.episodeRefHash !== "string" ||
    !SHA256_PATTERN.test(value.episodeRefHash) ||
    typeof value.learningRefHash !== "string" ||
    !SHA256_PATTERN.test(value.learningRefHash)
  ) {
    throw new Error("Invalid exact-host Praxis receipt");
  }
  return value as ExactHostPraxisReceipt;
}
