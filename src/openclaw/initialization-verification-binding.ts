import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { InitializationError, type InitializationVerificationBinding } from "./initialization.js";

/** Legacy strong receipt adapter. Package provenance and present disk bytes cannot
 * attest code that was already loaded. No production load-time attestation is
 * available through the public plugin contract, so this claim remains unavailable.
 * Import/registration performs no identity I/O, and no old strong receipt is reused.
 */
export async function captureInitializationVerificationBinding(_api: OpenClawPluginApi,
  _input: { canghaiRoot: string; manifestPath: string; agentId: string }): Promise<InitializationVerificationBinding> {
  throw new InitializationError("verification_code_identity_unavailable");
}
