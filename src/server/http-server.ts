/**
 * HTTP entrypoint: Streamable HTTP transport in STATELESS mode (FR-1).
 * Every POST /mcp is an independent request: a fresh McpServer + transport
 * per request, no session store, no sticky sessions.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { buildMcpServer } from "./app-server.js";
import { describeConfig, loadConfig, type ServerConfig } from "../config.js";
import { HostAllowlist } from "../security/host-allowlist.js";
import { IdentityResolver } from "../security/identity.js";
import { runWithRequestScope } from "../context/request-scope.js";
import { createGitLabClient } from "../gitlab/client-factory.js";
import { logCapabilityOnce } from "../gitlab/capability.js";

/** Hard cap on request body size; anything larger is rejected (413). */
const MAX_BODY_BYTES = 2 * 1024 * 1024;

class BodyTooLargeError extends Error {}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on("data", (c: Buffer) => {
      if (tooLarge) return; // keep consuming (discarded) so the client can finish
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      chunks.push(c);
    });
    req.on("end", () =>
      tooLarge ? reject(new BodyTooLargeError()) : resolve(Buffer.concat(chunks).toString("utf8")),
    );
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

  const httpServer = createServer((req, res) => {
    const send405 = () => {
      res.writeHead(405, { Allow: "POST" });
      res.end();
    };
    // Plain liveness endpoint (NFR-4): outside the MCP handler, no auth,
    // used by container HEALTHCHECK and k8s probes.
    if (req.method === "GET" && req.url?.split("?")[0] === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }
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
    handlePost(req, res, config, identityResolver, allowlist).catch((error) => {
      if (error instanceof BodyTooLargeError) {
        if (!res.headersSent) {
          res.writeHead(413, { "Content-Type": "application/json" });
        }
        res.end(JSON.stringify({ error: "request body too large" }));
        return;
      }
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "internal error" }));
      } else {
        res.end();
      }
    });
  });

  // Malformed or oversized headers must never crash the process; Node's
  // default would surface a parser error, so respond 431 and destroy the
  // socket (handled per-connection, server keeps serving).
  httpServer.on("clientError", (err, socket) => {
    if (socket.writable) {
      socket.end("HTTP/1.1 431 Request Header Fields Too Large\r\n\r\n");
    } else {
      socket.destroy();
    }
  });
  return httpServer;
}

export function main(): void {
  const config = loadConfig();
  const env = process.env;
  const httpServer = createHttpServer(config);
  httpServer.listen(config.port, () => {
    // Effective config, one JSON line, secrets redacted (NFR-3): no token
    // values are ever part of ServerConfig (per-request credentials only).
    process.stdout.write(
      `${JSON.stringify({ msg: "gitlab-mcp listening", path: config.httpPath, port: config.port })}\n`,
    );
    process.stdout.write(`${describeConfig(config)}\n`);
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
