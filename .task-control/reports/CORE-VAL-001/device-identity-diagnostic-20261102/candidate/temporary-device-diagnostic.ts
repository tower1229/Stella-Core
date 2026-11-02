import { createHash } from "node:crypto";
import type { getPluginRuntimeGatewayRequestScope } from "openclaw/plugin-sdk/plugin-runtime";

type ScopeReader = typeof getPluginRuntimeGatewayRequestScope;
export type DeviceIdentityDiagnostic = {
  authenticatedControlUi: boolean; authenticatedOperator: boolean;
  currentAuthority: boolean; deviceFactPresent: boolean; matchesOriginalGrant: boolean;
};
const empty = (): DeviceIdentityDiagnostic => ({ authenticatedControlUi: false, authenticatedOperator: false,
  currentAuthority: false, deviceFactPresent: false, matchesOriginalGrant: false });
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 4096;

/** Temporary status-only observation. No permission, source read, token/key read,
 * identity mapping or model call. The fixed expected digest is supplied at package
 * preparation, never by tool arguments. Remove the module with the debug artifact. */
export function createTemporaryDeviceDiagnostic(expectedRequesterSha256: string, read: ScopeReader) {
  if (!/^[a-f0-9]{64}$/.test(expectedRequesterSha256)) throw new Error("device_diagnostic_seed_missing");
  return (senderIsOwner: boolean | undefined, invocationSignal?: AbortSignal): DeviceIdentityDiagnostic => {
    const result = empty();
    // Do not inspect the public connection for ineligible status callers.
    if (senderIsOwner !== true || invocationSignal?.aborted) return result;
    try {
      const scope = read(), client = scope?.client, flags = client?.internal;
      const profileId = client?.authenticatedUserProfile?.profileId, connectionId = client?.connId;
      const live = scope?.hasCurrentClientAuthority;
      if (!scope || !client || !flags || flags.syntheticClient || flags.agentToolCaller ||
          flags.agentRuntimeIdentity || flags.pluginSubagentRequester || !text(profileId) || !text(connectionId)) return result;
      result.authenticatedControlUi = flags.authenticatedControlUi === true;
      result.authenticatedOperator = flags.authenticatedOperator === true;
      if (!result.authenticatedControlUi || !result.authenticatedOperator) return result;
      const current = () => typeof live === "function" && live.call(scope) === true && !scope.signal?.aborted &&
        !client.connectionSignal?.aborted && !client.invalidated && !invocationSignal?.aborted;
      if (!current()) return result;
      // Capture only this scalar once; never access the token-generation key.
      const attested = flags.operatorDeviceTokenIdentity, deviceId = attested?.deviceId;
      const valid = typeof deviceId === "string" && /^[a-f0-9]{64}$/.test(deviceId);
      const matches = valid && createHash("sha256").update(`openclaw-device:${deviceId}`).digest("hex") === expectedRequesterSha256;
      if (!current()) return result;
      result.currentAuthority = true;
      result.deviceFactPresent = valid;
      result.matchesOriginalGrant = matches;
      return result;
    } catch { return empty(); }
  };
}
