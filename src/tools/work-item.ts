/**
 * Work Item domain tools (tool-spec §Work Item, ADR-0003): on GitLab EE Free
 * a work item is an issue; parent–child hierarchy lives in task-list entries
 * (`- [ ] #<iid>`) in the parent's description and dependencies use the issue
 * links API. All WRITE tools require the `issue-write` scope (FR-7).
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { registerTool, resolveProjectArg } from "./register.js";
import { GatewayError, ErrorCodes } from "../errors.js";
import {
  parseTaskListEntries,
  appendChildEntry,
  removeChildEntry,
} from "../gitlab/tasklist.js";

const ISSUE_WRITE = "issue-write" as const;

interface IssueRecord {
  iid: number;
  title?: string;
  description?: string | null;
  [key: string]: unknown;
}

interface IssueLinkRecord {
  id: number;
  link_type?: string;
  source_issue?: { iid?: number };
  target_issue?: { iid?: number; project_id?: number; title?: string };
  [key: string]: unknown;
}

function issuePath(project: string, iid: string | number): string {
  return `/api/v4/projects/${encodeURIComponent(project)}/issues/${encodeURIComponent(String(iid))}`;
}

function validationError(message: string): GatewayError {
  return new GatewayError(ErrorCodes.VALIDATION_ERROR, message);
}

/** Fetches child issues' titles, skipping children that no longer exist. */
async function fetchChildTitles(
  client: ReturnType<typeof import("../gitlab/client-factory.js").createGitLabClient>,
  project: string,
  iids: number[],
): Promise<Array<{ iid: number; title?: string }>> {
  const children = await Promise.all(
    iids.map(async (iid) => {
      try {
        const child = await client.getJson<IssueRecord>(issuePath(project, iid));
        return { iid, title: child.title, exists: true };
      } catch {
        // Deleted child (or inaccessible): skip rather than fail the view.
        return { iid, title: undefined, exists: false };
      }
    }),
  );
  return children.filter((c) => c.exists);
}

