/**
 * Server config (NFR-3): env vars are the primary source of truth,
 * with defaults matching config/server.yaml.
 */
export interface ServerConfig {
  port: number;
  httpPath: string;
  /** Hosts a request may target via X-GitLab-URL (SSRF guard). */
  allowedHosts: string[];
  /** Hosts for which X-GitLab-SSL-Verify: false is honored. */
  disableVerifyHosts: string[];
  allowDisableVerify: boolean;
  identityCacheTtlMs: number;
}

function parseHostList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter((h) => h.length > 0);
}

function parseBool(value: string | undefined, dflt: boolean): boolean {
  if (value === undefined || value === "") return dflt;
  return ["1", "true", "yes"].includes(value.toLowerCase());
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  return {
    port: env.GITLAB_MCP_PORT ? Number(env.GITLAB_MCP_PORT) : 8080,
    httpPath: env.GITLAB_MCP_HTTP_PATH ?? "/mcp",
    allowedHosts: parseHostList(env.GITLAB_MCP_ALLOWED_HOSTS),
    disableVerifyHosts: parseHostList(env.GITLAB_MCP_DISABLE_VERIFY_HOSTS),
    allowDisableVerify: parseBool(env.GITLAB_MCP_ALLOW_DISABLE_VERIFY, true),
    // 10 hours per FR-2; overridable for tests.
    identityCacheTtlMs: env.GITLAB_MCP_IDENTITY_CACHE_TTL_MS
      ? Number(env.GITLAB_MCP_IDENTITY_CACHE_TTL_MS)
      : 10 * 60 * 60 * 1000,
  };
}
