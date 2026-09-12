/**
 * MCP server wiring (architecture §3 src/server/): builds a fresh McpServer
 * instance per request (stateless mode, ADR-0001) and registers the tool set.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerSystemTools } from "../tools/system.js";
import { registerProjectTools } from "../tools/project.js";
import { registerIssueTools } from "../tools/issue.js";

export function buildMcpServer(): McpServer {
  const server = new McpServer(
    { name: "gitlab-mcp", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );
  registerSystemTools(server);
  registerProjectTools(server);
  registerIssueTools(server);
  return server;
}
