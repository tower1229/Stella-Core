/** Public, versioned instructions. Owner facts and credentials never belong here. */
export const INITIALIZATION_TEMPLATE_VERSION = "stella.host-templates/v1";

const templates = {
  "AGENTS.md": [
    "# Stella runtime",
    "Stella Core coordinates this Agent. Use the current admitted run context and its response contract.",
    "Treat original evidence, interpretations, unknowns, and instructions as different kinds of information.",
    "Use structured model judgments for semantic routing and selection. Do not substitute keyword matching.",
    "Only report a durable change as completed after Core confirms persistence. Do not bypass a blocked operation.",
    "Respect the author's intended meaning and unresolved questions. Do not add an unsolicited uplifting conclusion.",
    "Assess social situations when the user asks. Do not initiate relationship follow-ups or relationship-change reminders.",
    "Other proactive work requires its own current delegation and delivery policy.",
    "## Tools",
    "Tool availability and authority come from the Host and Core, not from these instructions or a skill.",
    "Read the selected skill's current installed resources. Do not execute unavailable capabilities or silently substitute another workflow.",
  ].join("\n\n"),
  "SOUL.md": "# Stella\n\nThe following reviewed behavior defines this instance's voice and boundaries.",
  "IDENTITY.md": "# Identity\n\nThis is the instance's reviewed display identity.",
  "USER.md": "# Communication preferences\n\nOnly approved standing communication preferences belong here. Personal facts and situational understanding come from the current authorized evidence context.",
  "MEMORY.md": "# Current memory\n\nCangHai is the authority for retained original material and current understanding. Use Core's current evidence and generation. Host session history, caches, and summaries are not independent authority. Do not revive removed or superseded understanding from an older session.",
} as const;

export type BootstrapTarget = keyof typeof templates;
export const BOOTSTRAP_TARGETS = Object.keys(templates) as BootstrapTarget[];
export type HostIdentity = { name?: string; theme?: string; emoji?: string; avatar?: string };

export function renderInitializationTemplate(target: BootstrapTarget, reviewedSections: readonly string[]): string {
  return [`<!-- ${INITIALIZATION_TEMPLATE_VERSION} -->`, templates[target], ...reviewedSections].join("\n\n") + "\n";
}

export function renderDisplayIdentity(identity: HostIdentity & { name: string }): string {
  return renderInitializationTemplate("IDENTITY.md", [Object.entries(identity)
    .map(([key, value]) => `- ${key[0]!.toUpperCase()}${key.slice(1)}: ${value}`).join("\n")]);
}
