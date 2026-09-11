import assert from "node:assert/strict";
import test from "node:test";
import { bytesVersion } from "../src/canghai/content-version.js";
import { InitializationError } from "../src/openclaw/initialization.js";
import {
  assertHostChannelIdentity,
  verifyHostSkillTree,
} from "../src/openclaw/initialization-host-skills.js";
import { parseDisplayIdentityFields, renderDisplayIdentity } from "../src/openclaw/initialization-templates.js";

test("verifyHostSkillTree rejects resource bytes that do not match the recipe hash", async () => {
  const skill = "---\nname: probe\ndescription: Synthetic\n---\nBody.\n";
  const resource = "expected resource\n";
  const files = [
    { target: "skills/probe/SKILL.md", source: "s", sha256: bytesVersion(skill), executable: false },
    { target: "skills/probe/reference.txt", source: "r", sha256: bytesVersion(resource), executable: false },
  ];
  const contents = new Map<string, Buffer>([
    ["/skill/SKILL.md", Buffer.from(skill)],
    ["/skill/reference.txt", Buffer.from("tampered resource\n")],
  ]);
  await assert.rejects(
    verifyHostSkillTree({
      skillName: "probe",
      skillRoot: "/skill",
      files,
      realpath: async (value) => value,
      readFile: async (value) => {
        const bytes = contents.get(value);
        if (!bytes) throw new Error("missing");
        return bytes;
      },
    }),
    (error: unknown) => error instanceof InitializationError && error.category === "host_skill_content_mismatch",
  );
});

test("verifyHostSkillTree accepts Host-resolved skill body and resources that match the recipe", async () => {
  const skill = "---\nname: probe\ndescription: Synthetic\n---\nBody.\n";
  const resource = "expected resource\n";
  const files = [
    { target: "skills/probe/SKILL.md", source: "s", sha256: bytesVersion(skill), executable: false },
    { target: "skills/probe/reference.txt", source: "r", sha256: bytesVersion(resource), executable: false },
  ];
  const contents = new Map<string, Buffer>([
    ["/skill/SKILL.md", Buffer.from(skill)],
    ["/skill/reference.txt", Buffer.from(resource)],
  ]);
  await verifyHostSkillTree({
    skillName: "probe",
    skillRoot: "/skill",
    files,
    realpath: async (value) => value,
    readFile: async (value) => contents.get(value)!,
  });
});

test("assertHostChannelIdentity compares parsed IDENTITY fields, not substrings", () => {
  const document = renderDisplayIdentity({ name: "Unit Stella", theme: "Calm", emoji: "🧪" });
  assert.deepEqual(parseDisplayIdentityFields(document), { name: "Unit Stella", theme: "Calm", emoji: "🧪" });
  assertHostChannelIdentity({ name: "Unit Stella", theme: "Calm", emoji: "🧪" }, document);
  assert.throws(
    () => assertHostChannelIdentity({ name: "Unit Stella" }, "<!-- stella.host-templates/v2 -->\n\n# Identity\n\n- Name: Other\n"),
    (error: unknown) => error instanceof InitializationError && error.category === "host_channel_identity_mismatch",
  );
  assert.throws(
    () => assertHostChannelIdentity({ name: "Unit Stella" }, "# Identity\n\nMentions Unit Stella without a Name field.\n"),
    (error: unknown) => error instanceof InitializationError && error.category === "host_channel_identity_mismatch",
  );
});
