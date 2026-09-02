import type { ConsciousnessBootstrapDocument, LoadedConsciousness } from "./manifest.js";

export const DEFAULT_MAX_BOOTSTRAP_DOCUMENT_CHARS = 12_000;
export const DEFAULT_MAX_BOOTSTRAP_CONTEXT_CHARS = 32_000;

export type ConsciousnessContextOptions = {
  maxDocumentChars?: number;
  maxContextChars?: number;
};

function escapeAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function protectClosingTag(content: string): string {
  return content.replaceAll("</stella_core_document>", "&lt;/stella_core_document&gt;");
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function renderDocument(
  document: ConsciousnessBootstrapDocument,
  maxDocumentChars: number,
  remainingChars: number,
): string | undefined {
  const open = `<stella_core_document category="${escapeAttribute(document.category)}" field="${escapeAttribute(document.field)}" ref="${escapeAttribute(document.ref)}">\n`;
  const close = "\n</stella_core_document>";
  const truncationMarker = "\n[truncated by Stella Core]";
  const structuralChars = open.length + close.length;
  if (remainingChars <= structuralChars) return undefined;

  const allowedContentChars = Math.min(
    maxDocumentChars,
    remainingChars - structuralChars,
  );
  const protectedContent = protectClosingTag(document.content);
  const needsTruncation = protectedContent.length > allowedContentChars;
  if (needsTruncation && allowedContentChars <= truncationMarker.length) {
    return undefined;
  }
  const contentBudget = needsTruncation
    ? Math.max(0, allowedContentChars - truncationMarker.length)
    : allowedContentChars;
  const content = protectedContent.slice(0, contentBudget);

  return `${open}${content}${needsTruncation ? truncationMarker : ""}${close}`;
}

export function renderConsciousnessContext(
  loaded: LoadedConsciousness,
  options: ConsciousnessContextOptions = {},
): string {
  const maxDocumentChars = positiveInteger(
    options.maxDocumentChars ?? DEFAULT_MAX_BOOTSTRAP_DOCUMENT_CHARS,
    "maxDocumentChars",
  );
  const maxContextChars = positiveInteger(
    options.maxContextChars ?? DEFAULT_MAX_BOOTSTRAP_CONTEXT_CHARS,
    "maxContextChars",
  );
  const header = [
    '<stella_core_consciousness mode="read_only" authority="canghai">',
    `instance_id: ${loaded.manifest.instance.id}`,
    `manifest_schema: ${loaded.manifest.schemaVersion}`,
    `validated_refs: ${loaded.requiredReferences.length}`,
    `loaded_documents: ${loaded.bootstrapDocuments.length}`,
    ...(loaded.recoveryRevision ? [`recovery_revision: ${loaded.recoveryRevision}`] : []),
    "phase: read-only-consciousness-bootstrap",
  ].join("\n");
  const close = "\n</stella_core_consciousness>";

  if (header.length + close.length > maxContextChars) {
    throw new Error("maxContextChars is too small for Stella consciousness metadata");
  }

  const blocks: string[] = [];
  let usedChars = header.length + close.length;
  for (const document of loaded.bootstrapDocuments) {
    const separatorChars = 1;
    const block = renderDocument(
      document,
      maxDocumentChars,
      maxContextChars - usedChars - separatorChars,
    );
    if (!block) break;
    blocks.push(block);
    usedChars += separatorChars + block.length;
  }

  return `${header}${blocks.length ? `\n${blocks.join("\n")}` : ""}${close}`;
}
