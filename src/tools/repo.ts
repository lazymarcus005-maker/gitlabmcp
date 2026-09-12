/**
 * Branch + repository domain tools (tool-spec §Branch/§Repository, issue #7):
 * gitlab_branch_list/get/create/delete and gitlab_repository_tree/file_get.
 *
 * Branch guardrails (FR-10) live in the policy engine: gitlab_branch_create
 * declares `branchOperation: "create"` and gitlab_branch_delete
 * `branchOperation: "delete"`; the wrapper extracts the `branch` argument so
 * protected branches are denied (POLICY_BRANCH_PROTECTED) before any GitLab
 * call. gitlab_branch_delete is the first PRIVILEGED tool and requires the
 * `repo-write` scope (FR-7). List responses follow the pagination contract
 * (FR-12); large tree/file payloads are size-capped with `truncated: true`
 * (FR-13).
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { registerTool, resolveProjectArg } from "./register.js";
import { buildListResponse, resolveListRequest } from "../gitlab/pagination.js";
import { truncateFromStart } from "../gitlab/response.js";
import { getRequestScope } from "../context/request-scope.js";
import { ErrorCodes, GatewayError } from "../errors.js";

const REPO_WRITE = "repo-write" as const;

interface BranchRecord {
  name: string;
  [key: string]: unknown;
}

interface TreeEntry {
  id: string;
  type: string;
  path: string;
  [key: string]: unknown;
}

interface FileRecord {
  file_path?: string;
  content?: string;
  encoding?: string;
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

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function projectPath(project: string): string {
  return `/api/v4/projects/${encodeURIComponent(project)}`;
}

/** GitLab repository API requires URL-encoded paths for branches/files. */
function repoPath(...segments: string[]): string {
  return segments.map(encodeURIComponent).join("/");
}

/**
 * Lists a project's branches with the pagination contract. Omit `project`
 * to use the X-GitLab-Default-Project header.
 */
