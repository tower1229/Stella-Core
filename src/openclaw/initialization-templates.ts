/** The complete, reviewed document is authoritative. Rendering never adds a
 * second behavior policy or invents owner facts. v1 recipes require migration. */
export const INITIALIZATION_TEMPLATE_VERSION = "stella.host-templates/v2";
export const BOOTSTRAP_TARGETS = ["AGENTS.md", "SOUL.md", "IDENTITY.md", "USER.md", "MEMORY.md"] as const;
export type BootstrapTarget = (typeof BOOTSTRAP_TARGETS)[number];
export type HostIdentity = { name?: string; theme?: string; emoji?: string; avatar?: string };
export type DisplayIdentity = HostIdentity & { name: string; role?: string };

export function renderInitializationTemplate(_target: BootstrapTarget, reviewedSections: readonly string[]): string {
  if (reviewedSections.length !== 1 || !reviewedSections[0]?.trim()) {
    throw new Error("complete_reviewed_document_required");
  }
  return `<!-- ${INITIALIZATION_TEMPLATE_VERSION} -->\n\n${reviewedSections[0].trimEnd()}\n`;
}

export function renderDisplayIdentity(identity: DisplayIdentity): string {
  const fields = [
    ["Name", identity.name], ["Role", identity.role], ["Vibe", identity.theme],
    ["Emoji", identity.emoji], ["Avatar", identity.avatar],
  ];
  return renderInitializationTemplate("IDENTITY.md", ["# Identity\n\n" + fields
    .filter((entry) => entry[1] !== undefined).map(([key, value]) => `- ${key}: ${value}`).join("\n")]);
}

/** Parse Host-served IDENTITY.md display fields produced by renderDisplayIdentity. */
export function parseDisplayIdentityFields(content: string): HostIdentity & { role?: string } {
  const fields: HostIdentity & { role?: string } = {};
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/^- (Name|Role|Vibe|Emoji|Avatar): (.+)$/);
    if (!match) continue;
    const key = match[1]!;
    const value = match[2]!;
    if (key === "Name") fields.name = value;
    else if (key === "Role") fields.role = value;
    else if (key === "Vibe") fields.theme = value;
    else if (key === "Emoji") fields.emoji = value;
    else fields.avatar = value;
  }
  return fields;
}
