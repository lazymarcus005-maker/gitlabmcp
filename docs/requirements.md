# GitLab MCP — Requirements

Shared team GitLab MCP server, Mode 1 (direct credential per request), targeting GitLab **EE Free v18.8.3-ee** (REST API v4 primary, GraphQL only where REST is insufficient).

## 1. Functional requirements

### FR-1 Shared, stateless endpoint
- One MCP endpoint (`/mcp`) serves the whole team: developers and autonomous agents.
- Transport: **Streamable HTTP, stateless** — no server-side session store, no sticky sessions, no SSE long-lived streams. Every POST is an independent request.
- Horizontal scaling: `replicas: N` with no coordination between replicas.

### FR-2 Per-request credentials (Mode 1)
- Each request carries the caller's own GitLab host and Personal Access Token in headers:
  - `X-GitLab-URL` (required), `X-GitLab-Token` (required)
  - `X-GitLab-SSL-Verify`, `X-GitLab-Default-Group`, `X-GitLab-Default-Project`, `X-GitLab-Project-Scope`, `X-GitLab-Request-Scope` (optional)
- The server stores **no** user configs or tokens. No team token. Identity is never client-supplied; it is derived from the token via `GET /api/v4/user`.
- Identity resolution: once per request, cached by token-hash with a **10-hour TTL**. Unresolvable token → reject immediately with `GITLAB_TOKEN_INVALID`.

### FR-3 Security gateway (mandatory pipeline)
Every request passes, in order: parse headers → host allowlist validation → TLS policy validation → identity resolution → project scope application → policy engine → tool execution. Rejection at any stage returns a typed error (see §3).

### FR-4 Host allowlist (SSRF protection)
- Server config lists the only GitLab hosts a request may target (`allowed_hosts`).
- Any `X-GitLab-URL` not on the list (including link-local IPs, internal metadata endpoints, foreign domains) → `GITLAB_HOST_NOT_ALLOWED`.

### FR-5 TLS policy
- Default `verify=true`.
- `X-GitLab-SSL-Verify: false` is honored **only** when the server config permits disabling verification for that host (`allow_disable_verify` + `disable_verify_hosts`).
- Future: per-host internal CA file support (`hosts.<host>.ca_file`) — preferred over `verify=false`.

### FR-6 Permission model (intersection)
Effective permission = **GitLab native permission ∩ MCP server policy ∩ client-requested scope**. The MCP only reduces; GitLab remains the source of truth.

### FR-7 Requested scopes
Caller-declared reduction vocabulary (header `X-GitLab-Request-Scope`, comma-separated):

| Scope | Grants |
| --- | --- |
| `read` | every READ tool in all domains |
| `issue-write` | issue.* and work_item.* WRITE tools |
| `mr-write` | mr create/update/comment |
| `mr-merge` | mr.merge only |
| `repo-write` | branch.create / branch.delete |
| `pipeline-write` | pipeline.retry / pipeline.cancel |
| `project-write` | milestone / wiki / label create/update |

- Scopes can only **reduce**. `X-GitLab-Request-Scope: admin` grants nothing.
- PRIVILEGED tools require both their scope and policy allow.

### FR-8 Project scope
- `X-GitLab-Project-Scope`: glob patterns (`itrend/*`) or explicit paths (`itrend/cxutility,itrend/cxgateway`).
- Covers projects **and groups** under the wildcard; `project.list` results are always filtered by scope.
- Tool calls targeting anything outside scope → `SCOPE_PROJECT_NOT_ALLOWED`.

### FR-9 Defaults
- `X-GitLab-Default-Project` lets tools omit the project argument. `X-GitLab-Default-Group` for group-scoped operations.
- Explicit `project` arguments are allowed only within the project scope.

### FR-10 Tool surface (V1, ~44 tools)
Domains: system, project, issue, work_item, branch, repository, merge request, pipeline, job, milestone, wiki, label. Full catalog with scopes and risk classes: see `tool-spec.md`.
- Tool names match MCP spec pattern `^[a-zA-Z0-9_-]{1,128}$`, prefixed `gitlab_<domain>_<action>` (e.g. `gitlab_issue_get`).
- **Work Items on EE Free**: a Work Item **is** an issue. Parent–child = task-list entries (`- [ ] #<iid>`) in the parent description; dependencies = issue links (`blocks`/`is_blocked_by`). See ADR-0003.
- Branch guardrails: server policy lists protected branches (default `main`, `master`, `uat`, `production`); deny direct delete and deny create-on-protected. Branch naming allowlist deferred to V2.
- Not exposed in V1: project.delete/transfer, group.delete, member.remove, protected_branch.delete, CI/CD variables, deploy/access tokens, runner.delete — anything secret-bearing or destructive.

