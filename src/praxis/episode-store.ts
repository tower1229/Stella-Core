import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  access,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
} from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { LoadedConsciousness, PraxisPlaybookItem } from "../canghai/manifest.js";
import { parseCangHaiRef, resolveCangHaiRef } from "../canghai/ref.js";
import { validateSchema } from "../canghai/schema.js";
import { isRecord } from "../shared/type-guards.js";

const execFileAsync = promisify(execFile);

export const STELLA_DATA_MODES = [
  "read_only",
  "local_write",
  "managed_durable_write",
] as const;
export type StellaDataMode = (typeof STELLA_DATA_MODES)[number];

export const PRAXIS_LEARNING_ALGORITHM_VERSION = "stella.praxis-learning/v1";
const LOCAL_WRITE_BRANCH = "local/stella-alpha";

type Prediction = {
  possibleActions?: Record<string, number>;
  likelyInterpretations?: string[];
  keyFactors?: string[];
};

export type EpisodePredictionInput = {
  provenance: {
    agentId?: string;
    sessionId?: string;
    runId?: string;
    messageRefs?: string[];
  };
  situation: {
    summary: string;
    domains: string[];
    actors?: string[];
    observations: string[];
    interpretations?: string[];
    unknowns?: string[];
    goals?: string[];
    stakes?: "low" | "medium" | "high";
    reversibility?: "high" | "medium" | "low";
  };
  twin: {
    hypothesisRefs?: string[];
    prediction: Prediction;
  };
  framework?: {
    frameworkRefs?: string[];
    operatorRefs?: string[];
  };
  reality?: {
    modes?: Array<"base_model" | "personal_praxis" | "external_research">;
    norms?: string[];
    hiddenVariables?: string[];
    likelyInterpretations?: string[];
    socialCosts?: string[];
    uncertainties?: string[];
    externalRefs?: string[];
    similarEpisodeRefs?: string[];
  };
};

export type EpisodeOutcomeInput = {
  episodeRef: string;
  actualAction: string;
  source: "user_report" | "tool_observation" | "system_event" | "inferred";
  observations: string[];
  result: string;
  observedAt: string;
  predictionAssessment: "supported" | "countered" | "unresolved";
  praxisLearning: string;
};

type PraxisEpisode = {
  schemaVersion: "stella.praxis-episode/v1";
  id: string;
  status: "open" | "acted" | "observing" | "closed" | "abandoned" | "expired";
  createdAt: string;
  updatedAt: string;
  recoveryPriority?: "normal" | "important";
  sourceBaseline?: { repository: string; commit: string };
  sourceSnapshot?: Record<string, string>;
  provenance: EpisodePredictionInput["provenance"];
  situation: EpisodePredictionInput["situation"];
  twin?: EpisodePredictionInput["twin"];
  framework?: EpisodePredictionInput["framework"];
  reality?: EpisodePredictionInput["reality"];
  decision?: {
    recommendation?: string;
    rationale?: string[];
  };
  actual?: {
    action?: string;
    occurredAt?: string;
    source?: EpisodeOutcomeInput["source"];
  };
  outcome?: {
    observations?: string[];
    result?: string;
    observedAt?: string;
  };
  learning?: {
    algorithmVersion?: typeof PRAXIS_LEARNING_ALGORITHM_VERSION;
    predictionAssessment?: EpisodeOutcomeInput["predictionAssessment"];
    evidenceRefs?: string[];
    praxis?: string[];
  };
};

export type OpenEpisodeCandidate = {
  ref: string;
  summary: string;
  domains: string[];
  prediction: Prediction;
  recommendation?: string;
  recoveryPriority?: "normal" | "important";
};

export type StagedEpisode = {
  id: string;
  ref: string;
};

export type PraxisMemory = {
  openEpisodes: OpenEpisodeCandidate[];
  learningItems: PraxisPlaybookItem[];
};

export type PraxisDurabilityPort = {
  syncCritical: (paths: string[], message: string) => Promise<unknown>;
  recordNormal: (paths: string[], message: string) => Promise<unknown>;
};

type StoreOptions = {
  loaded: LoadedConsciousness;
  dataMode: StellaDataMode;
  now?: () => string;
  createId?: () => string;
  durability?: PraxisDurabilityPort;
};

