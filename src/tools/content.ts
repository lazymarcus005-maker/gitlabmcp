/**
 * Content-domain tools (tool-spec §Milestone/§Wiki/§Label, issue #10):
 * gitlab_milestone_list/get/create/update, gitlab_wiki_list/get/create/update
 * and gitlab_label_list/create. Every mutating tool declares
 * `requiredScope: "project-write"` (FR-7); READ tools declare none. Milestone
 * list/get accept an optional `group` argument to target group-level
 * milestones (/groups/:id/milestones) instead of project endpoints.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { registerTool, resolveProjectArg } from "./register.js";
import { buildListResponse, resolveListRequest } from "../gitlab/pagination.js";
import { getRequestScope } from "../context/request-scope.js";
import { GatewayError, ErrorCodes } from "../errors.js";
import type { GitLabRequestContext } from "../context/request-context.js";

const PROJECT_WRITE = "project-write" as const;

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

function encoded(value: string): string {
  return encodeURIComponent(value);
}

/** Resolves the optional `group` argument with the request default fallback. */
function resolveGroupArg(ctx: GitLabRequestContext, args: Record<string, unknown>): string {
  const group = optionalString(args, "group") ?? ctx.defaults?.group;
  if (!group) {
    throw new GatewayError(
      ErrorCodes.VALIDATION_ERROR,
      "missing required argument 'group' (and no X-GitLab-Default-Group header)",
    );
  }
  return group;
}

