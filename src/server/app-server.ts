/**
 * MCP server wiring (architecture §3 src/server/): builds a fresh McpServer
 * instance per request (stateless mode, ADR-0001) and registers the tool set.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerSystemTools } from "../tools/system.js";
import { registerProjectTools } from "../tools/project.js";
import { registerIssueTools } from "../tools/issue.js";
import { registerWorkItemTools } from "../tools/work-item.js";
import { registerRepoTools } from "../tools/repo.js";
import { registerMergeRequestTools } from "../tools/merge-request.js";
import { registerPipelineTools } from "../tools/pipeline.js";
import { registerContentTools } from "../tools/content.js";

export function buildMcpServer(): McpServer {
  const server = new McpServer(
    { name: "gitlab-mcp", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );
  registerSystemTools(server);
  registerProjectTools(server);
  registerIssueTools(server);
  registerWorkItemTools(server);
  registerRepoTools(server);
  registerMergeRequestTools(server);
  registerPipelineTools(server);
  registerContentTools(server);
  return server;
}
