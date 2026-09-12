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
  /** Pagination (FR-12): default page size and hard cap for `limit`. */
  paginationDefaultLimit: number;
  paginationMaxLimit: number;
  /** Response size cap in bytes (FR-13); larger payloads truncate from the start. */
  maxBytes: number;
  /** Per-request GitLab timeout in ms (FR-14); 60 s for job.* paths. */
  timeoutMs: number;
  jobTimeoutMs: number;
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

function positiveInt(value: string | undefined, dflt: number): number {
  const parsed = value ? Number(value) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : dflt;
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
    // Pagination (FR-12): limit default 20, hard max 100.
    paginationDefaultLimit: positiveInt(env.GITLAB_MCP_PAGINATION_DEFAULT_LIMIT, 20),
    paginationMaxLimit: positiveInt(env.GITLAB_MCP_PAGINATION_MAX_LIMIT, 100),
    // Response size cap (FR-13): default 100 KB.
    maxBytes: positiveInt(env.GITLAB_MCP_MAX_BYTES, 100 * 1024),
    // Timeouts (FR-14): 30 s default, 60 s for job.* paths.
    timeoutMs: positiveInt(env.GITLAB_MCP_TIMEOUT_MS, 30_000),
    jobTimeoutMs: positiveInt(env.GITLAB_MCP_JOB_TIMEOUT_MS, 60_000),
  };
}