### FR-11 Git operations boundary
The MCP does **not** replace the Git CLI. clone/fetch/checkout/commit/push stay in the agent's local Git. MCP covers issues, work items, MRs, pipelines, branches, repository browsing (tree/file), wiki, milestones, labels, search.

### FR-12 Pagination contract
- Tools returning lists accept `{ "limit": n, "cursor": "..." }`.
- `limit` default 20, max 100. Response: `{ "items": [...], "pagination": { "has_more": bool, "next_cursor": "..." } }`.
- GitLab `page`/`per_page`/`x-next-page` are never exposed; cursor is opaque (base64 of `{page, per_page}`).

### FR-13 Response size limits
- Responses that may be large (mr.diff, job.trace, repository.tree, list results) are capped at a configurable size (default 100 KB).
- Truncated responses are cut from the **start** (latest content kept for traces) and carry `truncated: true` plus a hint (e.g. `job.trace` supports `offset` for continuation).

### FR-14 Timeouts
- Per-request timeout to GitLab: 30 s (60 s for job.list/job.trace). On expiry → `GITLAB_TIMEOUT`.
- No automatic server-side retry for mutating calls; the client/agent decides on retries.

### FR-15 Error contract
- Security/policy/API failures are returned as MCP tool results with `isError: true`, one text block containing a machine-readable code and a human message, e.g. `ERROR GITLAB_HOST_NOT_ALLOWED: host 'evil.example.com' is not in the allowlist`.
- Full code taxonomy: see `tool-spec.md` §Error codes. Transport-level errors are never used for policy rejections.

### FR-16 Capability check
- On startup the server calls `GET /api/v4/version`, logs the GitLab version, and does not dynamically disable tools. Unsupported operations fail at call time with `GITLAB_NOT_SUPPORTED`.

## 2. Non-functional requirements

- **NFR-1 Security**: no secrets in logs (tokens, Authorization, cookies, CI variable values). Secret redaction layer on all outbound log content.
- **NFR-2 Audit**: one structured JSON `Audit Record` per tool call on **stdout** (JSON lines): request_id, gitlab host, user_id, username, tool, project, resource, result, duration_ms. Log failures never block tool execution.
- **NFR-3 Config**: env vars are the primary source of truth (allowlist, flags, limits); optional YAML file for nested structures (per-host CA). `GITLAB_MCP_READ_ONLY=true` is the emergency kill switch: denies WRITE/PRIVILEGED/DESTRUCTIVE server-wide.
- **NFR-4 Deployment**: single stateless container on Kubernetes behind an ingress; no persistence, no sticky sessions.
- **NFR-5 Stack**: TypeScript, `@modelcontextprotocol/sdk` (Streamable HTTP, stateless mode), GitLab REST client written on `fetch` (custom TLS control), GraphQL client for the few endpoints REST lacks.
- **NFR-6 Testing**: unit tests for pure logic (policy engine, scope matcher, cursor codec, redaction) + contract tests against a mock GitLab + a small smoke suite against a real instance (enabled by env var in CI).

## 3. Error codes (baseline)

`GITLAB_HOST_NOT_ALLOWED`, `GITLAB_TOKEN_INVALID`, `GITLAB_NOT_SUPPORTED`, `GITLAB_TIMEOUT`, `GITLAB_API_ERROR`, `SCOPE_PROJECT_NOT_ALLOWED`, `POLICY_OPERATION_DENIED`, `POLICY_BRANCH_PROTECTED`, `VALIDATION_ERROR` — extended in `tool-spec.md`.

## 4. Out of scope (V1)

- App-level auth (SSO/OAuth) on the MCP endpoint — network controls only.
- Human-confirmation UX inside the MCP — clients own confirmation; MCP enforces policy only.
- Branch naming allowlists, group-level admin tools, secrets/variables, dynamic capability gating.
