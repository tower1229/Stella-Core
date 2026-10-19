import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { resolveEmbeddingEndpointUrl, resolveRemoteEmbeddingClient, sanitizeEmbeddingCacheHeaders } from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";
import type { OpenClawConfig } from "openclaw/plugin-sdk/plugin-entry";
import { CatalogError } from "../canghai/catalog-reader.js";
import { bytesVersion, canonicalJson } from "../canghai/content-version.js";
import { readPersonalContextAccessBinding } from "../canghai/personal-context-access.js";
import { isRecord } from "../shared/type-guards.js";
import { assertPrivateContextAudience, resolveTurnAudience } from "./turn-audience.js";
import { assertProcessingAuthority, type ProcessingAuthority } from "./processing-authority.js";
import type { BoundTurnRequest } from "./turn-request.js";

type Settings = NonNullable<ReturnType<typeof import("openclaw/plugin-sdk/memory-core-host-engine-foundation").resolveMemorySearchConfig>>;
export type NativeQueryEmbeddingReceipt = Readonly<{ kind: "native_query_embedding" }>;
type Binding = { vector: number[]; digest: string; assertCurrent(): Promise<void> };
const receipts = new WeakMap<NativeQueryEmbeddingReceipt, Binding>();
function check(value: unknown, category: string): asserts value { if (!value) throw new CatalogError(category); }

/** Only this transport can mint a query receipt. No caller-supplied vector or
 * provider return value can stand in for the actual one-query HTTP exchange. */
export function readNativeQueryEmbedding(receipt: NativeQueryEmbeddingReceipt) {
  const bound = receipts.get(receipt);
  check(bound, "native_query_embedding_unbound");
  return { ...bound, vector: [...bound.vector] };
}

/** Query processing is a separate, explicit grant. It does not authorize document
 * embedding, indexing, batch work, source expansion or business admission. */
