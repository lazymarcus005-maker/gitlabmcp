# ADR-0002: Effective permission is an intersection; the MCP only reduces

Date: 2026-09-12
Status: Accepted

## Context

The MCP sits between agents and GitLab. It could try to manage permissions per user itself, or delegate to GitLab.

## Decision

Effective permission = **GitLab native permission ∩ MCP server policy ∩ client-requested scope**. The MCP never grants anything GitLab would deny; it only narrows. Tool calls carry a Risk Class (`READ`/`WRITE`/`PRIVILEGED`/`DESTRUCTIVE`), and the Policy Engine applies configured allow/deny per class plus requested scope. Secret-bearing and destructive APIs (CI/CD variables, tokens, project/group delete, member remove) are not exposed in V1 at all.

Consequences:

- No per-user permission config to maintain on the MCP; GitLab stays the source of truth.
- Adding MCP policy can never break least-privilege assumptions — worst case it blocks work.
- `X-GitLab-Request-Scope: admin` grants nothing; scopes are a reduction vocabulary only.
- Agent self-limiting (`X-GitLab-Request-Scope: read`) works even with a write-capable PAT.
