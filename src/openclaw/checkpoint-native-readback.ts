import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { CatalogError, validMemoryRef } from "../canghai/catalog-reader.js";
import { canonicalJson } from "../canghai/content-version.js";
import { learningChangeReadbackTargets, readAuthorizedExact, type AuthorizedExactReadScope, type ReadGroup } from "../canghai/authorized-exact-readback.js";
import type { CatalogReader } from "../canghai/catalog-reader.js";
import type { VersionedRef } from "../praxis/episode-v2.js";

type Capability = Parameters<OpenClawPluginApi["registerMemoryCapability"]>[0];
export type NativeReadbackOpen = Parameters<NonNullable<Capability["providerRuntime"]>["open"]>[0];
type Handle = NonNullable<Awaited<ReturnType<NonNullable<Capability["providerRuntime"]>["open"]>>["provider"]>;
export type NativeReadbackReference = Parameters<Handle["get"]>[0]["reference"];
export type NativeReadbackScope = AuthorizedExactReadScope;
function check(value: unknown, category: string): asserts value { if (!value) throw new CatalogError(category); }
function referenceFor(providerId: string, group: ReadGroup, ref: VersionedRef): NativeReadbackReference {
  return { providerId, id: canonicalJson([group, ref.id]), revision: ref.version };
}

/** A precise lookup identity, never a permission or latest-version lookup. */
export function evidenceNativeReference(input: { providerId: string; evidenceRef: VersionedRef }): NativeReadbackReference {
  check(input.providerId.trim(), "native_readback_provider_required");
  check(validMemoryRef(input.evidenceRef), "native_readback_reference_invalid");
  return referenceFor(input.providerId, "evidence", input.evidenceRef);
}

export async function learningChangeNativeReferences(input: {
  providerId: string; reader: CatalogReader; changeRef: VersionedRef;
}): Promise<NativeReadbackReference[]> {
  check(input.providerId.trim(), "native_readback_provider_required");
  return (await learningChangeReadbackTargets(input)).map(target => referenceFor(input.providerId, target.group, target.ref));
}

/** Exact-version get only. Deliberately not wired into the main slot; no writer, search or semantic selection. */
export function registerCheckpointNativeReadback(api: Pick<OpenClawPluginApi, "id" | "registerMemoryCapability">, input: {
  providerId: string;
  openReadScope(params: NativeReadbackOpen): Promise<NativeReadbackScope>;
}): void {
  const providerId = input.providerId, openReadScope = input.openReadScope;
  check(providerId.trim() && api.id === providerId, "native_readback_provider_mismatch");
  api.registerMemoryCapability({ providerRuntime: { async open(params) {
    let closed = false;
    const current = () => {
      check(!closed, "native_readback_lease_closed");
      params.context.assertCurrent(); params.context.signal?.throwIfAborted();
    };
    current();
    return { provider: {
      capabilities: { sources: ["memory"], pagination: false, candidates: [], projectFilter: false },
      async search() { current(); throw new CatalogError("native_readback_search_unsupported"); },
      async get(request) {
        current();
        const authority = params.context.authority;
        check(authority.kind === "operator" && (authority.scopes.includes("operator.read") || authority.scopes.includes("operator.admin")) ||
          authority.kind === "session" && authority.audience?.agentId === params.agentId, "native_readback_caller_forbidden");
        const reference = { ...request.reference };
        check(reference.providerId === providerId && reference.fragment === undefined && request.from === undefined && request.lines === undefined,
          "native_readback_request_unsupported");
        let decoded: unknown;
        try { decoded = JSON.parse(reference.id); } catch { throw new CatalogError("native_readback_reference_invalid"); }
        check(Array.isArray(decoded) && decoded.length === 2 && ["works", "understandings", "evidence"].includes(decoded[0]) &&
          typeof decoded[1] === "string" && canonicalJson(decoded) === reference.id &&
          validMemoryRef({ id: decoded[1], version: reference.revision }), "native_readback_reference_invalid");
        const group = decoded[0] as ReadGroup, target = { id: decoded[1] as string, version: reference.revision! };
        const scope = await openReadScope(params); current();
        const result = await readAuthorizedExact({ scope, target: { group, ref: target }, assertCurrent: current });
        current();
        return { status: "ok", reference: referenceFor(providerId, group, target), text: result.text, truncated: false };
      },
      async health() { current(); return { status: "degraded", message: "Exact-version readback only; search is unsupported." }; },
      async close() { closed = true; },
    } };
  } } });
}
