import { CatalogError, validMemoryRef } from "../canghai/catalog-reader.js";
import { bytesVersion, canonicalJson } from "../canghai/content-version.js";
import type { VersionedRef } from "../praxis/episode-v2.js";
import { isRecord } from "../shared/type-guards.js";
import type { HostMemoryInput } from "./host-memory-provider.js";

export type ContextNodeSources = {
  dependencies: Array<{ ref: VersionedRef; digest: string }>;
  originals: Array<{ ref: VersionedRef; digest: string }>;
  payloads: Array<{ source: VersionedRef; sha256: string }>;
  configurationInputs: Array<{ path: string; sha256: string }>;
  archives: Array<{ archiveRoot: string; digest: string; signerId: string }>;
};
const producers = ["public_rule", "current_input", "evidence", "derived", "summary", "conversation", "system", "message", "assistant", "tool_result", "host_format"] as const;
type Producer = (typeof producers)[number];
export type ContextHistoryNode = {
  id: string; producer: Producer; version: "stella.context-node/v1"; content: string;
  parents: string[]; sources: ContextNodeSources; basisDigest?: string;
};
export type ContextTrace = { nodes: ContextHistoryNode[]; roots: string[] };
export type ContextInputTrace = { nodes: ContextHistoryNode[]; system: string; messages: string[] };
const invalid = "host_context_graph_invalid";
function check(value: unknown): asserts value { if (!value) throw new CatalogError(invalid); }
const hash = (value: unknown): value is string => typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
const unique = <T>(rows: readonly T[]): T[] => [...new Map(rows.map(row => [canonicalJson(row), row])).entries()]
  .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, value]) => structuredClone(value));
export function mergeContextSources(values: readonly ContextNodeSources[]): ContextNodeSources {
  return { dependencies: unique(values.flatMap(value => value.dependencies)), originals: unique(values.flatMap(value => value.originals)),
    payloads: unique(values.flatMap(value => value.payloads)), configurationInputs: unique(values.flatMap(value => value.configurationInputs)),
    archives: unique(values.flatMap(value => value.archives)) };
}
function nodesOf(traces: readonly Pick<ContextTrace, "nodes">[]): ContextHistoryNode[] {
  const nodes = new Map<string, ContextHistoryNode>();
  for (const trace of traces) for (const node of trace.nodes) {
    const existing = nodes.get(node.id);
    check(!existing || canonicalJson(existing) === canonicalJson(node));
    if (!existing) nodes.set(node.id, structuredClone(node));
  }
  check(nodes.size <= 4096);
  return [...nodes.values()];
}
export function combineContextTraces(traces: readonly ContextTrace[]): ContextTrace {
  return { nodes: nodesOf(traces), roots: traces.flatMap(trace => trace.roots) };
}
function append(trace: ContextTrace, producer: Producer, content: string, ownSources?: ContextNodeSources, basisDigest?: string): ContextTrace {
  const parents = trace.roots;
  const byId = new Map(trace.nodes.map(node => [node.id, node]));
  const inherited = parents.map(id => { const node = byId.get(id); check(node); return node.sources; });
  const sources = mergeContextSources([...inherited, ...(ownSources ? [ownSources] : [])]);
  const body = { producer, version: "stella.context-node/v1" as const, content, parents: [...parents], sources,
    ...(basisDigest ? { basisDigest } : {}) };
  const node = { id: bytesVersion(canonicalJson(body)), ...body };
  return { nodes: nodesOf([trace, { nodes: [node] }]), roots: [node.id] };
}

/** Called only by the authority after validating the actual producer receipt.
 * Models cannot choose edges or remove a parent's source dependency. */
export function contextFragmentTrace(producer: Producer, content: string, sources: ContextNodeSources, parents: readonly ContextTrace[] = []): ContextTrace {
  const trace = append(combineContextTraces(parents), producer, content, sources);
  // A producer must carry its complete inherited source closure in the live
  // fragment too, so current validation and durable graph validation agree.
  check(canonicalJson(mergeContextSources([sources])) === canonicalJson(trace.nodes.find(node => node.id === trace.roots[0])!.sources));
  return trace;
}
export function visibleContextMessage(message: { timestamp?: unknown }) {
  const { timestamp: _timestamp, ...visible } = message;
  return visible;
}
/** The Host provider treats a user string and its single text block as the
 * same input. This is the only normalization used for consumption digests;
 * graph node content continues to bind the actual wire representation. */
