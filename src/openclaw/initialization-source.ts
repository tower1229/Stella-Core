import { parse as parseYaml } from "yaml";
import path from "node:path";
import { readdir, realpath, stat } from "node:fs/promises";
import { readRepositoryBytes } from "../canghai/catalog-reader.js";
import { parseCangHaiRef } from "../canghai/ref.js";
import { bytesVersion, canonicalJson } from "../canghai/content-version.js";
import { isRecord } from "../shared/type-guards.js";
import { BOOTSTRAP_TARGETS, renderInitializationTemplate, renderDisplayIdentity, INITIALIZATION_TEMPLATE_VERSION, type BootstrapTarget, type HostIdentity } from "./initialization-templates.js";
import type { Materialization } from "./initialization.js";

export class InitializationSourceError extends Error {
  constructor(readonly category: string) { super(`Stella initialization source: ${category}`); }
}
function check(value: unknown, category: string): asserts value {
  if (!value) throw new InitializationSourceError(category);
}
function object(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  check(isRecord(value) && Object.keys(value).every((key) => keys.includes(key)), "invalid_materialization_document");
}
function strings(value: unknown): asserts value is string[] {
  check(Array.isArray(value) && value.every((item) => typeof item === "string" && item.trim()) && new Set(value).size === value.length,
    "invalid_materialization_list");
}
type Pin = { ref: string; sha256: string };
function pin(value: unknown): Pin {
  object(value, ["ref", "sha256"]);
  check(typeof value.ref === "string" && typeof value.sha256 === "string" && /^sha256:[a-f0-9]{64}$/.test(value.sha256), "invalid_source_pin");
  return { ref: value.ref, sha256: value.sha256 };
}
function location(ref: string): string {
  try {
    const parsed = parseCangHaiRef(ref);
    check(!parsed.fragment, "source_fragment_requires_materialization");
    return parsed.relativePath;
  } catch (error) {
    if (error instanceof InitializationSourceError) throw error;
    throw new InitializationSourceError("invalid_source_ref");
  }
}

export type CompiledInitializationSource = { materialization: Materialization; contents: Map<string, Buffer>; identity: HostIdentity & { name: string }; setup: true; runtimeBlockers: string[] };

