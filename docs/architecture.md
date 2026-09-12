# GitLab MCP — Architecture

TypeScript MCP server over Streamable HTTP (stateless), serving a shared team endpoint against private GitLab (EE Free v18.8.3-ee). Decisions referenced as ADR-000x under `docs/adr/`.

## 1. Topology

```text
Developer A ─┐
Developer B ─┼─ MCP over HTTP ──▶ Ingress (internal, IP allowlist / mTLS)
Hermes Agent ┘                         │
                              gitlab-mcp (N replicas, stateless)
                                       │
                                 GitLab API v4 (+ GraphQL)
```

- One shared endpoint; each request carries the caller's own PAT in headers (ADR-0001).
- No app-level auth; the endpoint is protected at the network layer only.
- Replicas are interchangeable; no sticky sessions (transport is stateless).

## 2. Request lifecycle

```text
POST /mcp
  │
  ▼
Transport (Streamable HTTP, stateless)          src/server/transport.ts
  │
  ▼
Header parsing → GitLabRequestContext           src/context/headers.ts, request-context.ts
  │
  ▼
Security gateway (in order, fail fast):         src/security/
  1. host allowlist      → GITLAB_HOST_NOT_ALLOWED
  2. TLS policy          → POLICY_TLS_VERIFY_FORBIDDEN
  3. identity resolve    → GITLAB_TOKEN_INVALID (cache: token-hash → identity, TTL 10h)
  4. project scope parse → VALIDATION_ERROR
  │
  ▼
GitLab Client (fetch-based, per-request)        src/gitlab/client-factory.ts
  │  baseUrl, token, TLS options from ctx — never shared, never global
  ▼
Policy engine (per tool call)                   src/policy/policy-engine.ts
  │  risk class × requested scope × server policy × read-only kill switch
  ▼
Tool handler → GitLab API call → response shaping (pagination, truncation)
  │
  ▼
Audit Record → stdout (JSON lines)              src/audit/logger.ts
  │
  ▼
Destroy context + client
```

## 3. Modules

```text
src/
├── server/          MCP server wiring, Streamable HTTP transport (stateless mode)
├── context/         GitLabRequestContext, header parsing/validation
├── security/        host-allowlist, tls-policy, scope (project/requested), redaction
├── policy/          policy-engine, risk classes, branch guardrails
├── gitlab/          client-factory, rest (fetch), graphql, pagination, capability
├── tools/           one folder per domain; each tool = schema + handler + risk class
└── audit/           JSON-lines logger to stdout, non-blocking
```

Key invariants:

- **No global token/client state.** Everything credential-bearing lives inside `GitLabRequestContext` and dies with the request (ADR-0001).
- **The MCP only reduces.** Policy engine intersects GitLab permission ∩ server policy ∩ requested scope (ADR-0002).
- **GitLab is the only source of truth** for structure — work item parent/child lives in issue descriptions as task lists, dependencies in issue links (ADR-0003). The stateless server keeps no side state.

## 4. Context model

```ts
interface GitLabRequestContext {
  requestId: string;
  gitlab: {
    baseUrl: string;
    token: string;
    tls: { verify: boolean; caFile?: string };
  };
  identity: { id: number; username: string; name?: string }; // resolved from token
  defaults?: { group?: string; project?: string };
  projectScope?: string[];      // glob patterns
  requestedScopes?: string[];   // read, issue-write, mr-write, mr-merge, repo-write, pipeline-write, project-write
}
```

Lifetime: one MCP request. The identity cache is the only cross-request structure and stores **no tokens** — keyed by SHA-256 of the token, value = identity only.

## 5. Policy engine

Input per tool call: tool name → risk class (`READ`/`WRITE`/`PRIVILEGED`/`DESTRUCTIVE`), required scope, target project/group, branch (when applicable).

Decision order:

1. `GITLAB_MCP_READ_ONLY=true` → deny everything above READ.
2. Risk class not allowed by server policy → `POLICY_OPERATION_DENIED` (DESTRUCTIVE defaults to deny; not exposed in V1 anyway).
3. Required scope missing from `requestedScopes` → `POLICY_SCOPE_MISSING`.
4. Target outside project scope → `SCOPE_PROJECT_NOT_ALLOWED`.
5. Branch guardrails: create/delete on protected branch → `POLICY_BRANCH_PROTECTED`.
6. Otherwise pass; GitLab's own permissions are the final gate (enforced by GitLab itself).

Tool handlers never implement permission logic — they declare risk + scope and let the engine decide.

## 6. GitLab client

- `client-factory.ts`: builds a fetch-based client from the context (host, token, TLS verify / per-host CA). No SDK that hides TLS options.
- `rest.ts`: typed v4 calls; maps HTTP errors to the error taxonomy (`GITLAB_API_ERROR` + status + GitLab message).
- `graphql.ts`: only where REST is insufficient (complex search; native work items if the tier is ever upgraded).
- `pagination.ts`: translates the `{limit, cursor}` contract to GitLab `per_page`/`page`; cursor = base64 `{page, per_page}`; enforces `limit ≤ 100`.
- `capability.ts`: startup call to `/api/v4/version`, logged; no dynamic tool gating.

## 7. Response shaping

- Every list response: `{ items, pagination: { has_more, next_cursor } }`.
- Size cap (default 100 KB, configurable): truncate from the start, set `truncated: true`, include a continuation hint (`job.trace` accepts `offset`).

## 8. Audit

One JSON line per tool call:

```json
{ "request_id": "req-18291", "gitlab": { "host": "git.tiddaw.net", "user_id": 123, "username": "marcus" }, "tool": "gitlab_issue_update", "project": "itrend/cxutility", "resource": "#101", "result": "success", "duration_ms": 340 }
```

Redaction layer (`security/redaction.ts`) strips token/Authorization/cookie/secret patterns from anything logged. Audit write failures are swallowed (never block tool execution).

## 9. Deployment

- Single container (`Dockerfile`), health endpoint, no volume mounts except optional CA bundle.
- Kubernetes: ingress (internal, IP allowlist / mTLS), `replicas ≥ 2`, config via ConfigMap env vars + optional YAML.
- Optional future: per-host internal CA files (`gitlab.hosts.<host>.ca_file`) preferred over `verify=false`.

## 10. Testing strategy

1. **Unit**: policy engine, scope matcher, cursor codec, redaction, header parsing.
2. **Contract**: mock GitLab (e.g. msw/wiremock) covering every tool's happy path + error mapping.
3. **Smoke**: small suite against the real instance, enabled by env vars in CI, read-only paths only.

## 11. Agent workflow (MCP + Git CLI division)

```text
MCP issue.get → MCP branch.create → Git CLI checkout/code/commit/push
→ MCP mr.create → MCP pipeline.get → MCP job.trace
```

The MCP never replaces clone/commit/push; agents use their local Git for repository writes.
