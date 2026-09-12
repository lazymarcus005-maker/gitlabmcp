# ADR-0003: Work Item hierarchy on EE Free — task lists for parent–child, issue links for dependencies

Date: 2026-09-12
Status: Accepted

## Context

The target GitLab is Enterprise Edition **Free** (v18.8.3-ee), which has no native Work Items hierarchy (tasks/epics-as-parents are Premium/Ultimate). The tool surface nevertheless includes `gitlab_work_item_*` tools (children, add_child, remove_child, link, unlink). Two candidate backings:

1. **Description task lists** — parent's description contains `- [ ] #123` lines; GitLab UI renders these as linked items natively.
2. **Issue links with a `relates_to` convention** — MCP interprets link direction as parent→child.

## Decision

- **Parent–child**: represented by task-list entries (`- [ ] #<iid>`) in the parent issue's description. `add_child` / `remove_child` edit the description; `children` parses it.
- **Dependencies** (`work_item.link` / `unlink`, `blocked_by`): backed by GitLab **issue links** (`blocks` / `is_blocked_by`).

## Consequences

- All structure lives inside GitLab; the stateless MCP needs no side store — link direction survives without server state.
- Users editing descriptions by hand can break/forge parent–child structure; `children` parsing must be tolerant, and `add_child` should append without disturbing other content.
- GitLab UI shows parent–child as ordinary task-list items, not a dedicated hierarchy view. Acceptable for V1.
- If the GitLab tier is later upgraded to Premium/Ultimate, `work_item.*` can migrate to the native Work Items API behind the same tool surface.
