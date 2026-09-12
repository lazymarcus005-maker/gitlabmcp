/**
 * GitLab client factory (architecture §6): builds a per-request fetch-based
 * client from the context. Never shared across requests; never global.
 * Maps HTTP/transport failures to the error taxonomy (FR-14/FR-15,
 * tool-spec §Error codes) with no automatic retry.
 */
import { Agent } from "undici";
import { ErrorCodes, GatewayError } from "../errors.js";
import type { GitLabRequestContext } from "../context/request-context.js";
import type { FetchLike } from "../security/identity.js";

export interface GitLabClientOptions {
  /** Default per-call timeout in ms (FR-14: 30 s; 60 s for job.* paths). */
  timeoutMs?: number;
}

export interface CallOptions {
  /** Per-call timeout override (e.g. config.jobTimeoutMs for job paths). */
  timeoutMs?: number;
  /** HTTP method override (default GET). */
  method?: string;
  /** Serialized request body; implies Content-Type: application/json. */
  body?: string;
}

export interface GitLabResponse<T> {
  data: T;
  headers: Headers;
}

export interface GitLabClient {
  /** Performs an authenticated GET against GitLab API v4. */
  getJson<T>(path: string, options?: CallOptions): Promise<T>;
  /** GET returning the parsed body plus response headers (e.g. x-next-page). */
  getWithHeaders<T>(path: string, options?: CallOptions): Promise<GitLabResponse<T>>;
  /** Performs an authenticated JSON POST against GitLab API v4. */
  postJson<T>(path: string, body: Record<string, unknown>, options?: CallOptions): Promise<T>;
  /** Performs an authenticated JSON PUT against GitLab API v4. */
  putJson<T>(path: string, body: Record<string, unknown>, options?: CallOptions): Promise<T>;
  /** Performs an authenticated DELETE against GitLab API v4 (no body). */
  deleteJson<T>(path: string, options?: CallOptions): Promise<T>;
  getRaw(path: string, options?: CallOptions): Promise<Response>;
}

function isTimeoutError(error: unknown): boolean {
  const e = error as { name?: string; code?: string } | null;
  if (e === null || typeof e !== "object") return false;
  return e.name === "AbortError" || e.name === "TimeoutError" || e.code === "ABORT_ERR";
}

function isRateLimited(status: number): boolean {
  return status === 429;
}

/** Extracts GitLab's human message (`{message: ...}`) from an error body. */
async function gitlabErrorMessage(response: Response): Promise<string> {
  try {
    const text = await response.text();
    if (!text) return "";
    try {
      const body = JSON.parse(text) as { message?: unknown; error?: unknown };
      const message = body.message ?? body.error;
      if (typeof message === "string" && message) return ` ${message}`;
      return "";
    } catch {
      // Non-JSON body: include a bounded excerpt.
      return ` ${text.slice(0, 200)}`;
    }
  } catch {
    return "";
  }
}

export function createGitLabClient(
  ctx: GitLabRequestContext,
  clientOptions: GitLabClientOptions = {},
): GitLabClient {
  // When verify=false, use an undici Agent that skips TLS verification.
  const dispatcher = ctx.gitlab.tls.verify
    ? undefined
    : new Agent({ connect: { rejectUnauthorized: false } });

  const fetchImpl: FetchLike = dispatcher
    ? (url, init) =>
        fetch(url, { ...init, dispatcher } as RequestInit)
    : (url, init) => fetch(url, init);

  const base = ctx.gitlab.baseUrl.replace(/\/+$/, "");
  const defaultTimeoutMs = clientOptions.timeoutMs;

  async function request(path: string, options: CallOptions = {}): Promise<Response> {
    const url = `${base}${path.startsWith("/") ? path : `/${path}`}`;
    const timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
    const init: RequestInit = {
      headers: {
        Authorization: `Bearer ${ctx.gitlab.token}`,
        Accept: "application/json",
      },
      method: options.method,
      body: options.body,
    };
    if (options.body !== undefined) {
      init.headers = { ...init.headers, "Content-Type": "application/json" };
    }
    if (timeoutMs !== undefined) {
      init.signal = AbortSignal.timeout(timeoutMs);
    }

    let response: Response;
    try {
      response = await fetchImpl(url, init);
    } catch (cause) {
      if (isTimeoutError(cause)) {
        throw new GatewayError(
          ErrorCodes.GITLAB_TIMEOUT,
          `GitLab request timed out after ${timeoutMs}ms: ${path}`,
        );
      }
      throw new GatewayError(
        ErrorCodes.GITLAB_API_ERROR,
        `GitLab request failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
    if (!response.ok) {
      const detail = await gitlabErrorMessage(response);
      if (isRateLimited(response.status)) {
        // 429 is surfaced only — no auto-retry (FR-14).
        throw new GatewayError(
          ErrorCodes.GITLAB_RATE_LIMITED,
          `GitLab rate limited (429):${detail || " too many requests"}`,
        );
      }
      throw new GatewayError(
        ErrorCodes.GITLAB_API_ERROR,
        `GitLab returned HTTP ${response.status}:${detail || response.statusText}`,
      );
    }
    return response;
  }

  return {
    async getJson<T>(path: string, options?: CallOptions): Promise<T> {
      const response = await request(path, options);
      return (await response.json()) as T;
    },
    async getWithHeaders<T>(path: string, options?: CallOptions): Promise<GitLabResponse<T>> {
      const response = await request(path, options);
      const data = (await response.json()) as T;
      return { data, headers: response.headers };
    },
    async postJson<T>(
      path: string,
      body: Record<string, unknown>,
      options?: CallOptions,
    ): Promise<T> {
      const response = await request(path, {
        ...options,
        method: "POST",
        body: JSON.stringify(body),
      });
      return (await response.json()) as T;
    },
    async putJson<T>(
      path: string,
      body: Record<string, unknown>,
      options?: CallOptions,
    ): Promise<T> {
      const response = await request(path, {
        ...options,
        method: "PUT",
        body: JSON.stringify(body),
      });
      return (await response.json()) as T;
    },
    async deleteJson<T>(path: string, options?: CallOptions): Promise<T> {
      const response = await request(path, { ...options, method: "DELETE" });
      // 204 No Content (GitLab link deletion) parses to undefined.
      const text = await response.text();
      return (text ? JSON.parse(text) : undefined) as T;
    },
    getRaw(path: string, options?: CallOptions): Promise<Response> {
      return request(path, options);
    },
  };
}
