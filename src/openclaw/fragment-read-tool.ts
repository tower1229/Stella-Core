import { Type } from "typebox";
import { CatalogError, validMemoryRef } from "../canghai/catalog-reader.js";
import { canonicalJson } from "../canghai/content-version.js";
import { sourceAccessKey, type SourceAccessDescriptor } from "../canghai/source-access.js";
import { assertEvidenceSegment, segmentLocator, sourceSegments } from "../canghai/source-segments.js";
import type { EpisodeEvidenceResolver, OriginalEvidence } from "../praxis/episode-evidence.js";
import { isRecord } from "../shared/type-guards.js";
import { assertProcessingStage, type ProcessingAuthority } from "./processing-authority.js";

export const FRAGMENT_READ_TOOL = "stella_read_fragment";
export const FRAGMENT_READ_PARAMETERS = Type.Union([
      Type.Object({ action: Type.Literal("list") }, { additionalProperties: false }),
      Type.Object({ action: Type.Literal("read"), handle: Type.String() }, { additionalProperties: false }),
    ]);
function check(value: unknown, category: string): asserts value { if (!value) throw new CatalogError(category); }

/** Re-read only evidence already admitted to this turn's cognition and output
 * checks. Handles reveal no filesystem paths and cannot expand the evidence set. */
export function createFragmentReadTool(input: {
  resolver: EpisodeEvidenceResolver; descriptors: SourceAccessDescriptor[]; originals: OriginalEvidence[];
  processingAuthority: ProcessingAuthority;
  assertCurrent(): Promise<void>;
}) {
  const originals = [...new Map(input.originals.map(original => [canonicalJson(original.ref), structuredClone(original)])).values()];
  const descriptors = structuredClone(input.descriptors);
  return {
    name: FRAGMENT_READ_TOOL, label: "Stella source fragments",
    description: "For memory skills: list this turn's admitted fragment descriptions, then read an exact handle. Originals retain Evidence citations. Unavailable evidence requires a new retrieval request; never read the source file directly.",
    parameters: FRAGMENT_READ_PARAMETERS,
    async execute(_id: string, request: unknown, signal?: AbortSignal) {
      const current = async () => {
        check(!signal?.aborted, "fragment_read_cancelled");
        await input.assertCurrent(); await input.resolver.reader.assertCurrent();
        check(!signal?.aborted, "fragment_read_cancelled");
      };
      await current();
      check(isRecord(request) && (request.action === "list" && Object.keys(request).join() === "action" ||
        request.action === "read" && Object.keys(request).sort().join() === "action,handle" && typeof request.handle === "string"), "invalid_fragment_request");
      const fragments = [];
      const seenPolicies = new Set<string>();
      for (const original of originals) {
        const evidence = await input.resolver.reader.read(original.ref, "evidence");
        check(validMemoryRef(evidence.source) && validMemoryRef(evidence.policyRef), "invalid_evidence");
        const source = await input.resolver.reader.read(evidence.source, "sources");
        const segment = assertEvidenceSegment(sourceSegments(source), evidence);
        if (!segment) continue;
        for (const policyRef of [evidence.policyRef, source.policyRef].filter(validMemoryRef)) {
          const key = canonicalJson(policyRef);
          if (seenPolicies.has(key)) continue;
          seenPolicies.add(key);
          assertProcessingStage(input.processingAuthority,
            await input.resolver.reader.read(policyRef, "policies"), "read");
        }
        const target = { sourceRef: evidence.source, policyRef: evidence.policyRef, segment: segmentLocator(segment) };
        const matched = descriptors.filter(descriptor => sourceAccessKey(descriptor) === sourceAccessKey(target));
        check(matched.length === 1 && matched[0]!.description.trim(), "fragment_descriptor_required");
        fragments.push({ handle: `F${fragments.length + 1}`, description: matched[0]!.description, ...target, evidenceRef: original.ref, original });
      }
      let details: { fragments?: Array<Omit<(typeof fragments)[number], "original">>; original?: OriginalEvidence };
      if (request.action === "list") {
        // Even descriptor listing must not expose a source after revocation.
        for (const item of fragments) check(canonicalJson(await input.resolver.readEvidence(item.original.ref)) === canonicalJson(item.original), "fragment_source_changed");
        details = { fragments: fragments.map(({ original: _original, ...descriptor }) => descriptor) };
      } else {
        const selected = fragments.find(fragment => fragment.handle === request.handle);
        check(selected, "fragment_handle_not_available");
        const original = await input.resolver.readEvidence(selected.evidenceRef);
        check(canonicalJson(original) === canonicalJson(selected.original), "fragment_source_changed");
        details = { original };
      }
      await current();
      return { content: [{ type: "text" as const, text: canonicalJson(details) }], details };
    },
  };
}
