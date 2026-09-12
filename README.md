# gitlabmcp — Shared team GitLab MCP server

A stateless, per-request-credential MCP (Model Context Protocol) server for
GitLab. Agents authenticate **per request** with `X-GitLab-*` headers; the
server stores no tokens, has no sessions, and no persistence — any replica can
serve any request.

- Architecture and decisions: [`docs/architecture.md`](docs/architecture.md)
  (§9 Deployment, §10 Testing), [`docs/requirements.md`](docs/requirements.md)
  (NFR-3/NFR-4/NFR-6), [`docs/tool-spec.md`](docs/tool-spec.md), `docs/adr/`.
- Example server config: [`config/server.yaml`](config/server.yaml).

## Quick start

```bash
npm install
npm run build
npm test          # unit + contract tests (mock GitLab)
npm run smoke     # read-only smoke tests; needs credentials, skips otherwise
npm start         # serve Streamable HTTP on :8080/mcp
```

## Configuration (NFR-3)

Env vars are the primary source of truth. An optional YAML file
(`config/server.yaml`, or `GITLAB_MCP_CONFIG_YAML=<path>`) may provide nested
base values; **env vars always win** over YAML. At startup the server logs the
effective config as one JSON line — it contains no secrets (tokens are
per-request only).

| Env var | Default | Meaning |
| --- | --- | --- |
| `GITLAB_MCP_PORT` | `8080` | HTTP listen port |
| `GITLAB_MCP_HTTP_PATH` | `/mcp` | MCP endpoint path |
| `GITLAB_MCP_CONFIG_YAML` | `config/server.yaml` | Optional YAML config path |
| `GITLAB_MCP_ALLOWED_HOSTS` | *(empty)* | Comma-separated hosts reachable via `X-GitLab-URL` (SSRF guard) |
| `GITLAB_MCP_ALLOW_CUSTOM_HOSTS` | `false` | Allow hosts outside the allowlist |
| `GITLAB_MCP_ALLOW_DISABLE_VERIFY` | `true` | Honor `X-GitLab-SSL-Verify: false` at all |
| `GITLAB_MCP_DISABLE_VERIFY_HOSTS` | *(empty)* | Hosts exempted from TLS verification |
| `GITLAB_MCP_READ_ONLY` | `false` | Kill switch: deny WRITE/PRIVILEGED/DESTRUCTIVE server-wide |
| `GITLAB_MCP_RISK_ALLOW` | `READ,WRITE,PRIVILEGED` | Allowed risk classes |
| `GITLAB_MCP_PROTECTED_BRANCHES` | `main,master,uat,production` | Branches denying create/delete |
| `GITLAB_MCP_DENY_DIRECT_DELETE` | *(empty)* | Branches additionally denying direct delete |
| `GITLAB_MCP_PAGINATION_DEFAULT_LIMIT` | `20` | Default page size |
| `GITLAB_MCP_PAGINATION_MAX_LIMIT` | `100` | Hard cap on `limit` |
| `GITLAB_MCP_MAX_BYTES` | `102400` | Response size cap in bytes (truncates) |
| `GITLAB_MCP_TIMEOUT_MS` | `30000` | Per-request GitLab timeout |
| `GITLAB_MCP_JOB_TIMEOUT_MS` | `60000` | Timeout for `job.*` paths |
| `GITLAB_MCP_IDENTITY_CACHE_TTL_MS` | `36000000` | Identity cache TTL (SHA-256(token) → identity, 10 h) |
| `GITLAB_MCP_AUDIT_DESTINATION` | `stdout` | Audit destination (JSON lines) |
| `GITLAB_MCP_AUDIT_REDACT_SECRETS` | `true` | Redact secrets in audit output |

## Request headers (per-request credentials)

| Header | Meaning |
| --- | --- |
| `X-GitLab-URL` | Base URL of the GitLab instance (must be allowlisted) |
| `X-GitLab-Token` | GitLab personal access token for this request |
| `X-GitLab-SSL-Verify` | `false` to skip TLS verification (exempt hosts only) |
| `X-GitLab-Default-Project` | Default project for tools that take `project` |
| `X-GitLab-Default-Group` | Default group |
| `X-GitLab-Project-Scope` | Comma-separated allowlist patterns for `gitlab_project_list` |
| `X-GitLab-Request-Scope` | Comma-separated tool scope filter |

## Team-facing client configuration

Copy this into your MCP client config (Claude Code / Cline / any
Streamable-HTTP-capable client) and export `GITLAB_TOKEN` in your shell:

```json
{
  "mcpServers": {
    "gitlab": {
      "type": "http",
      "url": "https://gitlab-mcp.internal.example.com/mcp",
      "headers": {
        "X-GitLab-URL": "https://git.tiddaw.net",
        "X-GitLab-Token": "${GITLAB_TOKEN}",
        "X-GitLab-SSL-Verify": "true",
        "X-GitLab-Project-Scope": "itrend/*"
      }
    }
  }
}
```

Create a GitLab token with the minimal scopes you need (e.g. `read_api` for
read-only usage). The token is used only for the duration of each request.

## Docker

```bash
docker build -t gitlab-mcp:local .
docker run --rm -p 8080:8080 \
  -e GITLAB_MCP_ALLOWED_HOSTS=git.tiddaw.net \
  gitlab-mcp:local
curl -s http://127.0.0.1:8080/health   # {"status":"ok"}
```

The image is multi-stage (`node:22-alpine`), runs as the non-root `node` user,
and has a `HEALTHCHECK` hitting `GET /health`.

## Kubernetes

Manifests live in [`deploy/k8s/`](deploy/k8s/):

- `deployment.yaml` — 2 replicas, non-root, resource requests/limits,
  liveness/readiness probes on `/health`. Stateless: no persistence, no
  sticky sessions.
- `service.yaml` — ClusterIP service.
- `configmap.yaml` — example env-var mapping; adjust values, never store
  tokens here (credentials are per-request).
- `ingress.yaml` — internal ingress example with annotation placeholders for
  IP allowlisting and mTLS client certificates.

```bash
kubectl apply -f deploy/k8s/
```

## Smoke suite (NFR-6)

`npm run smoke` starts the server as a child process and drives it over HTTP
(`initialize`, `tools/list`, `tools/call` of read-only tools like
`gitlab_system_current_user` and `gitlab_project_list`) against a real GitLab
instance. Enable with:

```bash
GITLAB_MCP_SMOKE_URL=https://git.tiddaw.net \
GITLAB_MCP_SMOKE_TOKEN=$GITLAB_TOKEN \
npm run smoke
```

Without those variables the suite skips cleanly. No mutating calls are made.

## CI

`.github/workflows/ci.yml` runs typecheck, build, and the test suite on every
push and PR to `main`. The smoke suite runs in CI only when
`GITLAB_MCP_SMOKE_URL` / `GITLAB_MCP_SMOKE_TOKEN` secrets are provided.
