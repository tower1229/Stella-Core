import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import { parse as parseYaml } from "yaml";

type SchemaName =
  | "consciousness-manifest"
  | "framework-ir"
  | "praxis-episode"
  | "twin-hypothesis";

const schemaFileByName: Record<SchemaName, string> = {
  "consciousness-manifest": "consciousness-manifest.schema.json",
  "framework-ir": "framework-ir.schema.json",
  "praxis-episode": "praxis-episode.schema.json",
  "twin-hypothesis": "twin-hypothesis.schema.json",
};

let validatorsPromise: Promise<Record<SchemaName, ValidateFunction>> | undefined;

async function loadValidators(): Promise<Record<SchemaName, ValidateFunction>> {
  if (!validatorsPromise) {
    validatorsPromise = (async () => {
      const ajv = new Ajv2020({ allErrors: true, strict: true });
      ajv.addFormat("date-time", {
        type: "string",
        validate: (value: string) =>
          /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
          !Number.isNaN(Date.parse(value)),
      });
      const entries = await Promise.all(
        Object.entries(schemaFileByName).map(async ([name, file]) => {
          const schemaUrl = new URL(`../../../schemas/${file}`, import.meta.url);
          const schema = JSON.parse(await readFile(fileURLToPath(schemaUrl), "utf8")) as object;
          return [name, ajv.compile(schema)] as const;
        }),
      );
      return Object.fromEntries(entries) as Record<SchemaName, ValidateFunction>;
    })();
  }
  return validatorsPromise;
}

function describeErrors(errors: ErrorObject[] | null | undefined): string {
  return (errors ?? [])
    .slice(0, 3)
    .map((error) => `${error.instancePath || "/"} ${error.message ?? "is invalid"}`)
    .join("; ");
}

export async function validateSchema(
  name: SchemaName,
  value: unknown,
): Promise<void> {
  const validators = await loadValidators();
  const validate = validators[name];
  if (!validate(value)) {
    throw new Error(`${name} schema validation failed: ${describeErrors(validate.errors)}`);
  }
}

function extractMarkdownFrontmatter(input: string): {
  frontmatter: Record<string, unknown>;
  body: string;
} {
  const match = input.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) throw new Error("Twin hypothesis must contain YAML frontmatter");
  const parsed = parseYaml(match[1] ?? "") as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Twin hypothesis frontmatter must be an object");
  }
  return { frontmatter: parsed as Record<string, unknown>, body: match[2] ?? "" };
}

function hypothesisStatement(body: string): string {
  const withoutHeading = body.replace(/^\s*#\s+Hypothesis\s*/i, "").trim();
  const statement = withoutHeading.split(/\r?\n\s*\r?\n/)[0]?.trim() ?? "";
  if (!statement) throw new Error("Twin hypothesis body must contain a statement");
  return statement;
}

export function parseTwinHypothesisRecord(input: string): Record<string, unknown> {
  const { frontmatter, body } = extractMarkdownFrontmatter(input);
  const rename: Record<string, string> = {
    schema_version: "schemaVersion",
    supporting_refs: "supportingRefs",
    counter_refs: "counterRefs",
    source_baseline: "sourceBaseline",
    source_snapshot: "sourceSnapshot",
    created_at: "createdAt",
    updated_at: "updatedAt",
    last_tested_at: "lastTestedAt",
    derived_from: "derivedFrom",
  };
  const normalized: Record<string, unknown> = { statement: hypothesisStatement(body) };
  for (const [key, value] of Object.entries(frontmatter)) {
    normalized[rename[key] ?? key] = value;
  }
  return normalized;
}
