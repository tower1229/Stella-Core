/** Historical input archive data shape. Defining it does not load the old Host
 * recorder or certify a new input's provenance. */
export type HostInputSnapshot = {
  schemaVersion: "stella.host-input-snapshot/v1";
  hostVersion: string; agentId: string; sessionId: string; sessionKey: string;
  entryId: string; logicalTurnId: string; generation: string; rawSeq: number;
  parentId: string | null; text: string; event: Record<string, unknown>;
};
