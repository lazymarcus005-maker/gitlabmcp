/**
 * GitLabRequestContext — the per-request context model (architecture §4).
 * Lives and dies with one request; never stored globally (ADR-0001).
 */
export interface GitLabIdentity {
  id: number;
  username: string;
  name?: string;
}

export interface GitLabRequestContext {
  requestId: string;
  gitlab: {
    baseUrl: string;
    token: string;
    tls: { verify: boolean };
  };
  identity: GitLabIdentity;
  defaults?: { group?: string; project?: string };
  projectScope?: string[];
  requestedScopes?: string[];
}
