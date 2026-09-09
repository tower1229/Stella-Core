import { CatalogError } from "./catalog-reader.js";
import { parseSourceUsageRules, type SourceUsageRules } from "./source-policy.js";

// These ids are structured LLM review results, not terms matched against source
// text. Unknown results require explicit implementation rather than inference.
const interpretation: Record<string, string> = {
  retain_metadata_permissions: "Preserve all metadata permissions. Permission to read does not authorize quotation, external delivery, publication or unrelated use.",
  preserve_external_framework_provenance: "Identify external frameworks as external knowledge. Collection does not mean the owner authored, adopted or believes them.",
  preserve_contextual_application: "Apply interpretations only within their supported context; do not turn a contextual example into a universal personal rule.",
  preserve_original_source: "Keep original-source attribution and distinguish source evidence from later summaries and interpretations.",
  preserve_framework_version_and_provenance: "Distinguish framework versions and their authors. Never treat a new compilation as the original framework or historical interpretation.",
  preserve_cross_system_differences: "Preserve differences among conceptual systems; do not merge analogous terms into one asserted equivalence.",
  enforce_medical_topic_and_advice_boundaries: "Use health evidence only for the requested health topic. Do not infer diagnoses, treatment authority or professional certainty from personal observations.",
  preserve_dated_health_observations: "Keep health observations attached to their dates and evidence; a past condition is not an established current condition.",
  enforce_quote_authorization: "Summary permission is not quotation permission. No source passages may be quoted without the separate exact-version Host authorization required by the source policy.",
  preserve_author_intent_and_origin: "Preserve the author's expressed intent and distinguish owner statements, external material and assistant proposals. Do not replace unresolved intent with a preferred conclusion.",
  distinguish_model_from_primary_evidence: "Label model interpretations as inferences. They are not original observations, owner statements or independent corroboration.",
  enforce_current_expression_precedence: "Use current explicit owner expressions to revise current understanding while retaining the dated historical expression as history, not silently rewriting it.",
  enforce_medical_and_third_party_boundaries: "Do not diagnose the owner or third parties from these records; distinguish reported health information from verified clinical findings and respect third-party scope.",
  preserve_dated_relationship_changes: "Distinguish dated stages and changes in relationships. Historical closeness or conflict does not establish the current state.",
  distinguish_analysis_from_original_messages: "Separate analysis and import commentary from original messages; they cannot be attributed to message participants or counted as additional observations.",
  avoid_complete_third_party_personality_model: "Use third-party details only to understand the requested interaction. Do not build a complete personality model or assert hidden motives as facts.",
  preserve_platform_message_roles: "Preserve the platform speaker and message roles; quoted, forwarded, assistant and tool messages are not owner-authored statements.",
  enforce_external_delivery_and_media_constraints: "Source access does not authorize external delivery or reuse of media. Preserve each media item's origin and declared use boundaries.",
  retain_visual_evidence_origins: "Preserve the origin of visual evidence; a textual description is an interpretation of that image, not an additional independent observation.",
  preserve_original_message_roles: "Retain the original speaker and distinguish messages from quotes, assistant analysis and importer notes.",
  preserve_quote_context: "Keep quotations attached to their speaker, time and context. Do not attribute another person's words to the owner or broaden their meaning.",
  preserve_reported_and_unagreed_plan_status: "Keep reported intentions and unagreed plans provisional. A reported proposal is not agreement, completed action or an observed outcome.",
  enforce_family_decision_and_professional_advice_boundaries: "Support the requested family decision without deciding on behalf of participants or presenting legal, financial or medical interpretations as professional determinations.",
  enforce_family_decision_and_third_party_boundaries: "Keep family information within the requested decision and respect third-party privacy and agency; do not infer consent or authority to act for others.",
  preserve_historical_scope: "Keep observations and interpretations in their recorded historical scope. Do not infer that past states, preferences or relationships remain current.",
  enforce_never_quote: "Never quote original passages from this source. Summary use must independently satisfy all other restrictions.",
  preserve_dated_financial_and_life_context: "Attach financial and life circumstances to their recorded date and context; do not present historical values or conditions as current.",
  avoid_inference_from_missing_records: "Missing records are a coverage limitation, not evidence that an event, feeling or behavior did not occur.",
  distinguish_analysis_from_original_diary: "Separate original diary expressions from subsequent analysis and import notes. Later interpretation is not the diarist's original statement.",
  preserve_narrative_vs_causal_fact_distinction: "Distinguish narrative meaning, analogy and personal interpretation from verified causal facts; do not promote one into the other.",
  preserve_decision_and_trigger_provenance: "Keep decisions connected to their actual triggers and evidence. Advice, intention, authorization and executed action remain separate facts.",
  preserve_historical_summary_provenance: "Treat historical summaries as pointers to their originals, not independent corroboration or current state without new evidence.",
  protect_third_party_details: "Use only third-party details necessary for the requested topic; do not expand disclosure, infer consent or create unrelated profiles.",
  distinguish_analysis_from_primary_evidence: "Distinguish model or human analysis from primary observations and preserve independent evidence identity.",
  enforce_quote_authorization_beyond_metadata: "The source's additional quotation limits still apply even if its metadata appears permissive. Summary access alone cannot authorize any original quotation.",
  preserve_resume_source_precedence: "Preserve provenance and dates of resume information; do not let secondary summaries override the owner's authoritative version or invent current employment facts.",
  retain_original_links_and_historical_context: "Retain original references and their historical context. A link or later summary alone cannot establish the original material's claims.",
  preserve_as_of_time_not_permanent_current_state: "Express dated snapshots as of their evidence time rather than permanent or automatically current states.",
  preserve_author_and_source_attribution: "Preserve author and original-source attribution; distinguish the owner's writing from collected or quoted work.",
  preserve_creative_expression_context: "Interpret creative expression in its genre and context. Do not treat metaphors, fictional voices or rhetorical statements as literal biographical facts.",
};
const access: Record<string, string> = {
  enforce_source_specific_topic_request: "The owner must have requested this source's particular subject, not merely a broadly related topic. Otherwise deny use.",
  enforce_source_specific_named_topic: "The owner must explicitly name this source's particular subject in the request. Related vocabulary or general curiosity is insufficient.",
  enforce_private_delivery_only: "Use is restricted to the owner's private direct conversation. Public, group and third-party delivery are forbidden.",
  enforce_work_only_scenarios: "The intended use must be technical writing, technical collaboration or a work decision. Do not repurpose work information for unrelated personal judgments.",
};
const capabilityRequirements: Record<string, string> = {
  exclude_placeholder_from_framework_execution: "framework_placeholder_exclusion",
  segment_mixed_sensitivity_evidence: "mixed_sensitivity_segmentation",
  remove_proactive_relationship_followup_from_projection: "relationship_projection_migration",
  verify_missing_audio_original_or_explicit_retention_exclusion: "original_media_retention_verification",
  segment_nonquotable_company_details: "company_evidence_segmentation",
};

export function compileReviewedSourceConstraints(codes: string[]) {
  if (!Array.isArray(codes) || new Set(codes).size !== codes.length || codes.some(code => typeof code !== "string")) {
    throw new CatalogError("invalid_review_constraint_ids");
  }
  const rules: SourceUsageRules = { access: [], interpretation: [] };
  const requiredCapabilities: string[] = [];
  for (const id of codes) {
    if (Object.hasOwn(access, id)) rules.access.push({ id, requirement: access[id]! });
    else if (Object.hasOwn(interpretation, id)) rules.interpretation.push({ id, requirement: interpretation[id]! });
    else if (Object.hasOwn(capabilityRequirements, id)) requiredCapabilities.push(capabilityRequirements[id]!);
    else throw new CatalogError("unsupported_review_constraint");
  }
  return { usageRules: parseSourceUsageRules(rules), requiredCapabilities,
    implementationReady: requiredCapabilities.length === 0 };
}
