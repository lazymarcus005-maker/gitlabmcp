# GitLab MCP — Tool Spec (V1)

Tool names follow MCP spec `^[a-zA-Z0-9_-]{1,128}$`, pattern `gitlab_<domain>_<action>`. 44 tools.

Conventions:

- **Scope**: minimum entry required in `X-GitLab-Request-Scope`. Omitted scope header defaults to **all scopes** (subject to server policy).
- **Risk**: READ / WRITE / PRIVILEGED. (DESTRUCTIVE exists in the risk model but no V1 tool carries it.)
- **project argument**: optional when `X-GitLab-Default-Project` is set; must be inside Project Scope.
- All list tools accept `limit` (default 20, max 100) + `cursor`; return `{items, pagination:{has_more, next_cursor}}`.
- Work Items on EE Free: a work item is an issue; parent–child = task list in description; dependencies = issue links (ADR-0003).

## Risk & scope matrix

| Domain | Tools | Scope for WRITE |
| --- | --- | --- |
| system | info, current_user | — (READ only) |
| project | get, list, members | — (READ only in V1) |
| issue | list, get, create, update, close, reopen, comment | `issue-write` |
| work_item | get, children, add_child, remove_child, link, unlink | `issue-write` |
| branch | list, get, create, delete | `repo-write` |
| repository | tree, file_get | — (READ only) |
| mr | list, get, create, update, diff, comment, merge | `mr-write` (merge: `mr-merge`) |
| pipeline / job | pipeline list/get/retry/cancel; job list/get/trace | `pipeline-write` (retry/cancel) |
| milestone | list, get, create, update | `project-write` |
| wiki | list, get, create, update | `project-write` |
| label | list, create | `project-write` |

## Tool catalog

### System
- `gitlab_system_info` — READ — GitLab version, API capabilities seen at startup.
- `gitlab_system_current_user` — READ — resolved identity for this request's token.

### Project
- `gitlab_project_get` — READ — args: `project`. Returns metadata, default branch, visibility.
- `gitlab_project_list` — READ — args: `search?`, `group?`. **Always filtered by Project Scope.**
- `gitlab_project_members` — READ — args: `project`.

### Issue
- `gitlab_issue_list` — READ — args: `project`, `state?`, `labels?`, `search?`, `assignee?`, pagination.
- `gitlab_issue_get` — READ — args: `project`, `iid`.
- `gitlab_issue_create` — WRITE — args: `project`, `title`, `description?`, `labels?`, `assignee_ids?`.
- `gitlab_issue_update` — WRITE — args: `project`, `iid`, `title?`, `description?`, `labels?`, `state_event?`.
- `gitlab_issue_close` / `gitlab_issue_reopen` — WRITE — args: `project`, `iid`.
- `gitlab_issue_comment` — WRITE — args: `project`, `iid`, `body`.

### Work Item (EE Free backing — ADR-0003)
- `gitlab_work_item_get` — READ — args: `project`, `iid`. Issue + parsed hierarchy/dependency view.
- `gitlab_work_item_children` — READ — args: `project`, `iid`. Parses task-list entries in description.
- `gitlab_work_item_add_child` — WRITE — args: `project`, `iid`, `child_iid`. Appends `- [ ] #<child_iid>` to parent description.
- `gitlab_work_item_remove_child` — WRITE — args: `project`, `iid`, `child_iid`. Removes the entry; tolerant of hand edits.
- `gitlab_work_item_link` — WRITE — args: `project`, `iid`, `target_iid`, `link_type: "blocks" | "is_blocked_by"`. Issue links API.
- `gitlab_work_item_unlink` — WRITE — args: `project`, `iid`, `target_iid`.

### Branch
- `gitlab_branch_list` / `gitlab_branch_get` — READ.
- `gitlab_branch_create` — WRITE — args: `project`, `branch`, `ref`. Denied on protected branches.
- `gitlab_branch_delete` — PRIVILEGED — args: `project`, `branch`. Denied on `deny_direct_delete` list.

