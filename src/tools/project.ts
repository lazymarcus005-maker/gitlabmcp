/**
 * Project domain tools (tool-spec §Project): gitlab_project_get,
 * gitlab_project_list and gitlab_project_members — all READ.
 *
 * gitlab_project_list is the Project Scope showcase (FR-8): its results are
 * ALWAYS filtered through the request's `X-GitLab-Project-Scope` patterns.
 * GitLab's list API cannot express our glob semantics, so filtering is done
 * client-side after each fetch: pages are requested until either the limit
 * is met, GitLab reports no further pages (x-next-page empty), or a
 * pragmatic safety cap of 10 pages per response is reached. A page that
 * yields only out-of-scope projects therefore does NOT terminate the
 * listing prematurely; the cap bounds the work per call and a continuation
 * cursor lets the caller page past it.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { registerTool, resolveProjectArg } from "./register.js";
import { projectMatchesScope } from "../security/scope.js";
import {
  buildListResponse,
  encodeCursor,
  hasMoreFromHeaders,
  resolveListRequest,
} from "../gitlab/pagination.js";
import { getRequestScope } from "../context/request-scope.js";
import type { GitLabRequestContext } from "../context/request-context.js";
import type { GitLabClient } from "../gitlab/client-factory.js";
import type { HeaderBag } from "../gitlab/pagination.js";

/** Safety cap on pages fetched per list call while scope-filtering. */
const MAX_PAGES_PER_CALL = 10;

interface ProjectSummary {
  id: number;
  path_with_namespace?: string;
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

function inScope(project: ProjectSummary, patterns: string[] | undefined): boolean {
  if (!patterns || patterns.length === 0) return true;
  const path = project.path_with_namespace;
  return typeof path === "string" && projectMatchesScope(path, patterns);
}

/**
 * Lists GitLab projects (or a group's projects) filtered by Project Scope.
 * See the module docblock for the client-side filtering / page cap contract.
 */
async function listProjects(
  ctx: GitLabRequestContext,
  args: Record<string, unknown>,
  client: GitLabClient,
  basePath: string,
): Promise<Record<string, unknown>> {
  const config = getRequestScope().config;
  const request = resolveListRequest(listArgs(args), {
    defaultLimit: config.paginationDefaultLimit,
    maxLimit: config.paginationMaxLimit,
  });
  const search = typeof args.search === "string" ? args.search : undefined;
  const patterns = ctx.projectScope;

  const params = new URLSearchParams({ per_page: String(request.per_page) });
  if (search) params.set("search", search);

  const items: ProjectSummary[] = [];
  let page = request.page;
  let lastFetchedPage = page - 1;
  let morePages = false;
  let pagesFetched = 0;
  let lastHeaders: import("../gitlab/pagination.js").HeaderBag | undefined;

  while (pagesFetched < MAX_PAGES_PER_CALL) {
    params.set("page", String(page));
    const response = await client.getWithHeaders<ProjectSummary[]>(
      `${basePath}?${params.toString()}`,
    );
    lastHeaders = response.headers;
    for (const project of response.data) {
      if (inScope(project, patterns)) items.push(project);
    }
    lastFetchedPage = page;
    morePages = hasMoreFromHeaders(response.headers, page, request.per_page, response.data.length);
    pagesFetched += 1;
    if (items.length >= request.per_page) break;
    if (!morePages) break;
    page += 1;
  }

  const hasMore = lastHeaders === undefined ? false : morePages;
  const result: Record<string, unknown> = {
    items: items.slice(0, request.per_page),
    pagination: {
      has_more: hasMore,
      next_cursor: hasMore
        ? encodeCursor({ page: lastFetchedPage + 1, per_page: request.per_page })
        : null,
    },
  };
  return result;
}

export function registerProjectTools(server: McpServer): void {
  registerTool(
    server,
    {
      name: "gitlab_project_get",
      description:
        "Returns project metadata (default branch, visibility, path_with_namespace, ...). " +
        "Omit `project` to use the X-GitLab-Default-Project header.",
      schema: { project: z.string().optional() },
      policy: { riskClass: "READ" },
    },
    async (ctx, args, client) => {
      const project = resolveProjectArg(ctx, args);
      return client.getJson(`/api/v4/projects/${encodeURIComponent(project)}`);
    },
  );

  registerTool(
    server,
    {
      name: "gitlab_project_list",
      description:
        "Lists projects visible to the token, ALWAYS filtered by the request's Project Scope. " +
        "Supports `search`, an optional `group` to list a group's projects, and pagination.",
      schema: {
        search: z.string().optional(),
        group: z.string().optional(),
        limit: z.number().optional(),
        cursor: z.string().optional(),
      },
      policy: { riskClass: "READ" },
    },
    async (ctx, args, client) => {
      const group = typeof args.group === "string" ? args.group : undefined;
      const basePath = group
        ? `/api/v4/groups/${encodeURIComponent(group)}/projects`
        : "/api/v4/projects";
      return listProjects(ctx, args, client, basePath);
    },
  );

  registerTool(
    server,
    {
      name: "gitlab_project_members",
      description:
        "Lists the members of a project. Omit `project` to use the X-GitLab-Default-Project header.",
      schema: {
        project: z.string().optional(),
        limit: z.number().optional(),
        cursor: z.string().optional(),
      },
      policy: { riskClass: "READ" },
    },
    async (ctx, args, client) => {
      const config = getRequestScope().config;
      const project = resolveProjectArg(ctx, args);
      const request = resolveListRequest(listArgs(args), {
        defaultLimit: config.paginationDefaultLimit,
        maxLimit: config.paginationMaxLimit,
      });
      const response = await client.getWithHeaders<Record<string, unknown>[]>(
        `/api/v4/projects/${encodeURIComponent(project)}/members` +
          `?page=${request.page}&per_page=${request.per_page}`,
      );
      const { items, pagination } = buildListResponse(
        response.data,
        request,
        response.headers,
      );
      return { items, pagination };
    },
  );
}
