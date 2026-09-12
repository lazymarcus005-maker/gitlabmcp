# ADR-0001: Per-request direct credentials on a stateless shared MCP

Date: 2026-09-12
Status: Accepted

## Context

The GitLab MCP serves a whole team (developers and autonomous agents) through one shared HTTP endpoint. Options were a server-held credential per user (config/profile store) vs. callers passing their own GitLab credentials per request.

## Decision

The MCP is **stateless** (Streamable HTTP, no server-side sessions) and holds **no user configuration or tokens**. Every request carries the caller's GitLab host and Personal Access Token in headers (`X-GitLab-URL`, `X-GitLab-Token`). A Request Context is built per request, a GitLab Client is created from it, and both are destroyed with the request. Global token/client state is forbidden.

Consequences:

- GitLab's audit log shows the true acting user (their own PAT).
- No server-side secret store to protect, back up, or breach.
- Every replica can serve any request; no sticky sessions.
- Header spoofing is harmless only because credentials belong to the sender; the endpoint must therefore be protected at the network layer (internal ingress / IP allowlist / mTLS), not with app-level auth.
- Identity is resolved from the token (`GET /api/v4/user`), cached by token-hash with a 10-hour TTL; unresolved tokens are rejected with `GITLAB_TOKEN_INVALID`.