export function createNativeQueryEmbedding(input: {
  request: BoundTurnRequest; authority: ProcessingAuthority; processingGrant: object;
  currentConfig(): OpenClawConfig; assertCurrent(): Promise<void>; signal?: AbortSignal;
  configurationHash?(): string;
}) {
  const request = structuredClone(input.request), authority = structuredClone(input.authority);
  let inFlight: Promise<NativeQueryEmbeddingReceipt> | undefined;
  let identity: string | undefined;
  return (settings: Settings, index: { model: string; providerKey: string; dimensions: number }) => {
    const nextIdentity = bytesVersion(JSON.stringify({ settings, index }));
    check(identity === undefined || identity === nextIdentity, "native_query_embedding_identity_mismatch");
    identity = nextIdentity;
    // One original query per run. A rejected exchange remains rejected; callers
    // cannot silently retry with another model, vector, endpoint or query.
    return inFlight ??= (async () => {
      const signal = input.signal ? AbortSignal.any([input.signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000);
      const configurationHash = input.configurationHash ?? (() => bytesVersion(JSON.stringify(input.currentConfig())));
      const configuration = configurationHash();
      const current = async () => {
        check(!input.signal?.aborted, "native_query_embedding_cancelled"); await input.assertCurrent();
        const loaded = await readPersonalContextAccessBinding(input.processingGrant);
        check(configurationHash() === configuration, "native_query_embedding_configuration_changed");
        check(request.requestHash === bytesVersion(request.prompt) && request.prompt.trim() && request.prompt.length <= 8000,
          "native_query_embedding_request_mismatch");
        assertPrivateContextAudience(resolveTurnAudience(request));
        check(request.senderIsOwner && request.chatType === "direct" && request.senderId &&
          loaded.config.requesterIds.includes(request.senderId) && loaded.config.ownerId === authority.ownerId,
        "native_query_embedding_requester_forbidden");
        assertProcessingAuthority(authority, { request, modelRef: authority.modelRef, deployment: authority.deployment,
          generationId: authority.generationId, purpose: loaded.config.purpose });
        check(loaded.config.modelRefs.includes(authority.modelRef), "personal_context_model_forbidden");
        const grant = loaded.config.queryEmbedding;
        check(grant, "native_query_embedding_grant_required");
        check(settings.enabled && settings.provider === grant.provider && settings.model === grant.model &&
          index.model === grant.model && index.dimensions === grant.dimensions && settings.fallback === "none" &&
          settings.store.vector.enabled &&
          settings.inputType === undefined && settings.queryInputType === undefined && settings.documentInputType === undefined &&
          (settings.outputDimensionality === undefined || settings.outputDimensionality === grant.dimensions),
        "native_query_embedding_identity_mismatch");
        check(!input.signal?.aborted, "native_query_embedding_cancelled");
        return grant;
      };
      const grant = await current();
      const client = await resolveRemoteEmbeddingClient({ provider: "openai", options: {
        config: input.currentConfig(), model: grant.model, remote: settings.remote,
      }, defaultBaseUrl: "https://api.openai.com/v1", normalizeModel: model => model }).catch(() => {
        throw new CatalogError("native_query_embedding_credentials_unavailable");
      });
      await current();
      const endpoint = resolveEmbeddingEndpointUrl(client.baseUrl, "embeddings");
      check(endpoint === grant.endpoint && client.model === grant.model, "native_query_embedding_endpoint_mismatch");
      // Exact OpenClaw 2026.8.2 OpenAI adapter identity, including nonsecret
      // routing headers. Secrets are resolved by the public Host credential port.
      const excluded = ["authorization", "x-api-key", "api-key"];
      if (new URL(client.baseUrl).hostname === "api.openai.com") excluded.push("version", "user-agent");
      const key = bytesVersion(JSON.stringify({ provider: "openai", baseUrl: client.baseUrl, model: client.model,
        outputDimensionality: settings.outputDimensionality, documentInputType: undefined,
        headers: sanitizeEmbeddingCacheHeaders(client.headers, excluded) })).slice(7);
      check(index.providerKey === key, "native_query_embedding_identity_mismatch");
      const body = JSON.stringify({ model: grant.model, input: [request.prompt],
        ...(settings.outputDimensionality === undefined ? {} : { dimensions: settings.outputDimensionality }) });
      await current();
      let responseDigest: string;
      let vector: number[];
      try {
        const exchange = await fetchWithSsrFGuard({ url: endpoint, policy: client.ssrfPolicy, maxRedirects: 0,
          signal, init: { method: "POST", headers: client.headers, body }, auditContext: "stella-query-embedding" });
        try {
          check(exchange.response.ok, "native_query_embedding_transport_failed");
          const reader = exchange.response.body?.getReader();
          check(reader, "native_query_embedding_response_invalid");
          const chunks: Uint8Array[] = []; let size = 0;
          try {
            for (;;) {
              const part = await reader.read(); signal.throwIfAborted();
              if (part.done) break;
              size += part.value.byteLength;
              check(size <= 256_000, "native_query_embedding_response_budget_exhausted");
              chunks.push(part.value);
            }
          } finally { await reader.cancel(); reader.releaseLock(); }
          const raw = Buffer.concat(chunks), payload: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
          check(isRecord(payload) && payload.model === grant.model && Array.isArray(payload.data) && payload.data.length === 1 &&
            isRecord(payload.data[0]) && payload.data[0].index === 0, "native_query_embedding_response_invalid");
          const values = payload.data[0].embedding;
          check(Array.isArray(values) && values.length === grant.dimensions && values.every(value => typeof value === "number" && Number.isFinite(value)) &&
            values.some(value => value !== 0), "native_query_embedding_response_invalid");
          vector = Array.from(new Float32Array(values as number[]));
          check(vector.every(Number.isFinite) && vector.some(value => value !== 0), "native_query_embedding_response_invalid");
          responseDigest = bytesVersion(raw);
        } finally { await exchange.release(); }
      } catch (error) {
        if (error instanceof CatalogError) throw error;
        throw new CatalogError(signal.aborted ? "native_query_embedding_cancelled" : "native_query_embedding_transport_failed");
      }
      await current();
      const receipt: NativeQueryEmbeddingReceipt = Object.freeze({ kind: "native_query_embedding" });
      receipts.set(receipt, { vector, assertCurrent: async () => { await current(); }, digest: bytesVersion(canonicalJson({ authority, grant,
        request: bytesVersion(body), response: responseDigest, vector: bytesVersion(Buffer.from(new Float32Array(vector).buffer)), index })) });
      return receipt;
    })();
  };
}
