/**
 * System domain tools (tool-spec §System): gitlab_system_info and
 * gitlab_system_current_user — both READ.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTool } from "./register.js";
import {
  getCapabilitySnapshot,
  recordCapabilityVersion,
} from "../gitlab/capability.js";

export function registerSystemTools(server: McpServer): void {
  registerTool(
    server,
    {
      name: "gitlab_system_info",
      description:
        "Returns the GitLab version of the target instance plus the capabilities seen at startup.",
      schema: {},
      policy: { riskClass: "READ" },
    },
    async (_ctx, _args, client) => {
      const version = await client.getJson<{
        version?: string;
        revision?: string;
      }>("/api/v4/version");
      if (version.version) recordCapabilityVersion(version.version);
      return {
        gitlab_version: version.version ?? "unknown",
        revision: version.revision ?? null,
        capabilities_seen_at_startup: getCapabilitySnapshot(),
      };
    },
  );

  registerTool(
    server,
    {
      name: "gitlab_system_current_user",
      description:
        "Returns the GitLab identity resolved from this request's token.",
      schema: {},
      policy: { riskClass: "READ" },
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
