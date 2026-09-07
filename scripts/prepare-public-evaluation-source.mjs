import { createPublicEvaluationFixture } from "../.test-dist/tests/public-evaluation-fixture.js";
import { initializeFixtureRepository } from "../.test-dist/tests/consciousness-fixture.js";
import { assertPublicEvaluationSource } from "../dist/src/acceptance/public-evaluation-source.js";

// No source repository argument: this command constructs public synthetic bytes only.
if (process.argv.length !== 2) throw new Error("Public source preparation takes no personal repository inputs");
const root = await createPublicEvaluationFixture();
const revision = await initializeFixtureRepository(root);
await assertPublicEvaluationSource(root);
console.log(JSON.stringify({ root, revision, schemaVersion: "stella.public-evaluation-source/v1",
  contextPolicy: "case_only", privateDataIncluded: false, accepted: false,
  scope: "synthetic source preparation; not model evaluation, private learning or Alpha acceptance" }));
