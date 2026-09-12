/**
 * GitLab client factory (architecture §6): builds a per-request fetch-based
 * client from the context. Never shared across requests; never global.
 */
import { Agent } from "undici";
import { ErrorCodes, GatewayError } from "../errors.js";
import type { GitLabRequestContext } from "../context/request-context.js";
import type { FetchLike } from "../security/identity.js";

export interface GitLabClient {
  /** Performs an authenticated GET against GitLab API v4. */
  getJson<T>(path: string): Promise<T>;
  getRaw(path: string): Promise<Response>;
}

export function createGitLabClient(ctx: GitLabRequestContext): GitLabClient {
  // When verify=false, use an undici Agent that skips TLS verification.
  const dispatcher = ctx.gitlab.tls.verify
    ? undefined
    : new Agent({ connect: { rejectUnauthorized: false } });

  const fetchImpl: FetchLike = dispatcher
    ? (url, init) =>
        fetch(url, { ...init, dispatcher } as RequestInit)
    : (url, init) => fetch(url, init);

  const base = ctx.gitlab.baseUrl.replace(/\/+$/, "");

  async function request(path: string): Promise<Response> {
    const url = `${base}${path.startsWith("/") ? path : `/${path}`}`;
    let response: Response;
    try {
      response = await fetchImpl(url, {
        headers: {
          Authorization: `Bearer ${ctx.gitlab.token}`,
          Accept: "application/json",
        },
      });
    } catch (cause) {
      throw new GatewayError(
        ErrorCodes.GITLAB_API_ERROR,
        `GitLab request failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
    if (!response.ok) {
      throw new GatewayError(
        ErrorCodes.GITLAB_API_ERROR,
        `GitLab returned HTTP ${response.status}`,
      );
    }
    return response;
  }

  return {
    async getJson<T>(path: string): Promise<T> {
      const response = await request(path);
      return (await response.json()) as T;
    },
    getRaw(path: string): Promise<Response> {
      return request(path);
    },
  };
}
