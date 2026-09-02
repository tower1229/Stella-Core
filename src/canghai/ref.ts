import path from "node:path";

export type CangHaiPathRef = {
  kind: "path";
  raw: string;
  relativePath: string;
  fragment?: string;
};

export function parseCangHaiRef(raw: string): CangHaiPathRef {
  if (!raw.startsWith("path:")) {
    throw new Error(`Unsupported CangHai reference: ${raw}`);
  }

  const body = raw.slice("path:".length);
  const hashIndex = body.indexOf("#");
  const rawPath = hashIndex >= 0 ? body.slice(0, hashIndex) : body;
  const fragment = hashIndex >= 0 ? body.slice(hashIndex + 1) : undefined;

  if (!rawPath || path.isAbsolute(rawPath)) {
    throw new Error(`CangHai path ref must be repository-relative: ${raw}`);
  }

  const normalized = path.posix.normalize(rawPath.replaceAll("\\", "/"));
  if (
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.includes("/../")
  ) {
    throw new Error(`CangHai path ref escapes repository root: ${raw}`);
  }

  return {
    kind: "path",
    raw,
    relativePath: normalized,
    ...(fragment ? { fragment } : {}),
  };
}

export function resolveCangHaiRef(canghaiRoot: string, raw: string): CangHaiPathRef & { absolutePath: string } {
  const ref = parseCangHaiRef(raw);
  const root = path.resolve(canghaiRoot);
  const absolutePath = path.resolve(root, ref.relativePath);
  const relative = path.relative(root, absolutePath);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Resolved CangHai ref escapes repository root: ${raw}`);
  }

  return { ...ref, absolutePath };
}