export function consumptionContextMessage(message: { timestamp?: unknown; role?: unknown; content?: unknown }) {
  const { timestamp: _timestamp, ...visible } = message;
  return visible.role === "user" && typeof visible.content === "string"
    ? { ...visible, content: [{ type: "text", text: visible.content }] } : visible;
}
export function contextInputDigest(input: HostMemoryInput): string {
  return bytesVersion(canonicalJson({ systemPrompt: input.systemPrompt, tools: input.tools, messages: input.messages.map(consumptionContextMessage) }));
}
export function assembleContextTrace(input: HostMemoryInput, system: readonly ContextTrace[], messages: readonly ContextTrace[]): ContextInputTrace {
  check(input.messages.length === messages.length);
  const systemTrace = append(combineContextTraces(system), "system", canonicalJson({ systemPrompt: input.systemPrompt, tools: input.tools }));
  const messageTraces = messages.map((trace, index) => append(trace, "message", canonicalJson(visibleContextMessage(input.messages[index]!))));
  return { nodes: nodesOf([systemTrace, ...messageTraces]), system: systemTrace.roots[0]!, messages: messageTraces.map(trace => trace.roots[0]!) };
}
export function contextInputRoots(trace: ContextInputTrace): ContextTrace {
  return { nodes: structuredClone(trace.nodes), roots: [trace.system, ...trace.messages] };
}
/** Preserve every eligible semantic input. Influence edges do not prove that
 * an assistant reply or summary retained its parents' meaning, so ancestors
 * remain model inputs too. Formatting wrappers add no independent content. */
export function eligibleContextInputs(trace: ContextInputTrace, eligible: ReadonlySet<string>): ContextTrace {
  const semantic = trace.nodes.filter(node => eligible.has(node.id) &&
    ["current_input", "evidence", "derived", "summary", "conversation", "assistant", "tool_result"].includes(node.producer));
  const byId = new Map(trace.nodes.map(node => [node.id, node]));
  const ancestors = (roots: readonly string[]) => {
    const found = new Set<string>(), pending = [...roots];
    while (pending.length) {
      const id = pending.pop()!;
      if (found.has(id)) continue;
      const node = byId.get(id);
      check(node && eligible.has(id));
      found.add(id);
      pending.push(...node.parents);
    }
    return found;
  };
  const roots = semantic.map(node => node.id);
  const retained = ancestors(roots);
  return { nodes: structuredClone(trace.nodes.filter(node => retained.has(node.id))), roots };
}

export function appendAssistantTrace(trace: ContextInputTrace, input: HostMemoryInput, message: HostMemoryInput["messages"][number]): ContextInputTrace {
  const output = append(contextInputRoots(trace), "assistant", canonicalJson(visibleContextMessage(message)), undefined, contextInputDigest(input));
  return { nodes: output.nodes, system: trace.system, messages: [...trace.messages, output.roots[0]!] };
}
export function appendToolTrace(trace: ContextInputTrace, before: HostMemoryInput, after: HostMemoryInput,
  message: HostMemoryInput["messages"][number], evidence: readonly ContextTrace[]): ContextInputTrace {
  let assistantIndex = before.messages.length - 1;
  while (assistantIndex >= 0 && before.messages[assistantIndex]!.role !== "assistant") assistantIndex--;
  check(assistantIndex >= 0 && message.role === "toolResult");
  const parent = { nodes: trace.nodes, roots: [trace.messages[assistantIndex]!] };
  const output = append(combineContextTraces([parent, ...evidence]), "tool_result", canonicalJson(visibleContextMessage(message)));
  // The Host orders parallel tool results by call order, not completion order.
  const messages = after.messages.map((value, index) => {
    if (index <= assistantIndex) return trace.messages[index]!;
    if (value.role === "toolResult" && value.toolCallId === message.toolCallId) return output.roots[0]!;
    const previous = before.messages.findIndex((candidate, previousIndex) => previousIndex > assistantIndex &&
      candidate.role === "toolResult" && value.role === "toolResult" && candidate.toolCallId === value.toolCallId);
    check(previous > assistantIndex);
    return trace.messages[previous]!;
  });
  return { nodes: output.nodes, system: trace.system, messages };
}
export function projectContextTrace(trace: ContextInputTrace, input: HostMemoryInput): ContextInputTrace {
  check(trace.messages.length === input.messages.length);
  const projections = input.messages.map((message, index) => append({ nodes: trace.nodes, roots: [trace.messages[index]!] },
    "host_format", canonicalJson(visibleContextMessage(message))));
  return { nodes: nodesOf([trace, ...projections]), system: trace.system, messages: projections.map(value => value.roots[0]!) };
}

