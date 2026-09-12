/**
 * Tool registration helpers: each tool handler runs behind the security
 * gateway; errors become isError tool results (FR-15) and every call emits
 * exactly one audit record (NFR-2).
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ZodRawShape } from "zod";
import { z } from "zod";
import { resolveRequestContext } from "../security/gateway.js";
import { auditToolCall } from "../audit/logger.js";
import { GatewayError } from "../errors.js";
import type { GitLabRequestContext } from "../context/request-context.js";
import { getRequestScope } from "../context/request-scope.js";
import { createGitLabClient } from "../gitlab/client-factory.js";

export type ToolHandler<A> = (
  ctx: GitLabRequestContext,
  args: A,
  client: ReturnType<typeof createGitLabClient>,
) => Promise<Record<string, unknown>>;

function hostOf(baseUrl: string): string {
  return new URL(baseUrl).host;
}

/**
 * Wraps a handler with the gateway pipeline, audit record and error mapping.
 */
export function registerTool<S extends ZodRawShape>(
  server: McpServer,
  options: { name: string; description: string; schema: S },
  handler: ToolHandler<Record<string, unknown>>,
): void {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(options.name)) {
    throw new Error(`tool name violates MCP spec pattern: ${options.name}`);
  }
  server.registerTool(options.name, {
    description: options.description,
    inputSchema: options.schema,
  }, (async (args: Record<string, unknown>, _extra: unknown) => {
      const startedAt = Date.now();
      const scope = getRequestScope();
      let host = "unknown";
      let userId: number | undefined;
      let username: string | undefined;
      let requestId = "unknown";
      let ctx: GitLabRequestContext | undefined;
      try {
        ctx = await resolveRequestContext();
        host = hostOf(ctx.gitlab.baseUrl);
        userId = ctx.identity.id;
        username = ctx.identity.username;
        requestId = ctx.requestId;
        const client = createGitLabClient(ctx);
        const data = await handler(ctx, args, client);
        audit({
          scope,
          requestId,
          host,
          userId,
          username,
          tool: options.name,
          result: "success",
          startedAt,
        });
        return {
          content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
        };
      } catch (error) {
        const result = error instanceof GatewayError ? error : new GatewayError(
          "GITLAB_API_ERROR",
          error instanceof Error ? error.message : String(error),
        );
        audit({
          scope,
          requestId: ctx?.requestId ?? requestId,
          host,
          userId: userId ?? -1,
          username: username ?? "unresolved",
          tool: options.name,
          result: "error",
          startedAt,
        });
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: result.toText() }],
        };
      }
    }) as Parameters<
      Parameters<typeof server.registerTool>[2]
    >[0],
  );
}

function audit(input: {
  scope: ReturnType<typeof getRequestScope>;
  requestId: string;
  host: string;
  userId: number;
  username: string;
  tool: string;
  result: "success" | "error";
  startedAt: number;
}): void {
  auditToolCall({
    request_id: input.requestId,
    gitlab: {
      host: input.host,
      user_id: input.userId,
      username: input.username,
    },
    tool: input.tool,
    result: input.result,
    duration_ms: Date.now() - input.startedAt,
  });
}
