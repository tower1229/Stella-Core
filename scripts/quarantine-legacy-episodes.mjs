import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { planLegacyEpisodeQuarantine, quarantineLegacyEpisodes } from "../dist/src/praxis/legacy-migration.js";

const { values } = parseArgs({ options: {
  "episode-root": { type: "string" },
  "plan": { type: "string" },
  "apply": { type: "boolean", default: false },
} });
if (!values["episode-root"] || !values.plan) {
  throw new Error("Required: --episode-root <directory> --plan <private-json-path> [--apply]");
}
const root = path.resolve(values["episode-root"]);
const planPath = path.resolve(values.plan);
let result;
if (values.apply) {
  const plan = JSON.parse(await readFile(planPath, "utf8"));
  result = await quarantineLegacyEpisodes(root, plan);
} else {
  const plan = await planLegacyEpisodeQuarantine(root);
  await mkdir(path.dirname(planPath), { recursive: true });
  await writeFile(planPath, `${JSON.stringify(plan, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  result = { plannedCount: plan.records.length,
    unverifiedActionCount: plan.records.filter((record) => record.reasons.includes("action_evidence_unverified")).length,
    activatedCount: 0 };
}
// The detailed plan is private: stdout contains no Episode IDs, source paths, or text.
console.log(JSON.stringify({ ...result, committed: false, pushed: false }));
