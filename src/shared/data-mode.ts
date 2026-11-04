/** Storage modes shared by data loaders and writers; independent of a runtime. */
export const STELLA_DATA_MODES = [
  "read_only",
  "local_write",
  "managed_durable_write",
] as const;
export type StellaDataMode = (typeof STELLA_DATA_MODES)[number];