/** Compile pinned, already-reviewed behavior. No model call or source mutation is permitted here. */
export async function compileInitializationSource(root: string, document: unknown,
  target: { agentId: string; hostVersion: string; skillRegistryRef?: string; contractProfile?: "alpha_praxis" | "full_memory" }): Promise<CompiledInitializationSource> {
  // Installing reviewed instructions is distinct from admitting a cognitive run.
  // No full-memory acceptance adapter exists yet; never turn installation into that verdict.
  const runtimeBlockers = new Set<string>(target.contractProfile === "full_memory" ? ["full_memory_acceptance_unavailable"] : []);
  object(document, ["schema_version", "id", "host_adapter", "behavior_mapping_ref", "projection_recipes", "skill_bindings", "automation_declarations", "required_checks"]);
  check(document.schema_version === "stella.host-materialization/v1" && typeof document.id === "string" && document.id.trim(), "invalid_materialization_identity");
  object(document.host_adapter, ["id", "version", "host_version", "harness"]);
  check(document.host_adapter.id === "openclaw" && document.host_adapter.version === "1" &&
    document.host_adapter.host_version === target.hostVersion && document.host_adapter.harness === "openclaw", "unsupported_host_adapter");
  strings(document.required_checks);
  const requiredChecks = document.required_checks;
  const supportedChecks = ["host_files", "host_skills", "host_identity", "host_setup"];
  check(supportedChecks.every((name) => requiredChecks.includes(name)), "required_host_check_missing");
  // Unimplemented adapters remain explicit blockers; accepting declarations is not evidence of restoration.
  check(requiredChecks.every((name) => supportedChecks.includes(name)), "required_check_adapter_unavailable");
  check(Array.isArray(document.automation_declarations), "invalid_automation_declarations");

  const read = async (value: unknown): Promise<Buffer> => {
    const input = pin(value);
    const bytes = await readRepositoryBytes(root, location(input.ref));
    check(bytes.length <= 2 * 1024 * 1024 && bytesVersion(bytes) === input.sha256, "source_pin_mismatch");
    return bytes;
  };
  const readDocument = async (value: unknown): Promise<unknown> => {
    try { return parseYaml(new TextDecoder("utf-8", { fatal: true }).decode(await read(value))); }
    catch (error) {
      if (error instanceof InitializationSourceError) throw error;
      throw new InitializationSourceError("invalid_pinned_document");
    }
  };
  const automationIds = new Set<string>();
  for (const declaration of document.automation_declarations) {
    object(declaration, ["id", "trigger", "timezone", "task_ref", "delegation_ref", "delivery_policy_ref", "enabled"]);
    check(typeof declaration.id === "string" && /^[a-z0-9][a-z0-9-]*$/.test(declaration.id) && !automationIds.has(declaration.id) &&
      typeof declaration.enabled === "boolean" && typeof declaration.timezone === "string", "invalid_automation_declaration");
    automationIds.add(declaration.id);
    object(declaration.trigger, ["kind", "expression"]);
    check(["interval", "cron"].includes(String(declaration.trigger.kind)) && typeof declaration.trigger.expression === "string" &&
      declaration.trigger.expression.trim(), "invalid_automation_declaration");
    try { new Intl.DateTimeFormat("en", { timeZone: declaration.timezone }); }
    catch { throw new InitializationSourceError("invalid_automation_declaration"); }
    check(typeof declaration.delegation_ref === "string" && typeof declaration.delivery_policy_ref === "string", "invalid_automation_declaration");
    location(declaration.delegation_ref); location(declaration.delivery_policy_ref);
    await readDocument(declaration.task_ref);
    // An enabled declaration still requires a transactional Host scheduler adapter.
    check(!declaration.enabled, "automation_adapter_unavailable");
  }
  const mapping = await readDocument(document.behavior_mapping_ref);
  object(mapping, ["schema_version", "id", "entries"]);
  check(mapping.schema_version === "stella.behavior-mapping/v1" && typeof mapping.id === "string" && mapping.id.trim() &&
    Array.isArray(mapping.entries) && mapping.entries.length <= 512, "invalid_behavior_mapping");
  const behaviors = new Map<string, { rules: Pin[]; status: string }>();
  for (const entry of mapping.entries) {
    object(entry, ["id", "source", "role", "status", "new_rule_refs", "reason", "replacement_requirements", "dependencies", "required"]);
    check(typeof entry.id === "string" && entry.id.trim() && !behaviors.has(entry.id) &&
      ["core_behavior", "owner_behavior", "integration"].includes(String(entry.role)) && typeof entry.required === "boolean" &&
      ["retained", "adapted", "retired", "unavailable", "conflict"].includes(String(entry.status)) &&
      typeof entry.reason === "string" && entry.reason.trim(), "invalid_behavior_mapping");
    strings(entry.replacement_requirements); strings(entry.dependencies);
    await read(entry.source);
    check(Array.isArray(entry.new_rule_refs), "invalid_behavior_mapping");
    const rules = entry.new_rule_refs.map(pin);
    for (const rule of rules) await read(rule);
    check(!entry.required || !["conflict", "unavailable"].includes(String(entry.status)), "required_behavior_unresolved");
    check(entry.status !== "retired" || rules.length === 0, "retired_behavior_has_rules");
    if (entry.status === "adapted" || entry.status === "retired") check(entry.replacement_requirements.length > 0, "behavior_replacement_basis_required");
    behaviors.set(entry.id, { rules, status: String(entry.status) });
  }
  for (const entry of mapping.entries) {
    // Dependencies are stable behavior IDs; missing or unresolved required behavior cannot be hidden by rendering fewer files.
    const row = entry as Record<string, unknown>;
    for (const id of row.dependencies as string[]) {
      const dependency = behaviors.get(id);
      check(dependency && (!row.required || ["retained", "adapted"].includes(dependency.status)), "behavior_dependency_unavailable");
    }
  }

  check(Array.isArray(document.projection_recipes) && document.projection_recipes.length === BOOTSTRAP_TARGETS.length,
    "required_bootstrap_missing");
  const contents = new Map<string, Buffer>();
  const files: Materialization["files"] = [];
  const usedBehaviors = new Set<string>();
  let identity: (HostIdentity & { name: string }) | undefined;
  for (const recipe of document.projection_recipes) {
    object(recipe, ["target", "template_version", "behavior_ids", "input_refs", "exposure_policy_ref"]);
    check(typeof recipe.target === "string" && BOOTSTRAP_TARGETS.includes(recipe.target as BootstrapTarget) && !contents.has(recipe.target) &&
      recipe.template_version === INITIALIZATION_TEMPLATE_VERSION, "invalid_projection_recipe");
    strings(recipe.behavior_ids);
    check(Array.isArray(recipe.input_refs), "invalid_projection_recipe");
    const allowedPins = new Set<string>();
    for (const id of recipe.behavior_ids) {
      const behavior = behaviors.get(id);
      check(behavior && ["retained", "adapted"].includes(behavior.status), "projection_behavior_unavailable");
      usedBehaviors.add(id);
      for (const rule of behavior.rules) allowedPins.add(canonicalJson(rule));
    }
    const inputs = recipe.input_refs.map(pin);
    check(inputs.length === allowedPins.size && new Set(inputs.map(canonicalJson)).size === inputs.length &&
      inputs.every((input) => allowedPins.has(canonicalJson(input))), "unmapped_projection_input");
    const exposure = await readDocument(recipe.exposure_policy_ref);
    object(exposure, ["schema_version", "id", "classification", "audiences", "targets"]);
    strings(exposure.audiences); strings(exposure.targets);
    check(exposure.schema_version === "stella.projection-exposure/v1" && typeof exposure.id === "string" && exposure.id.trim() &&
      exposure.classification === "public_behavior" && exposure.audiences.length === 1 && exposure.audiences[0] === "public" &&
      exposure.targets.includes(recipe.target), "bootstrap_exposure_forbidden");
    let bytes: Buffer;
    if (recipe.target === "IDENTITY.md") {
      check(inputs.length === 1, "display_identity_required");
      const value = await readDocument(inputs[0]);
      object(value, ["schema_version", "id", "name", "theme", "emoji", "avatar"]);
      check(value.schema_version === "stella.display-identity/v1" && typeof value.id === "string" && value.id.trim() &&
        typeof value.name === "string" && value.name.trim(), "invalid_display_identity");
      const fields: HostIdentity = {};
      for (const key of ["name", "theme", "emoji", "avatar"] as const) if (value[key] !== undefined) {
        const field = value[key];
        check(typeof field === "string" && field.trim() === field && field.length > 0 && field.length <= 256 &&
          !/[\x00-\x1f\x7f]/.test(field) && !/^[*_`]|[*_`]$/.test(field), "invalid_display_identity");
        fields[key] = field;
      }
      identity = { ...fields, name: value.name };
      bytes = Buffer.from(renderDisplayIdentity(identity));
    } else {
      const sections = [];
      for (const input of inputs) sections.push(new TextDecoder("utf-8", { fatal: true }).decode(await read(input)));
      bytes = Buffer.from(renderInitializationTemplate(recipe.target as BootstrapTarget, sections));
    }
    contents.set(recipe.target, bytes);
    files.push({ target: recipe.target, source: `compiled/${recipe.target}`, sha256: bytesVersion(bytes), executable: false });
  }
  check(Array.isArray(document.skill_bindings), "invalid_skill_bindings");
  const skills: string[] = [];
  const enabledSkills = new Set<string>(), boundSkills = new Set<string>();
  if (target.skillRegistryRef) {
    const bytes = await readRepositoryBytes(root, location(target.skillRegistryRef));
    const registry = await readDocument({ ref: target.skillRegistryRef, sha256: bytesVersion(bytes) });
    object(registry, ["schema_version", "id", "skills"]);
    check(registry.schema_version === "stella.skill-registry/v1" && typeof registry.id === "string" && Array.isArray(registry.skills), "skill_registry_mismatch");
    for (const row of registry.skills) {
      check(isRecord(row) && typeof row.id === "string" && typeof row.enabled === "boolean", "invalid_skill_registry");
      if (row.enabled) enabledSkills.add(`${registry.id}:${row.id}`);
    }
  }
  let resourceBytes = [...contents.values()].reduce((sum, bytes) => sum + bytes.length, 0);
  for (const binding of document.skill_bindings) {
    object(binding, ["registry_ref", "registry_id", "skill_id", "name", "source_root", "tree_digest", "files", "purpose", "policy_ref", "exposure_policy_ref", "behavior_ids"]);
    check(!target.skillRegistryRef || pin(binding.registry_ref).ref === target.skillRegistryRef, "skill_registry_manifest_mismatch");
    check(typeof binding.name === "string" && /^[a-z0-9][a-z0-9-]*$/.test(binding.name) && !skills.includes(binding.name) &&
      typeof binding.skill_id === "string" && typeof binding.purpose === "string" && binding.purpose.trim() &&
      typeof binding.source_root === "string" && Array.isArray(binding.files) && binding.files.length > 0, "invalid_skill_binding");
    const registry = await readDocument(binding.registry_ref);
    object(registry, ["schema_version", "id", "skills"]);
    check(registry.schema_version === "stella.skill-registry/v1" && typeof registry.id === "string" && registry.id === binding.registry_id &&
      Array.isArray(registry.skills), "skill_registry_mismatch");
    const entries = new Map<string, Record<string, unknown>>();
    for (const row of registry.skills) {
      object(row, ["id", "ref", "class", "enabled", "required_capabilities", "policy_ref"]);
      check(typeof row.id === "string" && row.id.trim() && !entries.has(row.id) && typeof row.ref === "string" &&
        ["core_behavior", "owner_behavior", "integration"].includes(String(row.class)) && typeof row.enabled === "boolean" &&
        typeof row.policy_ref === "string", "invalid_skill_registry");
      strings(row.required_capabilities);
      entries.set(row.id, row);
      if (row.enabled) enabledSkills.add(`${registry.id}:${row.id}`);
    }
    const entry = entries.get(binding.skill_id);
    check(entry?.enabled === true && entry.ref === binding.source_root && entry.policy_ref === pin(binding.policy_ref).ref, "skill_binding_mismatch");
    for (const capability of entry.required_capabilities as string[]) {
      check(/^[a-z0-9][a-z0-9_-]*$/.test(capability), "invalid_skill_capability");
      runtimeBlockers.add(`skill_capability_unverified:${capability}`);
    }
    boundSkills.add(`${registry.id}:${binding.skill_id}`);
    const policy = await readDocument(binding.policy_ref);
    check(isRecord(policy) && policy.schemaVersion === "stella.source-policy/v1", "invalid_skill_source_policy");
    strings(policy.readPurposes); strings(policy.deliveryScopes);
    check(policy.readPurposes.includes(binding.purpose) && policy.deliveryScopes.includes("host-workspace") && policy.retention === "retain", "skill_source_policy_forbidden");
    const exposure = await readDocument(binding.exposure_policy_ref);
    object(exposure, ["schema_version", "id", "classification", "audiences", "targets"]);
    strings(exposure.audiences); strings(exposure.targets);
    check(exposure.schema_version === "stella.projection-exposure/v1" && exposure.classification === "public_behavior" &&
      exposure.audiences.length === 1 && exposure.audiences[0] === "public" && exposure.targets.includes(`skills/${binding.name}`), "skill_exposure_forbidden");
    strings(binding.behavior_ids);
    const mappedRules = new Set<string>();
    for (const id of binding.behavior_ids) {
      const behavior = behaviors.get(id);
      check(behavior && ["retained", "adapted"].includes(behavior.status), "skill_behavior_unavailable");
      usedBehaviors.add(id);
      for (const rule of behavior.rules) mappedRules.add(canonicalJson(rule));
    }
    const sourceRoot = location(binding.source_root);
    const sourceDirectory = path.resolve(root, sourceRoot);
    check(await realpath(sourceDirectory) === sourceDirectory, "unsafe_skill_source");
    const inventory: string[] = [];
    let directories = 0;
    const walk = async (directory: string, prefix = ""): Promise<void> => {
      check(++directories <= 512, "skill_tree_capacity_exhausted");
      for (const item of await readdir(directory, { withFileTypes: true })) {
        check(item.name !== ".git" && !item.isSymbolicLink(), "unsafe_skill_source");
        const relative = prefix + item.name.normalize("NFC");
        if (item.isDirectory()) await walk(path.join(directory, item.name), `${relative}/`);
        else { check(item.isFile() && inventory.length < 512, "skill_tree_capacity_exhausted"); inventory.push(relative); }
      }
    };
    await walk(sourceDirectory);
    const tree: Array<{ path: string; sha256: string; executable: boolean }> = [];
    for (const file of binding.files) {
      object(file, ["path", "sha256", "executable"]);
      check(typeof file.path === "string" && !path.isAbsolute(file.path) && !/[\\:\x00-\x1f\x7f]/.test(file.path) &&
        file.path.split("/").every((part) => part !== "" && part !== "." && part !== ".." && part.toLowerCase() !== ".git") &&
        file.path.normalize("NFC") === file.path && typeof file.executable === "boolean", "invalid_skill_tree");
      const sourcePin = pin({ ref: `path:${sourceRoot}/${file.path}`, sha256: file.sha256 });
      const source = location(sourcePin.ref);
      const bytes = await read(sourcePin);
      const sourceExecutable = ((await stat(path.join(root, source))).mode & 0o111) !== 0;
      check(sourceExecutable === file.executable, "skill_source_mode_mismatch");
      const targetKey = `skills/${binding.name}/${file.path}`;
      check(!contents.has(targetKey) && files.length < 512, "duplicate_or_excessive_skill_file");
      if (file.path === "SKILL.md") check(mappedRules.has(canonicalJson(sourcePin)), "unmapped_skill_behavior");
      resourceBytes += bytes.length;
      check(resourceBytes <= 12 * 1024 * 1024, "materialization_resource_exhausted");
      contents.set(targetKey, bytes);
      files.push({ target: targetKey, source, sha256: sourcePin.sha256, executable: file.executable });
      tree.push({ path: file.path, sha256: sourcePin.sha256, executable: file.executable });
    }
    check(tree.some((file) => file.path === "SKILL.md") && canonicalJson(tree.map((file) => file.path).sort()) === canonicalJson(inventory.sort()), "skill_tree_incomplete");
    tree.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
    check(bytesVersion(canonicalJson(tree)) === binding.tree_digest, "skill_tree_digest_mismatch");
    skills.push(binding.name);
  }
  check([...enabledSkills].every((id) => boundSkills.has(id)), "enabled_skill_not_bound");
  check(identity, "display_identity_required");
  if (identity.avatar) check(!path.isAbsolute(identity.avatar) && !identity.avatar.includes("\\") && !identity.avatar.includes(":") &&
    identity.avatar.split("/").every((part) => part !== ".." && part !== "." && part !== "") && contents.has(identity.avatar), "avatar_binding_required");
  for (const entry of mapping.entries) {
    const row = entry as Record<string, unknown>;
    check(!row.required || row.status === "retired" || usedBehaviors.has(row.id as string), "required_behavior_not_projected");
  }
  return { materialization: { schemaVersion: "stella.host-files/v1", agentId: target.agentId,
    hostVersion: target.hostVersion, files, skills }, contents, identity, setup: true, runtimeBlockers: [...runtimeBlockers].sort() };
}
