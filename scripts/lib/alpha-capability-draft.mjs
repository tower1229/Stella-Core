/** Configuration mappings, never capability-availability or acceptance receipts. */
export function alphaCapabilityDraft({ base, bindingPath, acceptancePath }) {
  const definitions = [
    ["structured_model", "openclaw.runtime.llm.complete", ["provider:google"]],
    ["source_read", "stella.catalog-reader", []],
    ["durable_commit", "stella.git-canghai-durability", []],
    ["required_delivery_receipt", "stella.openclaw-completion", []],
  ];
  const files = definitions.map(([id, entryPoint]) => ({ path: `${base}/capability-${id}.json`, object: {
    schemaVersion: "stella.alpha-capability-binding/v1", capabilityId: id, hostVersion: "2026.8.2",
    entryPoint, praxisBindingRef: `path:${bindingPath}`,
    ...(id === "structured_model" ? { provider: "google", model: "gemini-3.1-pro-preview" } : {}),
  } }));
  const capabilities = [{ id: "transcript_archive", required: true, adapter_id: "openclaw-transcript-2026.8.2", adapter_version: "1",
    config_ref: `path:${bindingPath}`, acceptance_ref: `path:${acceptancePath}`, required_secret_refs: [] },
  ...definitions.map(([id, entryPoint, secrets]) => ({ id, required: true, adapter_id: entryPoint, adapter_version: "1",
    config_ref: `path:${base}/capability-${id}.json`, acceptance_ref: `path:${acceptancePath}`, required_secret_refs: secrets }))];
  return { files, capabilities };
}