### Repository
- `gitlab_repository_tree` — READ — args: `project`, `path?`, `ref?`, pagination. Size-capped.
- `gitlab_repository_file_get` — READ — args: `project`, `file_path`, `ref?`. Size-capped.

### Merge Request
- `gitlab_mr_list` — READ — args: `project`, `state?`, `target_branch?`, pagination.
- `gitlab_mr_get` — READ — args: `project`, `mr_iid`.
- `gitlab_mr_create` — WRITE — args: `project`, `source_branch`, `target_branch`, `title`, `description?`, `remove_source_branch?`.
- `gitlab_mr_update` — WRITE — args: `project`, `mr_iid`, `title?`, `description?`, `state_event?`.
- `gitlab_mr_diff` — READ — args: `project`, `mr_iid`. Size-capped, `truncated` flag.
- `gitlab_mr_comment` — WRITE — args: `project`, `mr_iid`, `body`.
- `gitlab_mr_merge` — PRIVILEGED — args: `project`, `mr_iid`, `merge_when_pipeline_succeeds?`. Requires `mr-merge` scope **and** policy allow.

### Pipeline & Job
- `gitlab_pipeline_list` — READ — args: `project`, `ref?`, `status?`, pagination.
- `gitlab_pipeline_get` — READ — args: `project`, `pipeline_id`.
- `gitlab_pipeline_retry` / `gitlab_pipeline_cancel` — WRITE — args: `project`, `pipeline_id`.
- `gitlab_job_list` — READ — args: `project`, `pipeline_id` (60 s timeout).
- `gitlab_job_get` — READ — args: `project`, `job_id`.
- `gitlab_job_trace` — READ — args: `project`, `job_id`, `offset?` (60 s timeout; continuation via offset).

### Milestone
- `gitlab_milestone_list` / `gitlab_milestone_get` — READ.
- `gitlab_milestone_create` / `gitlab_milestone_update` — WRITE (`project-write`).

### Wiki
- `gitlab_wiki_list` / `gitlab_wiki_get` — READ.
- `gitlab_wiki_create` / `gitlab_wiki_update` — WRITE (`project-write`).

### Label
- `gitlab_label_list` — READ.
- `gitlab_label_create` — WRITE (`project-write`).

## Error codes

Every tool error is returned as an MCP result with `isError: true`, one text block: `ERROR <CODE>: <message>`.

| Code | Stage | Meaning |
| --- | --- | --- |
| `VALIDATION_ERROR` | gateway | malformed headers/arguments |
| `GITLAB_HOST_NOT_ALLOWED` | gateway | host not in server allowlist |
| `POLICY_TLS_VERIFY_FORBIDDEN` | gateway | `SSL-Verify: false` not permitted for host |
| `GITLAB_TOKEN_INVALID` | gateway | identity resolution failed |
| `SCOPE_PROJECT_NOT_ALLOWED` | policy | target outside Project Scope |
| `POLICY_SCOPE_MISSING` | policy | required requested-scope absent |
| `POLICY_OPERATION_DENIED` | policy | risk class denied by server policy / read-only switch |
| `POLICY_BRANCH_PROTECTED` | policy | branch guardrail |
| `GITLAB_NOT_SUPPORTED` | tool | GitLab tier/version lacks the operation |
| `GITLAB_TIMEOUT` | tool | 30 s (60 s job.*) exceeded |
| `GITLAB_API_ERROR` | tool | GitLab returned an error (status + message included) |
| `GITLAB_RATE_LIMITED` | tool | GitLab 429 (surface only, no auto-retry) |

## Input schema rules

- `project` format: `namespace/path`. Where the default project applies, omitting it uses `X-GitLab-Default-Project`; overrides must pass Project Scope.
- Arguments not in this spec are rejected (`VALIDATION_ERROR`) — no pass-through of arbitrary GitLab API params in V1.