export function parseContextSources(value: unknown, canonical = true): ContextNodeSources {
  check(isRecord(value) && Object.keys(value).sort().join() === "archives,configurationInputs,dependencies,originals,payloads");
  for (const field of ["dependencies", "originals"] as const) check(Array.isArray(value[field]) && value[field].length <= 1024 &&
    value[field].every(entry => isRecord(entry) && validMemoryRef(entry.ref) && hash(entry.digest) && Object.keys(entry).sort().join() === "digest,ref"));
  check(Array.isArray(value.payloads) && value.payloads.length <= 1024 && value.payloads.every(entry => isRecord(entry) &&
    validMemoryRef(entry.source) && hash(entry.sha256) && Object.keys(entry).sort().join() === "sha256,source"));
  check(Array.isArray(value.configurationInputs) && value.configurationInputs.length <= 512 && value.configurationInputs.every(entry => isRecord(entry) &&
    typeof entry.path === "string" && entry.path && hash(entry.sha256) && Object.keys(entry).sort().join() === "path,sha256"));
  check(Array.isArray(value.archives) && value.archives.length <= 128 && value.archives.every(entry => isRecord(entry) &&
    typeof entry.archiveRoot === "string" && entry.archiveRoot && hash(entry.digest) && hash(entry.signerId) &&
    Object.keys(entry).sort().join() === "archiveRoot,digest,signerId"));
  // All members were structurally validated above; no producer authority is
  // inferred here. The enclosing archive must separately pass signature checks.
  const sources = value as ContextNodeSources;
  const normalized = mergeContextSources([sources]);
  check(Object.keys(normalized).every(field => normalized[field as keyof ContextNodeSources].length === sources[field as keyof ContextNodeSources].length));
  if (canonical) check(canonicalJson(sources) === canonicalJson(normalized));
  return structuredClone(sources);
}

function readNodes(value: unknown): Map<string, ContextHistoryNode> {
  check(Array.isArray(value) && value.length > 0 && value.length <= 4096);
  const nodes = new Map<string, ContextHistoryNode>();
  for (const candidate of value) {
    check(isRecord(candidate) && hash(candidate.id) && !nodes.has(candidate.id) &&
      candidate.version === "stella.context-node/v1" && producers.some(producer => producer === candidate.producer) &&
      typeof candidate.content === "string" && Buffer.byteLength(candidate.content) <= 2 * 1024 * 1024 &&
      Array.isArray(candidate.parents) && candidate.parents.length <= 1024 && candidate.parents.every(parent => typeof parent === "string" && nodes.has(parent)) &&
      (candidate.basisDigest === undefined || hash(candidate.basisDigest)));
    check(Object.keys(candidate).sort().join() === (candidate.basisDigest === undefined
      ? "content,id,parents,producer,sources,version" : "basisDigest,content,id,parents,producer,sources,version"));
    const { id, ...body } = candidate;
    check(id === bytesVersion(canonicalJson(body)));
    const nodeSources = parseContextSources(candidate.sources);
    const parentSources = candidate.parents.map(parent => nodes.get(String(parent))!.sources);
    check(canonicalJson(nodeSources) === canonicalJson(mergeContextSources([nodeSources, ...parentSources])));
    if (candidate.producer === "assistant") {
      check(candidate.parents.length > 0 && hash(candidate.basisDigest));
      const system = nodes.get(String(candidate.parents[0]))!;
      check(system.producer === "system");
      let systemInput: unknown;
      let messages: unknown;
      try {
        systemInput = JSON.parse(system.content);
        messages = candidate.parents.slice(1).map(parent => JSON.parse(nodes.get(String(parent))!.content));
      } catch { throw new CatalogError(invalid); }
      check(isRecord(systemInput) && Array.isArray(messages) && messages.every(isRecord) &&
        candidate.basisDigest === bytesVersion(canonicalJson({ ...systemInput, messages: messages.map(consumptionContextMessage) })));
    }
    nodes.set(id, { id, producer: candidate.producer as Producer, version: "stella.context-node/v1", content: candidate.content,
      parents: [...candidate.parents] as string[], sources: nodeSources, ...(candidate.basisDigest ? { basisDigest: String(candidate.basisDigest) } : {}) });
  }
  return nodes;
}