export function registerContentTools(server: McpServer): void {
  // ---------------------------------------------------------------- Milestone
  registerTool(
    server,
    {
      name: "gitlab_milestone_list",
      description:
        "Lists milestones of a project. Pass `group` to list group milestones instead " +
        "(/groups/:id/milestones). Omit `project` to use the X-GitLab-Default-Project header. " +
        "Supports pagination.",
      schema: {
        project: z.string().optional(),
        group: z.string().optional(),
        state: z.enum(["active", "closed", "all"]).optional(),
        limit: z.number().optional(),
        cursor: z.string().optional(),
      },
      policy: { riskClass: "READ" },
    },
    async (ctx, args, client) => {
      const group = optionalString(args, "group") ?? ctx.defaults?.group;
      const path = group
        ? `/api/v4/groups/${encoded(group)}/milestones`
        : `/api/v4/projects/${encoded(resolveProjectArg(ctx, args))}/milestones`;
      const config = getRequestScope().config;
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
      const response = await client.getWithHeaders<Record<string, unknown>[]>(
        `${path}?${params.toString()}`,
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
      name: "gitlab_milestone_get",
      description:
        "Returns a single milestone by id. Pass `group` to fetch a group milestone instead. " +
        "Omit `project` to use the X-GitLab-Default-Project header.",
      schema: {
        project: z.string().optional(),
        group: z.string().optional(),
        milestone_id: z.number(),
      },
      policy: { riskClass: "READ" },
    },
    async (ctx, args, client) => {
      const group = optionalString(args, "group") ?? ctx.defaults?.group;
      const id = encoded(String(args.milestone_id as number));
      const path = group
        ? `/api/v4/groups/${encoded(group)}/milestones/${id}`
        : `/api/v4/projects/${encoded(resolveProjectArg(ctx, args))}/milestones/${id}`;
      return client.getJson<Record<string, unknown>>(path);
    },
  );

  registerTool(
    server,
    {
      name: "gitlab_milestone_create",
      description:
        "Creates a project milestone (requires project-write scope). Omit `project` to use " +
        "the X-GitLab-Default-Project header.",
      schema: {
        project: z.string().optional(),
        title: z.string().min(1),
        description: z.string().optional(),
        due_date: z.string().optional(),
        start_date: z.string().optional(),
      },
      policy: { riskClass: "WRITE", requiredScope: PROJECT_WRITE },
    },
    async (ctx, args, client) => {
      const project = resolveProjectArg(ctx, args);
      const body: Record<string, unknown> = { title: args.title };
      for (const key of ["description", "due_date", "start_date"]) {
        const value = optionalString(args, key);
        if (value !== undefined) body[key] = value;
      }
      return client.postJson<Record<string, unknown>>(
        `/api/v4/projects/${encoded(project)}/milestones`,
        body,
      );
    },
  );

  registerTool(
    server,
    {
      name: "gitlab_milestone_update",
      description:
        "Updates a project milestone's title, dates or state (requires project-write scope). " +
        "state_event accepts 'activate' or 'close'. Omit `project` to use the " +
        "X-GitLab-Default-Project header.",
      schema: {
        project: z.string().optional(),
        milestone_id: z.number(),
        title: z.string().optional(),
        description: z.string().optional(),
        due_date: z.string().optional(),
        start_date: z.string().optional(),
        state_event: z.enum(["activate", "close"]).optional(),
      },
      policy: { riskClass: "WRITE", requiredScope: PROJECT_WRITE },
    },
    async (ctx, args, client) => {
      const project = resolveProjectArg(ctx, args);
      const body: Record<string, unknown> = {};
      for (const key of ["title", "description", "due_date", "start_date", "state_event"]) {
        const value = optionalString(args, key);
        if (value !== undefined) body[key] = value;
      }
      return client.putJson<Record<string, unknown>>(
        `/api/v4/projects/${encoded(project)}/milestones/${encoded(String(args.milestone_id as number))}`,
        body,
      );
    },
  );

  // --------------------------------------------------------------------- Wiki
  registerTool(
    server,
    {
      name: "gitlab_wiki_list",
      description:
        "Lists wiki pages of a project. Omit `project` to use the X-GitLab-Default-Project " +
        "header. Supports pagination.",
      schema: {
        project: z.string().optional(),
        limit: z.number().optional(),
        cursor: z.string().optional(),
      },
      policy: { riskClass: "READ" },
    },
    async (ctx, args, client) => {
      const project = resolveProjectArg(ctx, args);
      const config = getRequestScope().config;
      const request = resolveListRequest(listArgs(args), {
        defaultLimit: config.paginationDefaultLimit,
        maxLimit: config.paginationMaxLimit,
      });
      const params = new URLSearchParams({
        page: String(request.page),
        per_page: String(request.per_page),
      });
      const response = await client.getWithHeaders<Record<string, unknown>[]>(
        `/api/v4/projects/${encoded(project)}/wikis?${params.toString()}`,
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
      name: "gitlab_wiki_get",
      description:
        "Returns a single wiki page by slug. Omit `project` to use the X-GitLab-Default-Project " +
        "header.",
      schema: {
        project: z.string().optional(),
        slug: z.string().min(1),
      },
      policy: { riskClass: "READ" },
    },
    async (ctx, args, client) => {
      const project = resolveProjectArg(ctx, args);
      return client.getJson<Record<string, unknown>>(
        `/api/v4/projects/${encoded(project)}/wikis/${encoded(args.slug as string)}`,
      );
    },
  );

  registerTool(
    server,
    {
      name: "gitlab_wiki_create",
      description:
        "Creates a wiki page (requires project-write scope). Omit `project` to use the " +
        "X-GitLab-Default-Project header.",
      schema: {
        project: z.string().optional(),
        title: z.string().min(1),
        content: z.string().min(1),
        format: z.enum(["markdown", "rdoc"]).optional(),
      },
      policy: { riskClass: "WRITE", requiredScope: PROJECT_WRITE },
    },
    async (ctx, args, client) => {
      const project = resolveProjectArg(ctx, args);
      const body: Record<string, unknown> = {
        title: args.title,
        content: args.content,
      };
      const format = optionalString(args, "format");
      if (format !== undefined) body.format = format;
      return client.postJson<Record<string, unknown>>(
        `/api/v4/projects/${encoded(project)}/wikis`,
        body,
      );
    },
  );

  registerTool(
    server,
    {
      name: "gitlab_wiki_update",
      description:
        "Updates a wiki page's title or content (requires project-write scope). Omit `project` " +
        "to use the X-GitLab-Default-Project header.",
      schema: {
        project: z.string().optional(),
        slug: z.string().min(1),
        title: z.string().optional(),
        content: z.string().optional(),
      },
      policy: { riskClass: "WRITE", requiredScope: PROJECT_WRITE },
    },
    async (ctx, args, client) => {
      const project = resolveProjectArg(ctx, args);
      const body: Record<string, unknown> = {};
      for (const key of ["title", "content"]) {
        const value = optionalString(args, key);
        if (value !== undefined) body[key] = value;
      }
      return client.putJson<Record<string, unknown>>(
        `/api/v4/projects/${encoded(project)}/wikis/${encoded(args.slug as string)}`,
        body,
      );
    },
  );

  // -------------------------------------------------------------------- Label
  registerTool(
    server,
    {
      name: "gitlab_label_list",
      description:
        "Lists labels of a project. Omit `project` to use the X-GitLab-Default-Project header. " +
        "Supports pagination.",
      schema: {
        project: z.string().optional(),
        limit: z.number().optional(),
        cursor: z.string().optional(),
      },
      policy: { riskClass: "READ" },
    },
    async (ctx, args, client) => {
      const project = resolveProjectArg(ctx, args);
      const config = getRequestScope().config;
      const request = resolveListRequest(listArgs(args), {
        defaultLimit: config.paginationDefaultLimit,
        maxLimit: config.paginationMaxLimit,
      });
      const params = new URLSearchParams({
        page: String(request.page),
        per_page: String(request.per_page),
      });
      const response = await client.getWithHeaders<Record<string, unknown>[]>(
        `/api/v4/projects/${encoded(project)}/labels?${params.toString()}`,
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
      name: "gitlab_label_create",
      description:
        "Creates a project label (requires project-write scope). color is a hex value " +
        "(e.g. #FF0000). Omit `project` to use the X-GitLab-Default-Project header.",
      schema: {
        project: z.string().optional(),
        name: z.string().min(1),
        color: z.string().regex(/^#[0-9a-fA-F]{6}$/, "color must be a hex value like #FF0000"),
        description: z.string().optional(),
        priority: z.number().optional(),
      },
      policy: { riskClass: "WRITE", requiredScope: PROJECT_WRITE },
    },
    async (ctx, args, client) => {
      const project = resolveProjectArg(ctx, args);
      const body: Record<string, unknown> = { name: args.name, color: args.color };
      const description = optionalString(args, "description");
      if (description !== undefined) body.description = description;
      if (typeof args.priority === "number") body.priority = args.priority;
      return client.postJson<Record<string, unknown>>(
        `/api/v4/projects/${encoded(project)}/labels`,
        body,
      );
    },
  );
}