export function registerRepoTools(server: McpServer): void {
  registerTool(
    server,
    {
      name: "gitlab_branch_list",
      description:
        "Lists the branches of a project with optional search filter and pagination. " +
        "Omit `project` to use the X-GitLab-Default-Project header.",
      schema: {
        project: z.string().optional(),
        search: z.string().optional(),
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
      const params = new URLSearchParams({
        page: String(request.page),
        per_page: String(request.per_page),
      });
      const search = optionalString(args, "search");
      if (search) params.set("search", search);
      const response = await client.getWithHeaders<BranchRecord[]>(
        `${projectPath(project)}/repository/branches?${params.toString()}`,
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
      name: "gitlab_branch_get",
      description:
        "Returns a single branch by name. Omit `project` to use the X-GitLab-Default-Project header.",
      schema: {
        project: z.string().optional(),
        branch: z.string().min(1),
      },
      policy: { riskClass: "READ" },
    },
    async (ctx, args, client) => {
      const project = resolveProjectArg(ctx, args);
      const branch = optionalString(args, "branch");
      if (!branch) {
        throw new GatewayError(ErrorCodes.VALIDATION_ERROR, "missing required argument 'branch'");
      }
      return client.getJson<BranchRecord>(
        `${projectPath(project)}/repository/branches/${repoPath(branch)}`,
      );
    },
  );

  registerTool(
    server,
    {
      name: "gitlab_branch_create",
      description:
        "Creates a branch from `ref` (requires repo-write scope). Denied for protected " +
        "branches (main/master/uat/production by server policy). Omit `project` to use " +
        "the X-GitLab-Default-Project header.",
      schema: {
        project: z.string().optional(),
        branch: z.string().min(1),
        ref: z.string().min(1),
      },
      policy: { riskClass: "WRITE", requiredScope: REPO_WRITE, branchOperation: "create" },
    },
    async (ctx, args, client) => {
      const project = resolveProjectArg(ctx, args);
      return client.postJson<BranchRecord>(
        `${projectPath(project)}/repository/branches`,
        { branch: args.branch, ref: args.ref },
      );
    },
  );

  registerTool(
    server,
    {
      name: "gitlab_branch_delete",
      description:
        "Deletes a branch (PRIVILEGED — requires repo-write scope). Denied for protected " +
        "branches and for branches on the server's deny_direct_delete list. Omit `project` " +
        "to use the X-GitLab-Default-Project header.",
      schema: {
        project: z.string().optional(),
        branch: z.string().min(1),
      },
      policy: { riskClass: "PRIVILEGED", requiredScope: REPO_WRITE, branchOperation: "delete" },
    },
    async (ctx, args, client) => {
      const project = resolveProjectArg(ctx, args);
      const branch = optionalString(args, "branch");
      if (!branch) {
        throw new GatewayError(ErrorCodes.VALIDATION_ERROR, "missing required argument 'branch'");
      }
      const response = await client.getRaw(
        `${projectPath(project)}/repository/branches/${repoPath(branch)}`,
        { method: "DELETE" },
      );
      // GitLab answers 200 with an empty body on success.
      await response.arrayBuffer();
      return { branch, deleted: true };
    },
  );

  registerTool(
    server,
    {
      name: "gitlab_repository_tree",
      description:
        "Lists the files/directories of a repository tree with optional path, ref and " +
        "pagination. Large listings are size-capped with `truncated: true`. Omit `project` " +
        "to use the X-GitLab-Default-Project header.",
      schema: {
        project: z.string().optional(),
        path: z.string().optional(),
        ref: z.string().optional(),
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
      const params = new URLSearchParams({
        page: String(request.page),
        per_page: String(request.per_page),
      });
      const path = optionalString(args, "path");
      if (path) params.set("path", path);
      const ref = optionalString(args, "ref");
      if (ref) params.set("ref", ref);
      const response = await client.getWithHeaders<TreeEntry[]>(
        `${projectPath(project)}/repository/tree?${params.toString()}`,
      );
      const { items, pagination } = buildListResponse(
        response.data,
        request,
        response.headers,
      );
      // Size cap (FR-13): when the serialized listing exceeds max_bytes,
      // replace the items with the truncated serialization and flag it —
      // the pagination shape is preserved either way.
      const serialized = JSON.stringify(items);
      const shaped = truncateFromStart(serialized, {
        maxBytes: config.maxBytes,
        continuationHint:
          "listing exceeds the response size cap; narrow the result with `path` or `limit`",
      });
      if (!shaped.truncated) {
        return { items, pagination };
      }
      return {
        items_json: shaped.content,
        truncated: shaped.truncated,
        original_bytes: shaped.original_bytes,
        continuation_hint: shaped.continuation_hint,
        pagination,
      };
    },
  );

  registerTool(
    server,
    {
      name: "gitlab_repository_file_get",
      description:
        "Returns the decoded contents of a file at an optional ref. Files larger than the " +
        "response size cap are truncated with `truncated: true`. Omit `project` to use the " +
        "X-GitLab-Default-Project header.",
      schema: {
        project: z.string().optional(),
        file_path: z.string().optional(),
        ref: z.string().optional(),
      },
      policy: { riskClass: "READ" },
    },
    async (ctx, args, client) => {
      const config = getRequestScope().config;
      const project = resolveProjectArg(ctx, args);
      const filePath = optionalString(args, "file_path");
      if (!filePath) {
        throw new GatewayError(
          ErrorCodes.VALIDATION_ERROR,
          "missing required argument 'file_path'",
        );
      }
      const params = new URLSearchParams();
      const ref = optionalString(args, "ref");
      if (ref) params.set("ref", ref);
      const query = params.size > 0 ? `?${params.toString()}` : "";
      const file = await client.getJson<FileRecord>(
        `${projectPath(project)}/repository/files/${repoPath(filePath)}${query}`,
      );
      const raw = typeof file.content === "string" ? file.content : "";
      const decoded =
        file.encoding === "base64" ? Buffer.from(raw, "base64").toString("utf8") : raw;
      const shaped = truncateFromStart(decoded, {
        maxBytes: config.maxBytes,
        continuationHint:
          "file exceeds the response size cap; fetch a byte range via the GitLab API or narrow `ref`",
      });
      return {
        file_path: file.file_path ?? filePath,
        ref: ref ?? null,
        content: shaped.content,
        truncated: shaped.truncated,
        original_bytes: shaped.original_bytes,
        ...(shaped.continuation_hint !== undefined
          ? { continuation_hint: shaped.continuation_hint }
          : {}),
      };
    },
  );
}
