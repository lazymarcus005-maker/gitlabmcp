/**
 * HTTP entrypoint: Streamable HTTP transport in STATELESS mode (FR-1).
 * Every POST /mcp is an independent request: a fresh McpServer + transport
 * per request, no session store, no sticky sessions.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { buildMcpServer } from "./app-server.js";
import { loadConfig, type ServerConfig } from "../config.js";
import { HostAllowlist } from "../security/host-allowlist.js";
import { IdentityResolver } from "../security/identity.js";
import { runWithRequestScope } from "../context/request-scope.js";
import { createGitLabClient } from "../gitlab/client-factory.js";
import { logCapabilityOnce } from "../gitlab/capability.js";

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function handlePost(
  req: IncomingMessage,
  res: ServerResponse,
  config: ServerConfig,
  identityResolver: IdentityResolver,
  allowlist: HostAllowlist,
): Promise<void> {
  const bodyText = await readBody(req);
  let body: unknown;
  try {
    body = JSON.parse(bodyText);
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "invalid JSON body" }));
    return;
  }

  // Stateless: fresh server + transport per request, no session id.
  const server = buildMcpServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);

  await runWithRequestScope(
    { headers: req.headers, config, identityResolver, allowlist },
    () => transport.handleRequest(req, res, body),
  );
}

export function createHttpServer(config: ServerConfig = loadConfig()): Server {
  const allowlist = new HostAllowlist(config.allowedHosts);
  const identityResolver = new IdentityResolver({ ttlMs: config.identityCacheTtlMs });
  const path = config.httpPath;

  return createServer((req, res) => {
    const send405 = () => {
      res.writeHead(405, { Allow: "POST" });
      res.end();
    };
    if (req.url?.split("?")[0] !== path) {
      res.writeHead(404);
      res.end();
      return;
    }
    if (req.method !== "POST") {
      // Stateless mode: no SSE streams, no session termination.
      send405();
      return;
    }
    handlePost(req, res, config, identityResolver, allowlist).catch(() => {
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "internal error" }));
      } else {
        res.end();
      }
    });
  });
}

export function main(): void {
  const config = loadConfig();
  const env = process.env;
  const httpServer = createHttpServer(config);
  httpServer.listen(config.port, () => {
    process.stdout.write(
      `${JSON.stringify({ msg: "gitlab-mcp listening", path: config.httpPath, port: config.port })}\n`,
    );
    // Capability check (FR-16): log the GitLab version once at startup when
    // ambient credentials are available via env (per-request creds otherwise).
    const url = env.GITLAB_MCP_URL;
    const token = env.GITLAB_MCP_TOKEN;
    if (url && token) {
      const client = createGitLabClient(
        {
          requestId: "startup",
          gitlab: { baseUrl: url, token, tls: { verify: true } },
          identity: { id: -1, username: "system" },
        },
        { timeoutMs: config.timeoutMs },
      );
      void logCapabilityOnce(client);
    }
  });
}
