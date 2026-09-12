/**
 * Security gateway pipeline (FR-3): parse headers → host allowlist →
 * TLS policy → identity resolution → GitLabRequestContext.
 */
import { parseGitLabHeaders, buildRequestContext } from "../context/headers.js";
import { getRequestScope } from "../context/request-scope.js";
import { resolveTlsVerify } from "../security/tls-policy.js";
import type { GitLabRequestContext } from "../context/request-context.js";

/**
 * Runs the gateway stages in order, fail fast. Throws GatewayError with a
 * typed code; callers convert to isError tool results.
 */
export async function resolveRequestContext(): Promise<GitLabRequestContext> {
  const scope = getRequestScope();

  // Stage 1: parse headers.
  const parsed = parseGitLabHeaders(scope.headers);

  // Stage 2a: host allowlist (SSRF guard).
  scope.allowlist.check(parsed.baseUrl);

  // Stage 2b: TLS policy.
  const verify = resolveTlsVerify(parsed.baseUrl, parsed.sslVerify, {
    allowDisableVerify: scope.config.allowDisableVerify,
    disableVerifyHosts: scope.config.disableVerifyHosts,
  });
  parsed.sslVerify = verify;

  // Stage 3: identity resolution (cached by token hash).
  const identity = await scope.identityResolver.resolve(
    parsed.baseUrl,
    parsed.token,
  );

  return buildRequestContext(parsed, identity);
}