async function writeNewFile(filePath: string, content: string): Promise<void> {
  const handle = await open(filePath, "wx", 0o600);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeAtomicFile(filePath: string, content: string): Promise<void> {
  const stagingPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${randomUUID()}.staging`,
  );
  try {
    await writeNewFile(stagingPath, content);
    await rename(stagingPath, filePath);
  } finally {
    await rm(stagingPath, { force: true });
  }
}

function serialize(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function parseEpisode(input: string): PraxisEpisode {
  const parsed = JSON.parse(input) as unknown;
  if (!isRecord(parsed) || parsed.schemaVersion !== "stella.praxis-episode/v1") {
    throw new Error("Praxis Episode record is invalid");
  }
  return parsed as PraxisEpisode;
}

export class CangHaiPraxisEpisodeStore {
  readonly #root: string;
  readonly #episodeRootRelative: string;
  readonly #episodeRootAbsolute: string;
  readonly #dataMode: StellaDataMode;
  readonly #repository: string;
  readonly #recoveryRevision?: string;
  readonly #now: () => string;
  readonly #createId: () => string;
  readonly #durability?: PraxisDurabilityPort;

  constructor(options: StoreOptions) {
    this.#root = options.loaded.canghaiRoot;
    const episodeRoot = resolveCangHaiRef(
      this.#root,
      options.loaded.manifest.praxis.episodeRootRef,
    );
    if (episodeRoot.fragment) {
      throw new Error("Praxis episode root must not contain a fragment");
    }
    this.#episodeRootRelative = episodeRoot.relativePath;
    const validatedEpisodeRoot = options.loaded.requiredReferences.find(
      (reference) => reference.field === "praxis.episodeRootRef",
    );
    if (!validatedEpisodeRoot) {
      throw new Error("Praxis episode root was not validated by the consciousness loader");
    }
    this.#episodeRootAbsolute = validatedEpisodeRoot.absolutePath;
    this.#dataMode = options.dataMode;
    this.#repository = options.loaded.manifest.sourceBaseline.repository;
    this.#recoveryRevision = options.loaded.recoveryRevision;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#createId = options.createId ?? (() => `praxis-${randomUUID()}`);
    this.#durability = options.durability;
    if (this.#dataMode === "managed_durable_write" && !this.#durability) {
      throw new Error("managed_durable_write requires a durability coordinator");
    }
  }

  async stagePrediction(input: EpisodePredictionInput): Promise<StagedEpisode> {
    await this.#assertWritable();
    const id = this.#createId();
    if (!/^praxis-[a-zA-Z0-9_-]+$/.test(id)) {
      throw new Error("Praxis Episode id is invalid");
    }
    if (!this.#recoveryRevision) {
      throw new Error("Writable Praxis Episodes require an explicit recovery revision");
    }
    const now = this.#now();
    const sourceSnapshot = await this.#captureSourceSnapshot(input);
    const episode: PraxisEpisode = {
      schemaVersion: "stella.praxis-episode/v1",
      id,
      status: "open",
      createdAt: now,
      updatedAt: now,
      recoveryPriority: "important",
      sourceBaseline: {
        repository: this.#repository,
        commit: this.#recoveryRevision,
      },
      sourceSnapshot,
      provenance: input.provenance,
      situation: input.situation,
      twin: input.twin,
      ...(input.framework ? { framework: input.framework } : {}),
      ...(input.reality ? { reality: input.reality } : {}),
    };
    await validateSchema("praxis-episode", episode);

    const finalDirectory = path.join(this.#episodeRootAbsolute, id);
    const stagingRoot = path.join(this.#episodeRootAbsolute, ".staging");
    const stagingDirectory = path.join(stagingRoot, id);
    if (await pathExists(finalDirectory)) throw new Error("Praxis Episode id already exists");
    await mkdir(stagingRoot, { recursive: true, mode: 0o700 });
    await mkdir(stagingDirectory, { recursive: false, mode: 0o700 });
    try {
      await writeNewFile(path.join(stagingDirectory, "episode.json"), serialize(episode));
      await writeNewFile(
        path.join(stagingDirectory, "prediction.json"),
        serialize(input.twin.prediction),
      );
    } catch (error) {
      await rm(stagingDirectory, { recursive: true, force: true });
      throw error;
    }
    return { id, ref: this.#episodeRef(id) };
  }

  async publishRecommendation(
    staged: StagedEpisode,
    recommendation: string,
    rationale: string[],
  ): Promise<{ id: string; ref: string }> {
    await this.#assertWritable();
    const stagingDirectory = this.#resolveStagingDirectory(staged);
    const finalDirectory = path.join(this.#episodeRootAbsolute, staged.id);
    const episodePath = path.join(stagingDirectory, "episode.json");
    const predictionPath = path.join(stagingDirectory, "prediction.json");
    const { episode, predictionSealed } = await this.#readVerifiedEpisode(
      episodePath,
      predictionPath,
    );
    if (!predictionSealed) throw new Error("Staged Praxis prediction is not sealed");
    if (episode.status !== "open") throw new Error("Only an open Episode accepts a recommendation");
    const updated: PraxisEpisode = {
      ...episode,
      status: "acted",
      updatedAt: this.#now(),
      decision: { recommendation, rationale },
    };
    await validateSchema("praxis-episode", updated);
    try {
      await writeAtomicFile(episodePath, serialize(updated));
      await rename(stagingDirectory, finalDirectory);
    } catch (error) {
      await rm(stagingDirectory, { recursive: true, force: true });
      throw error;
    }
    if (this.#dataMode === "managed_durable_write") {
      await this.#durability!.syncCritical(
        [path.posix.join(this.#episodeRootRelative, staged.id)],
        `stella: preserve open Praxis state ${staged.id}`,
      );
    }
    return staged;
  }

  async discardStagedPrediction(staged: StagedEpisode): Promise<void> {
    await rm(this.#resolveStagingDirectory(staged), { recursive: true, force: true });
  }

  async associateOutcome(input: EpisodeOutcomeInput): Promise<void> {
    await this.#assertWritable();
    const { episodePath, predictionPath } = this.#resolveEpisodeRef(input.episodeRef);
    const { episode, predictionSealed } = await this.#readVerifiedEpisode(
      episodePath,
      predictionPath,
    );
    if (!predictionSealed) {
      throw new Error("Outcome association requires a sealed pre-outcome prediction");
    }
    if (episode.status === "closed") throw new Error("Praxis Episode is already closed");
    const updated: PraxisEpisode = {
      ...episode,
      status: "closed",
      updatedAt: this.#now(),
      actual: {
        action: input.actualAction,
        occurredAt: input.observedAt,
        source: input.source,
      },
      outcome: {
        observations: input.observations,
        result: input.result,
        observedAt: input.observedAt,
      },
      learning: {
        algorithmVersion: PRAXIS_LEARNING_ALGORITHM_VERSION,
        predictionAssessment: input.predictionAssessment,
        evidenceRefs: [input.episodeRef],
        praxis: [input.praxisLearning],
      },
    };
    await validateSchema("praxis-episode", updated);
    await writeAtomicFile(episodePath, serialize(updated));
    if (this.#dataMode === "managed_durable_write") {
      await this.#durability!.recordNormal(
        [path.posix.dirname(parseCangHaiRef(input.episodeRef).relativePath)],
        `stella: record Praxis learning ${episode.id}`,
      );
    }
  }

  async listMemory(): Promise<PraxisMemory> {
    const openEpisodes: OpenEpisodeCandidate[] = [];
    const learningItems: PraxisPlaybookItem[] = [];
    const entries = await readdir(this.#episodeRootAbsolute, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const episodePath = path.join(this.#episodeRootAbsolute, entry.name, "episode.json");
      const predictionPath = path.join(this.#episodeRootAbsolute, entry.name, "prediction.json");
      const { episode, predictionSealed } = await this.#readVerifiedEpisode(
        episodePath,
        predictionPath,
      );
      const ref = this.#episodeRef(episode.id);
      if (
        predictionSealed &&
        episode.twin?.prediction &&
        episode.status !== "closed" &&
        episode.status !== "abandoned" &&
        episode.status !== "expired"
      ) {
        openEpisodes.push({
          ref,
          summary: episode.situation.summary,
          domains: episode.situation.domains,
          prediction: episode.twin.prediction,
          ...(episode.decision?.recommendation
            ? { recommendation: episode.decision.recommendation }
            : {}),
          ...(episode.recoveryPriority
            ? { recoveryPriority: episode.recoveryPriority }
            : {}),
        });
      }
      for (const [index, learning] of (episode.learning?.praxis ?? []).entries()) {
        learningItems.push({
          ref: `${ref}#learning:praxis:${index}`,
          domains: episode.situation.domains,
          content: learning,
        });
      }
    }
    return { openEpisodes, learningItems };
  }

  async #assertWritable(): Promise<void> {
    if (this.#dataMode === "read_only") {
      throw new Error("Stella data mode read_only forbids CangHai writes");
    }
    if (this.#dataMode === "managed_durable_write") return;
    const { stdout } = await execFileAsync("git", [
      "-C",
      this.#root,
      "branch",
      "--show-current",
    ]);
    if (stdout.trim() !== LOCAL_WRITE_BRANCH) {
      throw new Error(`local_write requires CangHai branch ${LOCAL_WRITE_BRANCH}`);
    }
  }

  #episodeRef(id: string): string {
    return `path:${path.posix.join(this.#episodeRootRelative, id, "episode.json")}`;
  }

  #resolveStagingDirectory(staged: StagedEpisode): string {
    if (!/^praxis-[a-zA-Z0-9_-]+$/.test(staged.id) || staged.ref !== this.#episodeRef(staged.id)) {
      throw new Error("Staged Praxis Episode handle is invalid");
    }
    return path.join(this.#episodeRootAbsolute, ".staging", staged.id);
  }

  async #captureSourceSnapshot(input: EpisodePredictionInput): Promise<Record<string, string>> {
    const refs = new Set([
      ...(input.twin.hypothesisRefs ?? []),
      ...(input.framework?.frameworkRefs ?? []),
      ...(input.framework?.operatorRefs ?? []),
      ...(input.reality?.similarEpisodeRefs ?? []),
    ]);
    const snapshot: Record<string, string> = {};
    for (const ref of refs) {
      const parsed = parseCangHaiRef(ref);
      const { stdout } = await execFileAsync("git", [
        "-C",
        this.#root,
        "hash-object",
        "--",
        parsed.relativePath,
      ]);
      const hash = stdout.trim();
      if (!/^[0-9a-f]{40}$/i.test(hash)) {
        throw new Error(`Cannot pin Praxis derivation source ${ref}`);
      }
      snapshot[ref] = hash;
    }
    return snapshot;
  }

  #resolveEpisodeRef(ref: string): { episodePath: string; predictionPath: string } {
    const parsed = parseCangHaiRef(ref);
    if (parsed.fragment) throw new Error("Praxis Episode ref must not contain a fragment");
    const relativeToEpisodeRoot = path.posix.relative(
      this.#episodeRootRelative,
      parsed.relativePath,
    );
    const parts = relativeToEpisodeRoot.split("/");
    if (
      relativeToEpisodeRoot.startsWith("../") ||
      parts.length !== 2 ||
      parts[1] !== "episode.json" ||
      !/^praxis-[a-zA-Z0-9_-]+$/.test(parts[0] ?? "")
    ) {
      throw new Error("Praxis Episode ref is outside the managed episode layout");
    }
    const episodePath = resolveCangHaiRef(this.#root, ref).absolutePath;
    return { episodePath, predictionPath: path.join(path.dirname(episodePath), "prediction.json") };
  }

  async #readVerifiedEpisode(
    episodePath: string,
    predictionPath: string,
  ): Promise<{ episode: PraxisEpisode; predictionSealed: boolean }> {
    const episodeText = await readFile(episodePath, "utf8");
    const episode = parseEpisode(episodeText);
    await validateSchema("praxis-episode", episode);
    if (episode.sourceSnapshot) await this.#verifySourceSnapshot(episode.sourceSnapshot);
    if (!episode.twin?.prediction || !(await pathExists(predictionPath))) {
      if (episode.sourceBaseline || episode.sourceSnapshot) {
        throw new Error("Managed Praxis Episode is missing its immutable prediction snapshot");
      }
      return { episode, predictionSealed: false };
    }
    const prediction = JSON.parse(await readFile(predictionPath, "utf8")) as unknown;
    if (JSON.stringify(episode.twin.prediction) !== JSON.stringify(prediction)) {
      throw new Error("Praxis Episode prediction no longer matches its immutable snapshot");
    }
    return { episode, predictionSealed: true };
  }

  async #verifySourceSnapshot(snapshot: Record<string, string>): Promise<void> {
    for (const [ref, expectedHash] of Object.entries(snapshot)) {
      const parsed = parseCangHaiRef(ref);
      const { stdout } = await execFileAsync("git", [
        "-C",
        this.#root,
        "hash-object",
        "--",
        parsed.relativePath,
      ]);
      if (stdout.trim() !== expectedHash) {
        throw new Error(`Praxis derivation source drift requires reconciliation: ${ref}`);
      }
    }
  }
}
