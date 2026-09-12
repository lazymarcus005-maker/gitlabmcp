/**
 * Stage 3: identity resolution from the token via GET /api/v4/user.
 * Cross-request cache keyed by SHA-256(token) → identity, TTL 10h (FR-2).
 * Tokens are NEVER stored in the cache (ADR-0001).
 */
import { createHash } from "node:crypto";
import { ErrorCodes, GatewayError } from "../errors.js";
import type { GitLabIdentity } from "../context/request-context.js";

export interface FetchLike {
  (url: string, init?: RequestInit): Promise<Response>;
}

interface CacheEntry {
  identity: GitLabIdentity;
  expiresAt: number;
}

export interface IdentityResolverOptions {
  ttlMs: number;
  /** Injectable for tests. Defaults to global fetch. */
  fetchImpl?: FetchLike;
  now?: () => number;
}

export class IdentityResolver {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly ttlMs: number;
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;

  constructor(options: IdentityResolverOptions) {
    this.ttlMs = options.ttlMs;
    this.fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
    this.now = options.now ?? Date.now;
  }

  private static hashToken(token: string): string {
    return createHash("sha256").update(token, "utf8").digest("hex");
  }

  /** Resolves identity for baseUrl+token, using the cache when fresh. */
  async resolve(baseUrl: string, token: string): Promise<GitLabIdentity> {
    const key = IdentityResolver.hashToken(token);
    const entry = this.cache.get(key);
    if (entry && entry.expiresAt > this.now()) {
      return entry.identity;
    }
    this.cache.delete(key);

    const identity = await this.fetchIdentity(baseUrl, token);
    this.cache.set(key, {
      identity,
      expiresAt: this.now() + this.ttlMs,
    });
    return identity;
  }

  private async fetchIdentity(
    baseUrl: string,
    token: string,
  ): Promise<GitLabIdentity> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${baseUrl}/api/v4/user`, {
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch {
      throw new GatewayError(
        ErrorCodes.GITLAB_TOKEN_INVALID,
        "could not reach GitLab to resolve identity",
      );
    }
    if (!response.ok) {
      throw new GatewayError(
        ErrorCodes.GITLAB_TOKEN_INVALID,
        `GitLab rejected the token (HTTP ${response.status})`,
      );
    }
    const body = (await response.json()) as Record<string, unknown>;
    const id = body["id"];
    const username = body["username"];
    if (typeof id !== "number" || typeof username !== "string") {
      throw new GatewayError(
        ErrorCodes.GITLAB_TOKEN_INVALID,
        "GitLab /user response was malformed",
      );
    }
    const name = body["name"];
    return {
      id,
      username,
      name: typeof name === "string" ? name : undefined,
    };
  }
}
