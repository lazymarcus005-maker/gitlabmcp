/**
 * Server config (NFR-3): env vars are the primary source of truth.
 * An optional YAML file (config/server.yaml, or the path in
 * GITLAB_MCP_CONFIG_YAML) may supply nested/base values; every env var
 * always wins over the YAML value. On startup, main() logs the effective
 * config as one JSON line with host lists intact (non-secret) and no
 * credentials of any kind.
 */
import { readFileSync, existsSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { redact } from "./security/redaction.js";

export interface ServerConfig {
  port: number;
  httpPath: string;
  /** Hosts a request may target via X-GitLab-URL (SSRF guard). */
  allowedHosts: string[];
  /** Whether custom X-GitLab-URL hosts outside allowedHosts may be used. */
  allowCustomHosts: boolean;
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
  /** Policy engine (§5, ADR-0002): read-only kill switch (NFR-3). */
  readOnly: boolean;
  /** Risk classes allowed by server policy; DESTRUCTIVE defaults to deny. */
  allowedRiskClasses: string[];
  /** Branch guardrails (FR-10): protected branches deny create and delete. */
  protectedBranches: string[];
  /** Branches that additionally deny direct delete. */
  denyDirectDeleteBranches: string[];
  /** Audit destination (NFR-2): only "stdout" is supported in V1. */
  auditDestination: string;
  /** Audit redaction switch; disabling is not recommended. */
  auditRedactSecrets: boolean;
}

const DEFAULT_YAML_PATH = "config/server.yaml";

/**
 * Minimal YAML overlay: reads config/server.yaml (or GITLAB_MCP_CONFIG_YAML)
 * if present and maps documented keys to the config fields. Env vars are
 * applied afterwards and always win.
 */
function loadYamlOverlay(env: NodeJS.ProcessEnv): Record<string, unknown> {
  const yamlPath = env.GITLAB_MCP_CONFIG_YAML ?? DEFAULT_YAML_PATH;
  if (!existsSync(yamlPath)) return {};
  try {
    const doc = parseYaml(readFileSync(yamlPath, "utf8")) as Record<string, any> | null;
    if (!doc || typeof doc !== "object") return {};
    const pick = (...keys: string[]): unknown => {
      let cur: unknown = doc;
      for (const k of keys) {
        if (cur === null || typeof cur !== "object") return undefined;
        cur = (cur as Record<string, unknown>)[k];
      }
      return cur;
    };
    const strList = (v: unknown): string[] | undefined =>
      Array.isArray(v) ? v.map(String).map((s) => s.toLowerCase()) : undefined;
    const bool = (v: unknown): boolean | undefined =>
      typeof v === "boolean" ? v : undefined;
    const int = (v: unknown): number | undefined =>
      typeof v === "number" && Number.isFinite(v) ? Math.floor(v) : undefined;

    const overlay: Record<string, unknown> = {};
    const port = int(pick("server", "port"));
    if (port !== undefined) overlay.port = port;
    const httpPath = pick("server", "http_path");
    if (typeof httpPath === "string") overlay.httpPath = httpPath;
    const allowed = strList(pick("gitlab", "allowed_hosts"));
    if (allowed) overlay.allowedHosts = allowed;
    const custom = bool(pick("gitlab", "allow_custom_hosts"));
    if (custom !== undefined) overlay.allowCustomHosts = custom;
    const adv = bool(pick("security", "tls", "allow_disable_verify"));
    if (adv !== undefined) overlay.allowDisableVerify = adv;
    const dvh = strList(pick("security", "tls", "disable_verify_hosts"));
    if (dvh) overlay.disableVerifyHosts = dvh;
    const dest = pick("security", "audit", "destination");
    if (typeof dest === "string") overlay.auditDestination = dest;
    const redact = bool(pick("security", "audit", "redact_secrets"));
    if (redact !== undefined) overlay.auditRedactSecrets = redact;
    const readOnly = bool(pick("policy", "read_only"));
    if (readOnly !== undefined) overlay.readOnly = readOnly;
    const risks = strList(pick("policy", "operations"));
    if (risks) {
      // read/write/privileged/destructive: true → allowed risk classes.
      const ops = pick("policy", "operations") as Record<string, unknown>;
      const classes = ["READ", "WRITE", "PRIVILEGED", "DESTRUCTIVE"].filter(
        (c) => ops[c.toLowerCase()] === "allow",
      );
      if (classes.length > 0) overlay.allowedRiskClasses = classes;
    }
    const prot = strList(pick("policy", "branches", "protected"));
    if (prot) overlay.protectedBranches = prot;
    const ddd = strList(pick("policy", "branches", "deny_direct_delete"));
    if (ddd) overlay.denyDirectDeleteBranches = ddd;
    const dfltLimit = int(pick("limits", "pagination", "default_limit"));
    if (dfltLimit !== undefined) overlay.paginationDefaultLimit = dfltLimit;
    const maxLimit = int(pick("limits", "pagination", "max_limit"));
    if (maxLimit !== undefined) overlay.paginationMaxLimit = maxLimit;
    const maxBytes = int(pick("limits", "response", "max_bytes"));
    if (maxBytes !== undefined) overlay.maxBytes = maxBytes;
    const timeout = int(pick("limits", "timeouts", "default_seconds"));
    if (timeout !== undefined) overlay.timeoutMs = timeout * 1000;
    const jobTimeout = int(pick("limits", "timeouts", "job_seconds"));
    if (jobTimeout !== undefined) overlay.jobTimeoutMs = jobTimeout * 1000;
    const ttl = int(pick("identity_cache", "ttl_hours"));
    if (ttl !== undefined) overlay.identityCacheTtlMs = ttl * 60 * 60 * 1000;
    return overlay;
  } catch (err) {
    throw new Error(
      `failed to load config YAML at ${yamlPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function parseHostList(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  return value
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter((h) => h.length > 0);
}

function parseBool(value: string | undefined): boolean | undefined {
  if (value === undefined || value === "") return undefined;
  return ["1", "true", "yes"].includes(value.toLowerCase());
}

function positiveInt(value: string | undefined): number | undefined {
  const parsed = value ? Number(value) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined;
}

const RISK_CLASSES = ["READ", "WRITE", "PRIVILEGED", "DESTRUCTIVE"];

/** Comma-separated list of branch names, normalized to lowercase. */
function parseBranchList(value: string | undefined): string[] | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  return value
    .split(",")
    .map((p) => p.trim().toLowerCase())
    .filter((p) => p.length > 0);
}

/** Comma-separated uppercase list, validated against the risk vocabulary. */
function parseRiskList(value: string | undefined): string[] | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const parts = value
    .split(",")
    .map((p) => p.trim().toUpperCase())
    .filter((p) => p.length > 0);
  const invalid = parts.filter((p) => !RISK_CLASSES.includes(p));
  if (invalid.length > 0) {
    throw new Error(
      `invalid risk class(es): ${invalid.join(", ")} (expected subset of ${RISK_CLASSES.join(", ")})`,
    );
  }
  return parts;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const yaml = loadYamlOverlay(env);
  const fromEnv = {
    port: positiveInt(env.GITLAB_MCP_PORT),
    httpPath: env.GITLAB_MCP_HTTP_PATH,
    allowedHosts: parseHostList(env.GITLAB_MCP_ALLOWED_HOSTS),
    allowCustomHosts: parseBool(env.GITLAB_MCP_ALLOW_CUSTOM_HOSTS),
    disableVerifyHosts: parseHostList(env.GITLAB_MCP_DISABLE_VERIFY_HOSTS),
    allowDisableVerify: parseBool(env.GITLAB_MCP_ALLOW_DISABLE_VERIFY),
    identityCacheTtlMs: positiveInt(env.GITLAB_MCP_IDENTITY_CACHE_TTL_MS),
    paginationDefaultLimit: positiveInt(env.GITLAB_MCP_PAGINATION_DEFAULT_LIMIT),
    paginationMaxLimit: positiveInt(env.GITLAB_MCP_PAGINATION_MAX_LIMIT),
    maxBytes: positiveInt(env.GITLAB_MCP_MAX_BYTES),
    timeoutMs: positiveInt(env.GITLAB_MCP_TIMEOUT_MS),
    jobTimeoutMs: positiveInt(env.GITLAB_MCP_JOB_TIMEOUT_MS),
    readOnly: parseBool(env.GITLAB_MCP_READ_ONLY),
    allowedRiskClasses: parseRiskList(env.GITLAB_MCP_RISK_ALLOW),
    protectedBranches: parseBranchList(env.GITLAB_MCP_PROTECTED_BRANCHES),
    denyDirectDeleteBranches: parseBranchList(env.GITLAB_MCP_DENY_DIRECT_DELETE),
    auditDestination: env.GITLAB_MCP_AUDIT_DESTINATION,
    auditRedactSecrets: parseBool(env.GITLAB_MCP_AUDIT_REDACT_SECRETS),
  };

  // Defaults ← YAML overlay ← env (env wins, NFR-3).
  const merged: Record<string, unknown> = {
    port: 8080,
    httpPath: "/mcp",
    allowedHosts: [],
    allowCustomHosts: false,
    disableVerifyHosts: [],
    allowDisableVerify: true,
    identityCacheTtlMs: 10 * 60 * 60 * 1000, // 10 hours per FR-2
    paginationDefaultLimit: 20, // FR-12
    paginationMaxLimit: 100,
    maxBytes: 100 * 1024, // FR-13: 100 KB
    timeoutMs: 30_000, // FR-14
    jobTimeoutMs: 60_000,
    readOnly: false,
    allowedRiskClasses: ["READ", "WRITE", "PRIVILEGED"],
    protectedBranches: ["main", "master", "uat", "production"],
    denyDirectDeleteBranches: [],
    auditDestination: "stdout",
    auditRedactSecrets: true,
    ...yaml,
  };
  for (const [k, v] of Object.entries(fromEnv)) {
    if (v !== undefined) merged[k] = v;
  }
  return merged as unknown as ServerConfig;
}

/**
 * Effective config as one JSON line. No secrets are ever part of
 * ServerConfig (tokens arrive per-request via headers), so logging the
 * object is safe; this function exists as an explicit, documented redaction
 * boundary for the startup log.
 */
export function describeConfig(config: ServerConfig): string {
  // Redaction pass (NFR-1): config carries no credentials by design, but the
  // startup log goes through the redaction layer anyway so that anything
  // secret-shaped (e.g. a token pasted into an env var) never reaches stdout.
  return redact(JSON.stringify({ msg: "effective config", config })) as string;
}
