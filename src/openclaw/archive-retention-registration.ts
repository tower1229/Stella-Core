import path from "node:path";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { listSessionEntries, resolveStorePath } from "openclaw/plugin-sdk/session-store-runtime";
import { readSessionTranscriptRawDelta } from "openclaw/plugin-sdk/session-transcript-runtime";
import { acquireFileLock } from "openclaw/plugin-sdk/file-lock";
import { CatalogError, type CatalogReader } from "../canghai/catalog-reader.js";
import { bytesVersion, canonicalJson } from "../canghai/content-version.js";
import { verifyArchiveCoverage } from "../canghai/archive-cleanup.js";
import { HOST_INPUT_ARCHIVE_ADAPTER } from "../canghai/host-input-archive.js";
import { isRecord } from "../shared/type-guards.js";
import { inspectArchiveRetention, type ArchiveRetentionStatus } from "./archive-retention.js";

const run = promisify(execFile);
const intervalMs = 60_000;
const maxEvents = 4096;
export const archiveEventDigest = (agentId: string, sessionId: string, event: unknown) =>
  bytesVersion(canonicalJson([agentId, sessionId, event]));

/** Public SDK enumeration covers live generations; it cannot certify unenumerated historical generations. */
async function observe(agentId: string, store: string | undefined): Promise<string[]> {
  const storePath = resolveStorePath(store, { agentId });
  const entries = listSessionEntries({ agentId, storePath, readOnly: true });
  if (entries.length > 128) throw new CatalogError("host_archive_scan_capacity");
  const digests = new Set<string>();
  let bytes = 0, events = 0;
  for (const { sessionKey, entry } of entries) {
    const target = { agentId, sessionId: entry.sessionId, sessionKey, storePath };
    if (bytes >= 4 * 1024 * 1024 || events >= maxEvents) throw new CatalogError("host_archive_scan_capacity");
    const page = await readSessionTranscriptRawDelta({ ...target, maxBytes: 4 * 1024 * 1024 - bytes, maxEvents: maxEvents - events });
    if (page.kind !== "page") throw new CatalogError("host_archive_original_unavailable");
    if (page.hasMore || page.requiredBytes) throw new CatalogError("host_archive_scan_capacity");
    bytes += page.serializedBytes; events += page.events.length;
    for (const { event } of page.events) {
      if (isRecord(event) && event.type === "message") digests.add(archiveEventDigest(agentId, entry.sessionId, event));
    }
  }
  return [...digests];
}

async function archived(reader: CatalogReader, agentId: string, remote: string, branch: string): Promise<Set<string>> {
  const git = async (args: string[]) => (await run("git", ["-C", reader.root, ...args], { timeout: 10_000, maxBuffer: 1024 * 1024 })).stdout.trim();
  const revision = await git(["rev-parse", "HEAD"]);
  if (await git(["status", "--porcelain", "--untracked-files=all"])) throw new CatalogError("archive_not_committed");
  const remoteHead = await git(["ls-remote", "--exit-code", "--", remote, `refs/heads/${branch}`]);
  if (remoteHead.split(/\s+/)[0] !== revision) throw new CatalogError("archive_sync_pending");
  const verified = new Set<string>(), digests = new Set<string>();
  for (const ref of reader.catalog.sources.filter(source => source.status === "current")) {
    const source = await reader.read(ref, "sources");
    if (!isRecord(source.origin) || source.origin.adapterId !== HOST_INPUT_ARCHIVE_ADAPTER) continue;
    if (!isRecord(source.coverageRef) || typeof source.coverageRef.id !== "string" || typeof source.coverageRef.version !== "string") continue;
    const coverageRef = { id: source.coverageRef.id, version: source.coverageRef.version };
    if (!ref.dependencies.some(dependency => dependency.id === coverageRef.id && dependency.version === coverageRef.version)) {
      throw new CatalogError("archive_manifest_mismatch");
    }
    const key = canonicalJson(coverageRef);
    if (!verified.has(key)) {
      // Legacy/no-manifest coverage remains backlog. Corruption and sync failures do not become success.
      const coverage = await reader.read(coverageRef, "coverage");
      if (!coverage.manifest || coverage.completeForDeclaredScope !== true) continue;
      await verifyArchiveCoverage(reader, coverageRef);
      verified.add(key);
    }
    const first = Array.isArray(source.payloads) ? source.payloads[0] : undefined;
    if (!isRecord(first) || typeof first.sha256 !== "string") throw new CatalogError("invalid_source");
    const body: unknown = JSON.parse((await reader.readPayload(ref, first.sha256)).bytes.toString("utf8"));
    if (isRecord(body) && body.agentId === agentId && typeof body.sessionId === "string" && isRecord(body.event) &&
      body.event.type === "message" && body.event.id === source.origin.upstreamId && body.sessionId === source.origin.collectionId) {
      digests.add(archiveEventDigest(agentId, body.sessionId, body.event));
    }
  }
  await reader.assertCurrent();
  if (await git(["rev-parse", "HEAD"]) !== revision || await git(["status", "--porcelain", "--untracked-files=all"])) {
    throw new CatalogError("archive_changed_during_scan");
  }
  return digests;
}

