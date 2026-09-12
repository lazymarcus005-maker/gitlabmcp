/**
 * Issue domain tools (tool-spec §Issue): gitlab_issue_list, gitlab_issue_get,
 * gitlab_issue_create, gitlab_issue_update, gitlab_issue_close,
 * gitlab_issue_reopen and gitlab_issue_comment. This is the first WRITE path
 * through the policy engine: every mutating tool declares
 * `requiredScope: "issue-write"` (FR-7) and READ tools declare none.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { registerTool, resolveProjectArg } from "./register.js";
import { buildListResponse, resolveListRequest } from "../gitlab/pagination.js";
import { getRequestScope } from "../context/request-scope.js";

const ISSUE_WRITE = "issue-write" as const;

interface IssueRecord {
  iid: number;
  [key: string]: unknown;
}

function listArgs(args: Record<string, unknown>): {
  limit?: number;
  cursor?: string;
} {
  return {
    limit: typeof args.limit === "number" ? args.limit : undefined,
    cursor: typeof args.cursor === "string" ? args.cursor : undefined,
  };
}

/** Extracts an optional string argument (empty/whitespace → undefined). */
function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function issuesPath(project: string): string {
  return `/api/v4/projects/${encodeURIComponent(project)}/issues`;
}

function issuePath(project: string, iid: string | number): string {
  return `/api/v4/projects/${encodeURIComponent(project)}/issues/${encodeURIComponent(String(iid))}`;
}

export function registerIssueTools(server: McpServer): void {
  registerTool(
    server,
    {
      name: "gitlab_issue_list",
      description:
        "Lists issues of a project with optional state/labels/search/assignee filters. " +
        "Omit `project` to use the X-GitLab-Default-Project header. Supports pagination.",
      schema: {
        project: z.string().optional(),
        state: z.enum(["opened", "closed", "all"]).optional(),
        labels: z.string().optional(),
        search: z.string().optional(),
        assignee: z.string().optional(),
        limit: z.number().optional(),
        cursor: z.string().optional(),
      },
      policy: { riskClass: "READ" },
    },
    async (_ctx, args, client) => {
      const config = getRequestScope().config;
      const project = resolveProjectArg(_ctx, args);
      const request = resolveListRequest(listArgs(args), {
        defaultLimit: config.paginationDefaultLimit,
        maxLimit: config.paginationMaxLimit,
      });
      const params = new URLSearchParams({
        page: String(request.page),
        per_page: String(request.per_page),
      });
      const state = optionalString(args, "state");
      if (state && state !== "all") params.set("state", state);
      const labels = optionalString(args, "labels");
      if (labels) params.set("labels", labels);
      const search = optionalString(args, "search");
      if (search) params.set("search", search);
      const assignee = optionalString(args, "assignee");
      if (assignee) params.set("assignee_username", assignee);
      const response = await client.getWithHeaders<IssueRecord[]>(
        `${issuesPath(project)}?${params.toString()}`,
      );
      const { items, pagination } = buildListResponse(
        response.data,
        request,
        response.headers,
      );
      return { items, pagination };
    },
  );

  registerTool(
    server,
    {
      name: "gitlab_issue_get",
      description:
        "Returns a single issue by iid. Omit `project` to use the X-GitLab-Default-Project header.",
      schema: {
        project: z.string().optional(),
        iid: z.number(),
      },
      policy: { riskClass: "READ" },
    },
    async (ctx, args, client) => {
      const project = resolveProjectArg(ctx, args);
      return client.getJson<IssueRecord>(issuePath(project, args.iid as number));
    },
  );

  registerTool(
    server,
    {
      name: "gitlab_issue_create",
      description:
        "Creates an issue (requires issue-write scope). Omit `project` to use the " +
        "X-GitLab-Default-Project header.",
      schema: {
        project: z.string().optional(),
        title: z.string().min(1),
        description: z.string().optional(),
        labels: z.string().optional(),
        assignee_ids: z.array(z.number()).optional(),
      },
      policy: { riskClass: "WRITE", requiredScope: ISSUE_WRITE },
    },
    async (ctx, args, client) => {
      const project = resolveProjectArg(ctx, args);
      const body: Record<string, unknown> = { title: args.title };
      const description = optionalString(args, "description");
      if (description !== undefined) body.description = description;
      const labels = optionalString(args, "labels");
      if (labels !== undefined) body.labels = labels;
      if (Array.isArray(args.assignee_ids)) body.assignee_ids = args.assignee_ids;
      return client.postJson<IssueRecord>(issuesPath(project), body);
    },
  );

  registerTool(
    server,
    {
      name: "gitlab_issue_update",
      description:
        "Updates an issue's title, description, labels or state (requires issue-write scope). " +
        "Omit `project` to use the X-GitLab-Default-Project header.",
      schema: {
        project: z.string().optional(),
        iid: z.number(),
        title: z.string().optional(),
        description: z.string().optional(),
        labels: z.string().optional(),
        state_event: z.enum(["close", "reopen"]).optional(),
      },
      policy: { riskClass: "WRITE", requiredScope: ISSUE_WRITE },
    },
    async (ctx, args, client) => {
      const project = resolveProjectArg(ctx, args);
      const body: Record<string, unknown> = {};
      const title = optionalString(args, "title");
      if (title !== undefined) body.title = title;
      const description = optionalString(args, "description");
      if (description !== undefined) body.description = description;
      const labels = optionalString(args, "labels");
      if (labels !== undefined) body.labels = labels;
      const stateEvent = optionalString(args, "state_event");
      if (stateEvent !== undefined) body.state_event = stateEvent;
      return client.postJson<IssueRecord>(issuePath(project, args.iid as number), body);
    },
  );

  registerTool(
    server,
    {
      name: "gitlab_issue_close",
      description:
        "Closes an issue (requires issue-write scope). Omit `project` to use the " +
        "X-GitLab-Default-Project header.",
      schema: {
        project: z.string().optional(),
        iid: z.number(),
      },
      policy: { riskClass: "WRITE", requiredScope: ISSUE_WRITE },
    },
    async (ctx, args, client) => {
      const project = resolveProjectArg(ctx, args);
      return client.postJson<IssueRecord>(issuePath(project, args.iid as number), {
        state_event: "close",
      });
    },
  );

  registerTool(
    server,
    {
      name: "gitlab_issue_reopen",
      description:
        "Reopens a closed issue (requires issue-write scope). Omit `project` to use the " +
        "X-GitLab-Default-Project header.",
      schema: {
        project: z.string().optional(),
        iid: z.number(),
      },
      policy: { riskClass: "WRITE", requiredScope: ISSUE_WRITE },
    },
    async (ctx, args, client) => {
      const project = resolveProjectArg(ctx, args);
      return client.postJson<IssueRecord>(issuePath(project, args.iid as number), {
        state_event: "reopen",
      });
    },
  );

  registerTool(
    server,
    {
      name: "gitlab_issue_comment",
      description:
        "Adds a comment (note) to an issue (requires issue-write scope). Omit `project` " +
        "to use the X-GitLab-Default-Project header.",
      schema: {
        project: z.string().optional(),
        iid: z.number(),
        body: z.string().min(1),
      },
      policy: { riskClass: "WRITE", requiredScope: ISSUE_WRITE },
    },
    async (ctx, args, client) => {
      const project = resolveProjectArg(ctx, args);
      return client.postJson<Record<string, unknown>>(
        `${issuePath(project, args.iid as number)}/notes`,
        { body: args.body },
      );
    },
  );
}
