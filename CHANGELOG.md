# Changelog

## 0.1.0 — 2026-09-12

First complete delivery of the shared team GitLab MCP (Mode 1 direct credential, stateless).

### Server core

- Stateless Streamable HTTP MCP server on `/mcp` (no server-side sessions, no stored tokens — ADR-0001)
- Per-request credential pipeline: `X-GitLab-*` headers → host allowlist → TLS policy → identity resolution (SHA-256 token-hash cache, 10 h TTL) → policy engine → tool → audit
- Policy engine (ADR-0002): risk classes (READ/WRITE/PRIVILEGED/DESTRUCTIVE), 7-scope vocabulary, project-scope globs (nested groups, filters `project.list`), branch guardrails, `GITLAB_MCP_READ_ONLY` kill switch, typed `ERROR <CODE>: <message>` isError results
- GitLab client on fetch: per-call timeouts (30 s / 60 s job paths), error mapping (`GITLAB_API_ERROR`, `GITLAB_TIMEOUT`, `GITLAB_RATE_LIMITED`), opaque cursor pagination (`limit` ≤ 100), 100 KB start-truncation with continuation hints
- Audit: JSON lines to stdout, secret redaction layer on every sink, never blocks tool calls

### Tools (44, across 11 domains)

system · project · issue (7) · work_item (6, ADR-0003 task-list hierarchy + issue links) · branch (guardrails enforced) · repository · mr (7, privileged merge with dedicated `mr-merge` scope) · pipeline · job (trace offset continuation) · milestone · wiki · label

### Deployment & quality

- Hardened Docker image (non-root, healthcheck), Kubernetes manifests (2 replicas, probes, internal ingress placeholders), env + optional YAML config with redacted startup log
- CI workflow; smoke suite against real GitLab (skips without credentials)
- Tests: 355 passing (23 files) including a 16-test full-workflow E2E over real HTTP — identity, projects, issue lifecycle, branch guardrails, work items, MR merge gating, 160 KB trace reassembly, security denials, audit redaction
- Security review (issue #12): 5 findings fixed (redaction gaps, log sinks bypassing redaction, userinfo-in-URL, unbounded body → 413, header error handling); SSRF/TLS/exclusion list verified with 78 adversarial tests

### Documentation

`docs/requirements.md`, `docs/architecture.md`, `docs/tool-spec.md`, `CONTEXT.md` glossary, ADR-0001/0002/0003, team-facing README with client configuration.
