/**
 * System domain tools (tool-spec §System): gitlab_system_info and
 * gitlab_system_current_user — both READ.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTool } from "./register.js";

export function registerSystemTools(server: McpServer): void {
  registerTool(
    server,
    {
      name: "gitlab_system_info",
      description: "Returns the GitLab version of the target instance.",
      schema: {},
    },
    async (_ctx, _args, client) => {
      return client.getJson("/api/v4/version");
    },
  );

  registerTool(
    server,
    {
      name: "gitlab_system_current_user",
      description:
        "Returns the GitLab identity resolved from this request's token.",
      schema: {},
    },
    async (ctx) => {
      return {
        id: ctx.identity.id,
        username: ctx.identity.username,
        name: ctx.identity.name,
      };
    },
  );
}