export function registerWorkItemTools(server: McpServer): void {
  registerTool(
    server,
    {
      name: "gitlab_work_item_get",
      description:
        "Returns a work item (an issue on EE Free, ADR-0003) plus its parsed hierarchy " +
        "view (children from description task list) and dependency view (issue links). " +
        "Omit `project` to use the X-GitLab-Default-Project header.",
      schema: {
        project: z.string().optional(),
        iid: z.number(),
      },
      policy: { riskClass: "READ" },
    },
    async (ctx, args, client) => {
      const project = resolveProjectArg(ctx, args);
      const iid = args.iid as number;
      const issue = await client.getJson<IssueRecord>(issuePath(project, iid));
      const entries = parseTaskListEntries(issue.description);
      const iids = [...new Set(entries.map((e) => e.iid))];
      const children = await fetchChildTitles(client, project, iids);
      const hierarchy = entries.flatMap((entry) => {
        const child = children.find((c) => c.iid === entry.iid);
        return child ? [{ iid: entry.iid, title: child.title, checked: entry.checked }] : [];
      });
      let links: IssueLinkRecord[] = [];
      try {
        links = await client.getJson<IssueLinkRecord[]>(
          `${issuePath(project, iid)}/links?per_page=100`,
        );
      } catch {
        links = [];
      }
      return {
        issue,
        hierarchy,
        dependencies: links,
      };
    },
  );

  registerTool(
    server,
    {
      name: "gitlab_work_item_children",
      description:
        "Lists the children of a work item parsed from task-list entries " +
        "(`- [ ] #<iid>`) in its description, with child titles. Tolerant of hand " +
        "edits; deleted children are skipped. Omit `project` to use the " +
        "X-GitLab-Default-Project header.",
      schema: {
        project: z.string().optional(),
        iid: z.number(),
      },
      policy: { riskClass: "READ" },
    },
    async (ctx, args, client) => {
      const project = resolveProjectArg(ctx, args);
      const issue = await client.getJson<IssueRecord>(issuePath(project, args.iid as number));
      const entries = parseTaskListEntries(issue.description);
      const iids = [...new Set(entries.map((e) => e.iid))];
      const children = await fetchChildTitles(client, project, iids);
      return {
        items: entries.flatMap((entry) => {
          const child = children.find((c) => c.iid === entry.iid);
          return child ? [{ iid: entry.iid, title: child.title, checked: entry.checked }] : [];
        }),
      };
    },
  );

  registerTool(
    server,
    {
      name: "gitlab_work_item_add_child",
      description:
        "Appends `- [ ] #<child_iid>` to a work item's description, registering the " +
        "child in the parent–child task list (ADR-0003). Idempotent; existing " +
        "description content is preserved. Requires issue-write scope.",
      schema: {
        project: z.string().optional(),
        iid: z.number(),
        child_iid: z.number(),
      },
      policy: { riskClass: "WRITE", requiredScope: ISSUE_WRITE },
    },
    async (ctx, args, client) => {
      const project = resolveProjectArg(ctx, args);
      const iid = args.iid as number;
      const childIid = args.child_iid as number;
      if (iid === childIid) {
        throw validationError("a work item cannot be its own child (iid == child_iid)");
      }
      const issue = await client.getJson<IssueRecord>(issuePath(project, iid));
      const { description, changed } = appendChildEntry(issue.description, childIid);
      if (!changed) {
        return { issue, added: false, description };
      }
      const updated = await client.putJson<IssueRecord>(issuePath(project, iid), { description });
      return { issue: updated, added: true, description };
    },
  );

  registerTool(
    server,
    {
      name: "gitlab_work_item_remove_child",
      description:
        "Removes the task-list entry for `child_iid` from a work item's description " +
        "(ADR-0003). Only the matching entry line is removed; absence is an " +
        "idempotent success. Requires issue-write scope.",
      schema: {
        project: z.string().optional(),
        iid: z.number(),
        child_iid: z.number(),
      },
      policy: { riskClass: "WRITE", requiredScope: ISSUE_WRITE },
    },
    async (ctx, args, client) => {
      const project = resolveProjectArg(ctx, args);
      const iid = args.iid as number;
      const childIid = args.child_iid as number;
      if (iid === childIid) {
        throw validationError("a work item cannot be its own child (iid == child_iid)");
      }
      const issue = await client.getJson<IssueRecord>(issuePath(project, iid));
      const { description, changed } = removeChildEntry(issue.description, childIid);
      if (!changed) {
        return { issue, removed: false, description: issue.description ?? "" };
      }
      const updated = await client.putJson<IssueRecord>(issuePath(project, iid), { description });
      return { issue: updated, removed: true, description };
    },
  );

  registerTool(
    server,
    {
      name: "gitlab_work_item_link",
      description:
        "Creates a dependency link between two work items via the GitLab issue links " +
        "API (ADR-0003). link_type is `blocks` or `is_blocked_by`. V1 is same-project " +
        "only; self-linking is rejected. Requires issue-write scope.",
      schema: {
        project: z.string().optional(),
        iid: z.number(),
        target_iid: z.number(),
        link_type: z.enum(["blocks", "is_blocked_by"]),
        target_project: z.string().optional(),
      },
      policy: { riskClass: "WRITE", requiredScope: ISSUE_WRITE },
    },
    async (ctx, args, client) => {
      const project = resolveProjectArg(ctx, args);
      const iid = args.iid as number;
      const targetIid = args.target_iid as number;
      if (iid === targetIid) {
        throw validationError("a work item cannot be linked to itself (iid == target_iid)");
      }
      const targetProject = typeof args.target_project === "string" ? args.target_project : project;
      if (targetProject !== project) {
        throw validationError(
          "cross-project links are not supported in V1 (target_project must equal project)",
        );
      }
      return client.postJson<IssueLinkRecord>(`${issuePath(project, iid)}/links`, {
        target_project_id: project,
        target_issue_iid: targetIid,
        link_type: args.link_type,
      });
    },
  );

  registerTool(
    server,
    {
      name: "gitlab_work_item_unlink",
      description:
        "Removes the dependency link between a work item and `target_iid` via the " +
        "GitLab issue links API (ADR-0003). Absence of a link is an idempotent " +
        "success. Requires issue-write scope.",
      schema: {
        project: z.string().optional(),
        iid: z.number(),
        target_iid: z.number(),
      },
      policy: { riskClass: "WRITE", requiredScope: ISSUE_WRITE },
    },
    async (ctx, args, client) => {
      const project = resolveProjectArg(ctx, args);
      const iid = args.iid as number;
      const targetIid = args.target_iid as number;
      if (iid === targetIid) {
        throw validationError("a work item cannot be unlinked from itself (iid == target_iid)");
      }
      const links = await client.getJson<IssueLinkRecord[]>(
        `${issuePath(project, iid)}/links?per_page=100`,
      );
      const link = links.find((l) => {
        const other =
          l.target_issue?.iid === targetIid
            ? l.target_issue
            : l.source_issue?.iid === targetIid
              ? l.source_issue
              : undefined;
        return other !== undefined;
      });
      if (!link) {
        return { unlinked: false };
      }
      await client.deleteJson<unknown>(
        `${issuePath(project, iid)}/links/${encodeURIComponent(String(link.id))}`,
      );
      return { unlinked: true, link_id: link.id };
    },
  );
}
