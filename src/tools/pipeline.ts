/**
 * Pipeline + job domain tools (tool-spec §Pipeline & Job, issue #9):
 * gitlab_pipeline_list/get/retry/cancel and gitlab_job_list/get/trace.
 *
 * Retry/cancel mutate CI state and require the `pipeline-write` scope (FR-7);
 * everything else is READ. Job paths (job_list/job_get/job_trace) use the
 * relaxed 60 s timeout (FR-14, config.jobTimeoutMs) via the per-call
 * timeoutMs override. Job traces (FR-13) are size-capped with
 * `truncated: true` and an `offset` continuation: the returned window starts
 * at `offset` bytes into the trace and `next_offset = offset + bytes
 * returned`, so callers resume exactly where the returned window ends.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { registerTool, resolveProjectArg } from "./register.js";
import { buildListResponse, resolveListRequest } from "../gitlab/pagination.js";
import { getRequestScope } from "../context/request-scope.js";
import { ErrorCodes, GatewayError } from "../errors.js";

const PIPELINE_WRITE = "pipeline-write" as const;

interface PipelineRecord {
  id: number;
  [key: string]: unknown;
}

interface JobRecord {
  id: number;
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

/** Positive-integer id argument; anything else is a VALIDATION_ERROR. */
function requireId(args: Record<string, unknown>, key: string): number {
  const value = args[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new GatewayError(
      ErrorCodes.VALIDATION_ERROR,
      `missing required argument '${key}' (positive integer)`,
    );
  }
  return value;
}

function jobTimeout(): number {
  return getRequestScope().config.jobTimeoutMs;
}

/**
 * Lists a project's pipelines with optional ref/status filters and the
 * pagination contract. Omit `project` to use the X-GitLab-Default-Project
 * header.
 */
