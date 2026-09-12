/**
 * Stage 2b: TLS policy (FR-5). verify=true by default; SSL-Verify:false is
 * honored only when server config permits it for that host.
 */
import { ErrorCodes, GatewayError } from "../errors.js";

export interface TlsPolicyConfig {
  allowDisableVerify: boolean;
  disableVerifyHosts: readonly string[];
}

export function resolveTlsVerify(
  baseUrl: string,
  requestedVerify: boolean,
  config: TlsPolicyConfig,
): boolean {
  if (requestedVerify) return true;
  if (!config.allowDisableVerify) {
    throw new GatewayError(
      ErrorCodes.POLICY_TLS_VERIFY_FORBIDDEN,
      "server policy does not permit disabling TLS verification",
    );
  }
  const hostname = new URL(baseUrl).hostname.toLowerCase();
  if (!config.disableVerifyHosts.some((h) => h.toLowerCase() === hostname)) {
    throw new GatewayError(
      ErrorCodes.POLICY_TLS_VERIFY_FORBIDDEN,
      `TLS verification cannot be disabled for host '${hostname}'`,
    );
  }
  return false;
}