/** Structural check only; callers independently verify signatures and current authority. */
export function readContextTrace(value: unknown, sources: ContextNodeSources): ContextTrace {
  check(isRecord(value) && Object.keys(value).sort().join() === "nodes,roots" && Array.isArray(value.roots) &&
    value.roots.length > 0 && value.roots.length <= 1024 && value.roots.every(hash));
  const nodes = readNodes(value.nodes);
  check(value.roots.every(id => nodes.has(String(id))) && new Set(value.roots).size === value.roots.length);
  check(canonicalJson(mergeContextSources([...nodes.values()].map(node => node.sources))) === canonicalJson(mergeContextSources([sources])));
  return { nodes: [...nodes.values()], roots: [...value.roots] as string[] };
}

/** Validates topology, source inheritance and exact coverage independently of
 * whether those sources are still eligible for a current memory view. */
export function readContextInputTrace(value: unknown, input: HostMemoryInput, sources: ContextNodeSources): ContextInputTrace {
  check(isRecord(value) && Object.keys(value).sort().join() === "messages,nodes,system" &&
    Array.isArray(value.nodes) && value.nodes.length > 0 && value.nodes.length <= 4096 && hash(value.system) &&
    Array.isArray(value.messages) && value.messages.length === input.messages.length && value.messages.every(hash));
  const nodes = readNodes(value.nodes);
  const system = nodes.get(value.system);
  check(system?.producer === "system" && system.content === canonicalJson({ systemPrompt: input.systemPrompt, tools: input.tools }));
  for (const [index, id] of value.messages.entries()) {
    const node = nodes.get(String(id));
    check(node && ["message", "assistant", "tool_result", "host_format"].includes(node.producer) &&
      node.content === canonicalJson(visibleContextMessage(input.messages[index]!)));
  }
  check(canonicalJson(mergeContextSources([...nodes.values()].map(node => node.sources))) === canonicalJson(mergeContextSources([sources])));
  return { nodes: [...nodes.values()], system: value.system, messages: [...value.messages] as string[] };
}

/** Parse a signed archive's graph without consulting current sources. This is
 * structural evidence only: it never grants permission to consume node text.
 * Callers must verify the enclosing signature and scope, then independently
 * qualify the graph under the live catalog and processing authority. */
export function readContextArchiveGraph(stored: Record<string, unknown>): ContextInputTrace {
  check(stored.schemaVersion === "stella.host-context-archive/v2" && isRecord(stored.input));
  const input = stored.input;
  check(Object.keys(input).sort().join() === "messages,systemPrompt,tools" && typeof input.systemPrompt === "string" &&
    Array.isArray(input.messages) && input.messages.every(message => isRecord(message) &&
      ["user", "assistant", "toolResult"].includes(String(message.role)) &&
      (typeof message.content === "string" || Array.isArray(message.content))) &&
    Array.isArray(input.tools) && input.tools.every(tool => isRecord(tool) && typeof tool.name === "string" &&
      typeof tool.description === "string" && isRecord(tool.parameters)));
  const sources = parseContextSources({ dependencies: stored.dependencies, originals: stored.originals, payloads: stored.payloads,
    configurationInputs: stored.configurationInputs, archives: stored.archives }, false);
  for (const group of [sources.dependencies, sources.originals]) {
    check(new Set(group.map(entry => canonicalJson(entry.ref))).size === group.length);
  }
  // The signed wire input is only being compared with its exact graph here;
  // it is not converted into a model request or a source credential.
  const wire = input as HostMemoryInput;
  check(stored.consumptionDigest === contextInputDigest(wire));
  return readContextInputTrace(stored.graph, wire, sources);
}