export function registerPipelineTools(server: McpServer): void {
  registerTool(
    server,
    {
      name: "gitlab_pipeline_list",
      description:
        "Lists the CI pipelines of a project with optional ref and status filters and " +
        "pagination. Omit `project` to use the X-GitLab-Default-Project header.",
      schema: {
        project: z.string().optional(),
        ref: z.string().optional(),
        status: z.string().optional(),
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
      const ref = optionalString(args, "ref");
      if (ref) params.set("ref", ref);
      const status = optionalString(args, "status");
      if (status) params.set("status", status);
      const response = await client.getWithHeaders<PipelineRecord[]>(
        `${projectPath(project)}/pipelines?${params.toString()}`,
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
      name: "gitlab_pipeline_get",
      description:
        "Returns a single CI pipeline by id. Omit `project` to use the " +
        "X-GitLab-Default-Project header.",
      schema: {
        project: z.string().optional(),
        pipeline_id: z.number(),
      },
      policy: { riskClass: "READ" },
    },
    async (ctx, args, client) => {
      const project = resolveProjectArg(ctx, args);
      const pipelineId = requireId(args, "pipeline_id");
      return client.getJson<PipelineRecord>(
        `${projectPath(project)}/pipelines/${pipelineId}`,
      );
    },
  );

  registerTool(
    server,
    {
      name: "gitlab_pipeline_retry",
      description:
        "Retries a CI pipeline (requires pipeline-write scope). Omit `project` to use " +
        "the X-GitLab-Default-Project header.",
      schema: {
        project: z.string().optional(),
        pipeline_id: z.number(),
      },
      policy: { riskClass: "WRITE", requiredScope: PIPELINE_WRITE },
    },
    async (ctx, args, client) => {
      const project = resolveProjectArg(ctx, args);
      const pipelineId = requireId(args, "pipeline_id");
      return client.postJson<PipelineRecord>(
        `${projectPath(project)}/pipelines/${pipelineId}/retry`,
        {},
      );
    },
  );

  registerTool(
    server,
    {
      name: "gitlab_pipeline_cancel",
      description:
        "Cancels a CI pipeline (requires pipeline-write scope). Omit `project` to use " +
        "the X-GitLab-Default-Project header.",
      schema: {
        project: z.string().optional(),
        pipeline_id: z.number(),
      },
      policy: { riskClass: "WRITE", requiredScope: PIPELINE_WRITE },
    },
    async (ctx, args, client) => {
      const project = resolveProjectArg(ctx, args);
      const pipelineId = requireId(args, "pipeline_id");
      return client.postJson<PipelineRecord>(
        `${projectPath(project)}/pipelines/${pipelineId}/cancel`,
        {},
      );
    },
  );

  registerTool(
    server,
    {
      name: "gitlab_job_list",
      description:
        "Lists the jobs of a CI pipeline (60 s timeout). Omit `project` to use the " +
        "X-GitLab-Default-Project header.",
      schema: {
        project: z.string().optional(),
        pipeline_id: z.number(),
      },
      policy: { riskClass: "READ" },
    },
    async (ctx, args, client) => {
      const project = resolveProjectArg(ctx, args);
      const pipelineId = requireId(args, "pipeline_id");
      const jobs = await client.getJson<JobRecord[]>(
        `${projectPath(project)}/pipelines/${pipelineId}/jobs`,
        { timeoutMs: jobTimeout() },
      );
      return { items: jobs };
    },
  );

  registerTool(
    server,
    {
      name: "gitlab_job_get",
      description:
        "Returns a single CI job by id (60 s timeout). Omit `project` to use the " +
        "X-GitLab-Default-Project header.",
      schema: {
        project: z.string().optional(),
        job_id: z.number(),
      },
      policy: { riskClass: "READ" },
    },
    async (ctx, args, client) => {
      const project = resolveProjectArg(ctx, args);
      const jobId = requireId(args, "job_id");
      return client.getJson<JobRecord>(`${projectPath(project)}/jobs/${jobId}`, {
        timeoutMs: jobTimeout(),
      });
    },
  );

  registerTool(
    server,
    {
      name: "gitlab_job_trace",
      description:
        "Returns the (size-capped) trace log of a CI job (60 s timeout). Large traces " +
        "are truncated from the start with `truncated: true`; pass the returned " +
        "`next_offset` as `offset` to continue. Omit `project` to use the " +
        "X-GitLab-Default-Project header.",
      schema: {
        project: z.string().optional(),
        job_id: z.number(),
        offset: z.number().optional(),
      },
      policy: { riskClass: "READ" },
    },
    async (ctx, args, client) => {
      const config = getRequestScope().config;
      const project = resolveProjectArg(ctx, args);
      const jobId = requireId(args, "job_id");
      const offset = args.offset;
      if (
        offset !== undefined &&
        (typeof offset !== "number" || !Number.isInteger(offset) || offset < 0)
      ) {
        throw new GatewayError(
          ErrorCodes.VALIDATION_ERROR,
          "argument 'offset' must be a non-negative integer",
        );
      }
      const startOffset = offset ?? 0;
      // The trace endpoint returns raw text, not JSON (60 s timeout, FR-14).
      const response = await client.getRaw(`${projectPath(project)}/jobs/${jobId}/trace`, {
        timeoutMs: jobTimeout(),
      });
      const full = await response.text();
      // Continuation window: the trace truncated from the start at `offset`
      // bytes, capped at max_bytes. `truncated: true` plus the offset
      // continuation (FR-13): next offset = offset + bytes returned, so the
      // next call resumes exactly where this window ends.
      const window = utf8SliceFrom(full, startOffset);
      const windowBytes = Buffer.byteLength(window, "utf8");
      const totalBytes = Buffer.byteLength(full, "utf8");
      const truncated = windowBytes > config.maxBytes;
      const content = truncated ? utf8Slice(window, 0, config.maxBytes) : window;
      const bytesReturned = Buffer.byteLength(content, "utf8");
      return {
        job_id: jobId,
        offset: startOffset,
        content,
        truncated,
        original_bytes: totalBytes,
        total_bytes: totalBytes,
        next_offset: truncated ? startOffset + bytesReturned : null,
        ...(truncated
          ? {
              continuation_hint:
                "trace exceeds the response size cap; pass offset=<next_offset> to gitlab_job_trace to continue",
            }
          : {}),
      };
    },
  );
}

/** UTF-8-safe substring [start, end) of the encoded text. */
function utf8Slice(text: string, start: number, end: number): string {
  const buffer = Buffer.from(text, "utf8");
  return buffer.subarray(start, end).toString("utf8");
}

/** UTF-8-safe substring starting at byte `start` of the encoded text. */
function utf8SliceFrom(text: string, start: number): string {
  const buffer = Buffer.from(text, "utf8");
  if (start >= buffer.length) return "";
  let i = start;
  // Walk forward past continuation bytes onto a leading byte.
  while (i < buffer.length && (buffer[i]! & 0xc0) === 0x80) {
    i += 1;
  }
  return buffer.subarray(i).toString("utf8");
}