type Config = { agentId: string; canghaiRoot: string; archiveRetention?: "hold_and_monitor";
  dataMode: string; durabilityRemote?: string; durabilityBranch?: string };

/** No discovery-time I/O. Opt-in, local authenticated status plus continuous Host service monitoring. */
export function registerArchiveRetention(api: OpenClawPluginApi, config: Config, openReader: () => Promise<CatalogReader>) {
  let stateRoot: string | undefined, timer: ReturnType<typeof setTimeout> | undefined;
  let inflight: Promise<ArchiveRetentionStatus> | undefined;
  let stopped = false, checkedAt = 0;
  const blocked = (category: string): ArchiveRetentionStatus => ({ state: "blocked", scope: "observed_message_events",
    fullRetention: false, blockers: [category], observedEvents: null, backlogEvents: null, originalUnavailableEvents: null });
  let status = blocked("archive_monitor_not_started");
  let report = (_status: ArchiveRetentionStatus) => {};
  const inspect = (): Promise<ArchiveRetentionStatus> => {
    if (inflight) return inflight;
    inflight = (async () => {
      try {
        if (stopped || !stateRoot) throw new CatalogError("archive_monitor_not_started");
        if (config.archiveRetention !== "hold_and_monitor") throw new CatalogError("archive_monitor_not_enabled");
        if (config.dataMode !== "managed_durable_write" || !config.durabilityRemote || !config.durabilityBranch) {
          throw new CatalogError("archive_managed_durability_required");
        }
        const hostConfig = api.runtime.config.current();
        const file = path.join(stateRoot, "observed.json");
        const lock = await acquireFileLock(file, { stale: 120_000, retries: { retries: 0 }, staleRecovery: "fail-closed" });
        try {
          let previous: string[] = [];
          try {
            const value: unknown = JSON.parse(await readFile(file, "utf8"));
            if (!Array.isArray(value) || value.length > maxEvents || !value.every(item => typeof item === "string" && /^sha256:[a-f0-9]{64}$/.test(item))) {
              throw new CatalogError("invalid_archive_monitor_journal");
            }
            previous = value;
          } catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
          status = await inspectArchiveRetention({ hostVersion: api.runtime.version, maintenanceMode: hostConfig.session?.maintenance?.mode,
            previous, observe: async () => observe(config.agentId, hostConfig.session?.store),
            remember: async values => {
              if (values.length > maxEvents) throw new CatalogError("host_archive_scan_capacity");
              await writeFile(`${file}.tmp`, canonicalJson(values), { mode: 0o600 });
              await rename(`${file}.tmp`, file);
            },
            archived: async () => archived(await openReader(), config.agentId, config.durabilityRemote!, config.durabilityBranch!),
          });
          if (api.runtime.config.current().session?.maintenance?.mode !== "warn") status = blocked("host_early_cleanup_enabled");
        } finally { await lock.release(); }
      } catch (error) { status = blocked(error instanceof CatalogError ? error.category : "archive_monitor_failed"); }
      checkedAt = Date.now();
      if (!stopped) report(status);
      return status;
    })().finally(() => { inflight = undefined; });
    return inflight;
  };
  api.registerGatewayMethod("stella.archiveRetention", async ({ params, client, respond }) => {
    if (client?.connect.role !== "operator" || !client.connect.scopes?.includes("operator.admin") || api.runtime.config.current().gateway?.mode === "remote") {
      respond(false, undefined, { code: "INVALID_REQUEST", message: "Archive monitoring requires local operator.admin" }); return;
    }
    if (Object.keys(params).length) { respond(false, undefined, { code: "INVALID_REQUEST", message: "Archive status takes no parameters" }); return; }
    respond(true, { ...await inspect(), checkedAt: new Date(checkedAt).toISOString(), intervalMs });
  }, { scope: "operator.admin" });
  if (config.archiveRetention === "hold_and_monitor") api.registerService({
    id: "stella-archive-retention",
    async start(ctx) {
      await inflight;
      clearTimeout(timer);
      stopped = false;
      checkedAt = 0;
      status = blocked("archive_monitor_not_started");
      stateRoot = path.join(ctx.stateDir, "stella-core", "archive-retention", bytesVersion(canonicalJson([config.canghaiRoot, config.agentId])).slice(7));
      await mkdir(stateRoot, { recursive: true });
      report = value => {
        if (value.state === "blocked" || value.backlogEvents) ctx.serviceHealth?.reportFailure(new Error(value.blockers[0] ?? "archive_backlog_pending"));
        else ctx.serviceHealth?.clearFailure();
      };
      const tick = async () => { await inspect(); if (!stopped) { timer = setTimeout(() => { void tick(); }, intervalMs); timer.unref(); } };
      void tick();
    },
    async stop() { stopped = true; clearTimeout(timer); await inflight; },
  });
  return { blockers: () => {
    if (config.archiveRetention !== "hold_and_monitor") return [];
    if (api.runtime.config.current().session?.maintenance?.mode !== "warn") return ["host_early_cleanup_enabled"];
    if (stopped || !checkedAt || Date.now() - checkedAt > intervalMs * 2) return ["archive_monitor_unavailable"];
    return status.blockers;
  } };
}
