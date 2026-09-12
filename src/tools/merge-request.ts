/**
 * Merge request domain tools (tool-spec §Merge Request, issue #8):
 * gitlab_mr_list, gitlab_mr_get, gitlab_mr_create, gitlab_mr_update,
 * gitlab_mr_diff, gitlab_mr_comment and gitlab_mr_merge. WRITE tools declare
 * `requiredScope: "mr-write"` (FR-7); gitlab_mr_merge is PRIVILEGED and
 * requires the dedicated `mr-merge` scope, distinct from mr-write — the
 * policy engine rejects a caller holding mr-write without mr-merge.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { registerTool, resolveProjectArg } from "./register.js";
import { buildListResponse, resolveListRequest } from "../gitlab/pagination.js";
import { truncateFromStart } from "../gitlab/response.js";
import { getRequestScope } from "../context/request-scope.js";

const MR_WRITE = "mr-write" as const;
const MR_MERGE = "mr-merge" as const;

interface MergeRequestRecord {
  iid: number;
  [key: string]: unknown;
}

interface DiffFile {
  old_path?: string;
  new_path?: string;
  diff?: string;
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

function mergeRequestsPath(project: string): string {
  return `/api/v4/projects/${encodeURIComponent(project)}/merge_requests`;
}

function mergeRequestPath(project: string, iid: number): string {
  return `/api/v4/projects/${encodeURIComponent(project)}/merge_requests/${encodeURIComponent(String(iid))}`;
}

export function registerMergeRequestTools(server: McpServer): void {
  registerTool(
    server,
    {
      name: "gitlab_mr_list",
      description:
        "Lists merge requests of a project with optional state and target_branch filters. " +
        "Omit `project` to use the X-GitLab-Default-Project header. Supports pagination.",
      schema: {
        project: z.string().optional(),
        state: z.enum(["opened", "closed", "merged", "all"]).optional(),
        target_branch: z.string().optional(),
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
      const targetBranch = optionalString(args, "target_branch");
      if (targetBranch) params.set("target_branch", targetBranch);
      const response = await client.getWithHeaders<MergeRequestRecord[]>(
        `${mergeRequestsPath(project)}?${params.toString()}`,
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
      name: "gitlab_mr_get",
      description:
        "Returns a single merge request by iid. Omit `project` to use the " +
        "X-GitLab-Default-Project header.",
      schema: {
        project: z.string().optional(),
        mr_iid: z.number(),
      },
      policy: { riskClass: "READ" },
    },
    async (ctx, args, client) => {
      const project = resolveProjectArg(ctx, args);
      return client.getJson<MergeRequestRecord>(
        mergeRequestPath(project, args.mr_iid as number),
      );
    },
  );

  registerTool(
    server,
    {
      name: "gitlab_mr_create",
      description:
        "Opens a merge request from source_branch into target_branch (requires mr-write " +
        "scope). Omit `project` to use the X-GitLab-Default-Project header.",
      schema: {
        project: z.string().optional(),
        source_branch: z.string().min(1),
        target_branch: z.string().min(1),
        title: z.string().min(1),
        description: z.string().optional(),
        remove_source_branch: z.boolean().optional(),
      },
      policy: { riskClass: "WRITE", requiredScope: MR_WRITE },
    },
    async (ctx, args, client) => {
      const project = resolveProjectArg(ctx, args);
      const body: Record<string, unknown> = {
        source_branch: args.source_branch,
        target_branch: args.target_branch,
        title: args.title,
      };
      const description = optionalString(args, "description");
      if (description !== undefined) body.description = description;
      if (typeof args.remove_source_branch === "boolean") {
        body.remove_source_branch = args.remove_source_branch;
      }
      return client.postJson<MergeRequestRecord>(mergeRequestsPath(project), body);
    },
  );

  registerTool(
    server,
    {
      name: "gitlab_mr_update",
      description:
        "Updates a merge request's title, description or state_event (close/reopen) " +
        "(requires mr-write scope). Omit `project` to use the X-GitLab-Default-Project header.",
      schema: {
        project: z.string().optional(),
        mr_iid: z.number(),
        title: z.string().optional(),
        description: z.string().optional(),
        state_event: z.enum(["close", "reopen"]).optional(),
      },
      policy: { riskClass: "WRITE", requiredScope: MR_WRITE },
    },
    async (ctx, args, client) => {
      const project = resolveProjectArg(ctx, args);
      const body: Record<string, unknown> = {};
      const title = optionalString(args, "title");
      if (title !== undefined) body.title = title;
      const description = optionalString(args, "description");
      if (description !== undefined) body.description = description;
      const stateEvent = optionalString(args, "state_event");
      if (stateEvent !== undefined) body.state_event = stateEvent;
      return client.putJson<MergeRequestRecord>(
        mergeRequestPath(project, args.mr_iid as number),
        body,
      );
    },
  );

  registerTool(
    server,
    {
      name: "gitlab_mr_diff",
      description:
        "Returns the per-file diffs of a merge request. Small payloads keep the per-file " +
        "list structure; payloads over the configured size cap (GITLAB_MCP_MAX_BYTES) are " +
        "truncated from the START into a single joined diff text with truncated:true and a " +
        "continuation hint. Omit `project` to use the X-GitLab-Default-Project header.",
      schema: {
        project: z.string().optional(),
        mr_iid: z.number(),
      },
      policy: { riskClass: "READ" },
    },
    async (ctx, args, client) => {
      const project = resolveProjectArg(ctx, args);
      const config = getRequestScope().config;
      const files = await client.getJson<DiffFile[]>(
        `${mergeRequestPath(project, args.mr_iid as number)}/diffs`,
      );
      // Keep the per-file list structure when the serialized output fits the
      // size cap; otherwise fall back to truncating the joined diff text from
      // the start (FR-13) so the latest content survives.
      const serialized = JSON.stringify(files, null, 2);
      if (Buffer.byteLength(serialized, "utf8") <= config.maxBytes) {
        return { files, truncated: false };
      }
      const joined = files
        .map((f) => `--- a/${f.old_path ?? ""}\n+++ b/${f.new_path ?? ""}\n${f.diff ?? ""}`)
        .join("\n");
      const shaped = truncateFromStart(joined, {
        maxBytes: config.maxBytes,
        continuationHint:
          "diff truncated from the start; narrow the MR or fetch individual file diffs for full content",
      });
      return { ...shaped, file_count: files.length };
    },
  );

  registerTool(
    server,
    {
      name: "gitlab_mr_comment",
      description:
        "Adds a comment (note) to a merge request (requires mr-write scope). Omit " +
        "`project` to use the X-GitLab-Default-Project header.",
      schema: {
        project: z.string().optional(),
        mr_iid: z.number(),
        body: z.string().min(1),
      },
      policy: { riskClass: "WRITE", requiredScope: MR_WRITE },
    },
    async (ctx, args, client) => {
      const project = resolveProjectArg(ctx, args);
      return client.postJson<Record<string, unknown>>(
        `${mergeRequestPath(project, args.mr_iid as number)}/notes`,
        { body: args.body },
      );
    },
  );

  registerTool(
    server,
    {
      name: "gitlab_mr_merge",
      description:
        "Merges a merge request. PRIVILEGED: requires the dedicated mr-merge scope " +
        "(mr-write is NOT sufficient) and server policy allow. Omit `project` to use the " +
        "X-GitLab-Default-Project header.",
      schema: {
        project: z.string().optional(),
        mr_iid: z.number(),
        merge_when_pipeline_succeeds: z.boolean().optional(),
      },
      policy: { riskClass: "PRIVILEGED", requiredScope: MR_MERGE },
    },
    async (ctx, args, client) => {
      const project = resolveProjectArg(ctx, args);
      const body: Record<string, unknown> = {};
      if (typeof args.merge_when_pipeline_succeeds === "boolean") {
        body.merge_when_pipeline_succeeds = args.merge_when_pipeline_succeeds;
      }
      return client.putJson<MergeRequestRecord>(
        `${mergeRequestPath(project, args.mr_iid as number)}/merge`,
        body,
      );
    },
  );
}
