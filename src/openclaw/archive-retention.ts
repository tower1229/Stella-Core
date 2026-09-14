/** A maintenance hold is a coordination mode, never permission to delete Host history. */
export type ArchiveRetentionStatus = {
  state: "held" | "blocked";
  scope: "observed_message_events";
  fullRetention: false;
  blockers: string[];
  observedEvents: number | null;
  backlogEvents: number | null;
  originalUnavailableEvents: number | null;
};

export async function inspectArchiveRetention(input: {
  hostVersion: string;
  maintenanceMode: unknown;
  previous?: string[];
  remember?(events: string[]): Promise<void>;
  observe(): Promise<string[]>;
  archived(): Promise<Set<string>>;
}): Promise<ArchiveRetentionStatus> {
  const blockers: string[] = [];
  if (input.hostVersion !== "2026.8.2") blockers.push("host_archive_version_unsupported");
  if (input.maintenanceMode !== "warn") blockers.push("host_early_cleanup_enabled");
  if (blockers.length) return { state: "blocked", scope: "observed_message_events", fullRetention: false,
    blockers, observedEvents: null, backlogEvents: null, originalUnavailableEvents: null };
  const current = new Set(await input.observe());
  const observed = new Set([...(input.previous ?? []), ...current]);
  await input.remember?.([...observed].sort());
  const archived = await input.archived();
  const backlog = [...observed].filter(event => !archived.has(event));
  return { state: "held", scope: "observed_message_events", fullRetention: false, blockers,
    observedEvents: observed.size, backlogEvents: backlog.length,
    originalUnavailableEvents: backlog.filter(event => !current.has(event)).length };
}
