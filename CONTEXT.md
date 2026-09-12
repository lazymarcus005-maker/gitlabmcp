# CONTEXT.md

Glossary for the GitLab MCP project. Terms here are canonical; do not drift to synonyms.

## Terms

### Request Context
The per-request object holding everything a single MCP request needs: GitLab base URL, token, TLS policy, resolved identity, defaults, project scope, requested scope. Lives and dies with one request. Never stored globally.

### Identity
The real GitLab user (id, username) behind a request, resolved from the caller's Personal Access Token via `GET /api/v4/user`. Identity is never supplied by the client; it is derived. Used only for audit and logging.

### Requested Scope
A caller-declared narrowing (via `X-GitLab-Request-Scope`) of what this request may do, e.g. `read`, `issue-write`, `mr-merge`. Scopes can only reduce effective permission, never expand it.

### Project Scope
A caller-declared allowlist of projects/groups (glob patterns, e.g. `itrend/*`) bounding every tool call in the request. Reduces blast radius of a leaked or over-privileged PAT.

### Default Project / Default Group
Caller-supplied (`X-GitLab-Default-Project`, `X-GitLab-Default-Group`) implicit target so tools can omit the project argument. Overrides are allowed only within the Project Scope.

### Risk Class
Per-tool classification: `READ`, `WRITE`, `PRIVILEGED`, `DESTRUCTIVE`. The Policy Engine uses it plus scope to allow/deny. The MCP never has a confirmation UX; it enforces policy only.

### Policy Engine
Server-side rule set (from server config) that intersects with GitLab's native permissions. The MCP only reduces permission; GitLab remains the source of truth.

### GitLab Client
An HTTP client instantiated from the Request Context, carrying the caller's token and TLS policy. One per request; never shared across requests or users.

### Host Allowlist
Server-side list of GitLab hosts a request may target. Requests naming other hosts are rejected as SSRF protection (`GITLAB_HOST_NOT_ALLOWED`).

### TLS Policy
Effective certificate verification for the request: default verify, downgrade to `verify=false` only when both the caller asks and the server config permits that host.

### Work Item
On this deployment (GitLab EE Free), a Work Item **is** an issue; there is no native task/epic child-item API. Parent–child structure and Relationship Links are both layered onto GitLab issue features (see tool-spec for the exact backing representation).

### Relationship Link
A directional link between two items expressing dependency (e.g. `blocked_by`), as opposed to parent–child hierarchy.

### Audit Record
The structured JSON log line per tool call: request id, GitLab host, user id/username, tool, project, resource, result, duration. Never contains tokens or secret values.
