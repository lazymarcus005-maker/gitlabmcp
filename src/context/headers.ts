/**
 * Header parsing → preliminary request context (FR-2).
 * Stage 1 of the security gateway: parse + basic validation only.
 * Host allowlist, TLS policy and identity resolution happen later.
 */
import { randomUUID } from "node:crypto";
import { ErrorCodes, GatewayError } from "../errors.js";
import type { GitLabIdentity } from "./request-context.js";

export interface ParsedHeaders {
  requestId: string;
  baseUrl: string;
  token: string;
  sslVerify: boolean;
  defaultGroup?: string;
  defaultProject?: string;
  projectScope?: string[];
  requestedScopes?: string[];
}

export type HeaderBag = Record<string, string | string[] | undefined>;

function getHeader(headers: HeaderBag, name: string): string | undefined {
  const raw = headers[name.toLowerCase()];
  if (raw === undefined) return undefined;
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value?.trim() || undefined;
}

function splitCsv(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const parts = value
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  return parts.length > 0 ? parts : undefined;
}

/** Parses request headers; throws VALIDATION_ERROR on malformed input. */
export function parseGitLabHeaders(headers: HeaderBag): ParsedHeaders {
  const baseUrl = getHeader(headers, "x-gitlab-url");
  if (!baseUrl) {
    throw new GatewayError(
      ErrorCodes.VALIDATION_ERROR,
      "missing required header X-GitLab-URL",
    );
  }
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(baseUrl);
  } catch {
    throw new GatewayError(
      ErrorCodes.VALIDATION_ERROR,
      "X-GitLab-URL is not a valid absolute URL",
    );
  }
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    throw new GatewayError(
      ErrorCodes.VALIDATION_ERROR,
      "X-GitLab-URL must use http or https",
    );
  }

  const token = getHeader(headers, "x-gitlab-token");
  if (!token) {
    throw new GatewayError(
      ErrorCodes.VALIDATION_ERROR,
      "missing required header X-GitLab-Token",
    );
  }

  // TLS verify defaults to true (FR-5); exact policy checked in stage 2.
  const sslVerifyHeader = getHeader(headers, "x-gitlab-ssl-verify");
  const sslVerify = sslVerifyHeader
    ? !["false", "0", "no"].includes(sslVerifyHeader.toLowerCase())
    : true;

  return {
    requestId: randomUUID(),
    baseUrl: parsedUrl.origin,
    token,
    sslVerify,
    defaultGroup: getHeader(headers, "x-gitlab-default-group"),
    defaultProject: getHeader(headers, "x-gitlab-default-project"),
    projectScope: splitCsv(getHeader(headers, "x-gitlab-project-scope")),
    requestedScopes: splitCsv(getHeader(headers, "x-gitlab-request-scope")),
  };
}

/** Full context, after identity resolution. */
export function buildRequestContext(
  parsed: ParsedHeaders,
  identity: GitLabIdentity,
): import("./request-context.js").GitLabRequestContext {
  return {
    requestId: parsed.requestId,
    gitlab: {
      baseUrl: parsed.baseUrl,
      token: parsed.token,
      tls: { verify: parsed.sslVerify },
    },
    identity,
    defaults: {
      group: parsed.defaultGroup,
      project: parsed.defaultProject,
    },
    projectScope: parsed.projectScope,
    requestedScopes: parsed.requestedScopes,
  };
}
