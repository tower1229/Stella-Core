import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import { readRepositoryBytes } from "../canghai/catalog-reader.js";
import { bytesVersion, canonicalJson } from "../canghai/content-version.js";
import { episodeVersion } from "../praxis/episode-repository.js";
import { parseEpisodeV2 } from "../praxis/episode-v2.js";

const recordId = /^[a-zA-Z][a-zA-Z0-9_-]{0,199}$/;

export async function listPraxisEpisodeIds(root: string, episodeRoot: string): Promise<Set<string>> {
  if (!episodeRoot || path.isAbsolute(episodeRoot) || episodeRoot.split(/[\\/]/).some(part => !part || part === "." || part === ".." || part.includes(":"))) {
    throw new Error("praxis_acceptance_unsafe_record");
  }
  let directory = root;
  for (const part of ["", ...episodeRoot.split(/[\\/]/)]) {
    directory = path.join(directory, part);
    const details = await lstat(directory);
    if (!details.isDirectory() || details.isSymbolicLink()) throw new Error("praxis_acceptance_unsafe_record");
  }
  const entries = await readdir(path.join(root, episodeRoot), { withFileTypes: true });
  const ids = new Set<string>();
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    if (entry.isSymbolicLink()) throw new Error("praxis_acceptance_unsafe_record");
    if (!entry.isDirectory()) continue;
    if (!recordId.test(entry.name)) throw new Error("praxis_acceptance_invalid_record_id");
    ids.add(entry.name);
  }
  return ids;
}

/** Structural readback only; native completion and original evidence establish actual action. */
export async function readPraxisEpisodeState(root: string, episodeRoot: string, id: string) {
  if (!recordId.test(id)) throw new Error("praxis_acceptance_invalid_record_id");
  const directory = `${episodeRoot}/${id}`;
  const episode = await parseEpisodeV2(JSON.parse((await readRepositoryBytes(root, `${directory}/episode.json`)).toString("utf8")));
  if (episode.id !== id) throw new Error("praxis_acceptance_record_identity_mismatch");
  const version = episodeVersion(episode);
  const archived = await readRepositoryBytes(root, `${directory}/.versions/${version.slice(7)}.json`);
  if (canonicalJson(JSON.parse(archived.toString("utf8"))) !== canonicalJson(episode)) throw new Error("praxis_acceptance_version_mismatch");
  let prediction: Buffer | undefined;
  try { prediction = await readRepositoryBytes(root, `${directory}/prediction.json`); }
  catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
  if (episode.twin?.prediction) {
    if (!prediction || canonicalJson(JSON.parse(prediction.toString("utf8"))) !== canonicalJson(episode.twin.prediction)) {
      throw new Error("praxis_acceptance_prediction_mismatch");
    }
  } else if (prediction) throw new Error("praxis_acceptance_unexpected_prediction");
  return { episode, version, predictionHash: prediction ? bytesVersion(prediction) : null };
}
