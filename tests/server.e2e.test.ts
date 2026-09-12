import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { createServer as createHttpServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { createHttpServer as createMcpServer } from "../src/server/http-server.js";
import { loadConfig } from "../src/config.js";

let gitlab: Server;
let gitlabUrl: string;
let gitlabHost: string;
let userCalls = 0;
let versionCalls = 0;
let versionStatus = 200;

let mcp: Server;
let mcpUrl: string;

const TOKEN = "glpat-e2e-test-token";

async function mcpCall(tool: string, headers: Record<string, string> = {}) {
  const res = await fetch(mcpUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "X-GitLab-URL": gitlabUrl,
      "X-GitLab-Token": TOKEN,
      ...headers,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: tool, arguments: {} },
    }),
  });
  return res;
}

function textOf(result: { content: Array<{ text?: string }>; isError?: boolean }) {
  return {
    text: result.content[0]?.text ?? "",
    isError: result.isError === true,
  };
}

async function readBody(res: Response) {
  const text = await res.text();
  // Handle either plain JSON or SSE frames.
  const dataLine = text.split("\n").find((l) => l.startsWith("data:"));
  return JSON.parse(dataLine ? dataLine.slice(5).trim() : text);
}

const baseConfigEnv = {
  GITLAB_MCP_ALLOWED_HOSTS: "localhost,127.0.0.1,git.example.com",
  GITLAB_MCP_DISABLE_VERIFY_HOSTS: "127.0.0.1",
  GITLAB_MCP_IDENTITY_CACHE_TTL_MS: "3600000",
};

beforeAll(async () => {
  // Mock GitLab instance.
  gitlab = createHttpServer((req, res) => {
    const url = req.url ?? "";
    if (url.startsWith("/api/v4/user")) {
      userCalls += 1;
      const auth = req.headers.authorization ?? "";
      if (auth !== `Bearer ${TOKEN}`) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ message: "401 Unauthorized" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ id: 42, username: "marcus", name: "Marcus Y" }));
      return;
    }
    if (url.startsWith("/api/v4/version")) {
      versionCalls += 1;
      res.writeHead(versionStatus, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ version: "18.8.3-ee", revision: "test" }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((r) => gitlab.listen(0, "127.0.0.1", r));
  const ga = gitlab.address() as AddressInfo;
  gitlabUrl = `http://127.0.0.1:${ga.port}`;
  gitlabHost = `127.0.0.1:${ga.port}`;

  // MCP server under test.
  const config = loadConfig({ ...baseConfigEnv } as NodeJS.ProcessEnv);
  mcp = createMcpServer(config);
  await new Promise<void>((r) => mcp.listen(0, "127.0.0.1", r));
  const ma = mcp.address() as AddressInfo;
  mcpUrl = `http://127.0.0.1:${ma.port}${config.httpPath}`;
});

afterAll(async () => {
  await new Promise<void>((r) => gitlab.close(() => r()));
  await new Promise<void>((r) => mcp.close(() => r()));
});

afterEach(() => {
  userCalls = 0;
  versionCalls = 0;
  versionStatus = 200;
});

describe("POST /mcp end-to-end (stateless)", () => {
  it("gitlab_system_current_user returns the caller's identity", async () => {
    const res = await mcpCall("gitlab_system_current_user");
    expect(res.status).toBe(200);
    const body = await readBody(res);
    expect(body.error).toBeUndefined();
    const { text, isError } = textOf(body.result);
    expect(isError).toBe(false);
    const identity = JSON.parse(text);
    expect(identity).toEqual({ id: 42, username: "marcus", name: "Marcus Y" });
  });

  it("second request with the same token hits the identity cache (no second /user call)", async () => {
    await mcpCall("gitlab_system_current_user");
    await mcpCall("gitlab_system_current_user");
    // The cache may already be warm from a previous test; what matters is
    // that two calls never produce two /user fetches.
    expect(userCalls).toBeLessThanOrEqual(1);
  });

  it("gitlab_system_info returns the GitLab version", async () => {
    const res = await mcpCall("gitlab_system_info");
    const body = await readBody(res);
    const { text, isError } = textOf(body.result);
    expect(isError).toBe(false);
    expect(JSON.parse(text)).toMatchObject({ version: "18.8.3-ee" });
    expect(versionCalls).toBe(1);
  });

  it("host outside allowlist → GITLAB_HOST_NOT_ALLOWED as isError result", async () => {
    const res = await mcpCall("gitlab_system_current_user", {
      "X-GitLab-URL": "https://evil.example.com",
    });
    const body = await readBody(res);
    const { text, isError } = textOf(body.result);
    expect(isError).toBe(true);
    expect(text).toMatch(/^ERROR GITLAB_HOST_NOT_ALLOWED: /);
    expect(text).toContain("evil.example.com");
  });

  it("SSL-Verify:false for a non-exempt host → POLICY_TLS_VERIFY_FORBIDDEN", async () => {
    const res = await mcpCall("gitlab_system_current_user", {
      "X-GitLab-SSL-Verify": "false",
      "X-GitLab-URL": "https://git.example.com", // allowlisted, not exempt
    });
    const body = await readBody(res);
    const { text, isError } = textOf(body.result);
    expect(isError).toBe(true);
    expect(text).toMatch(/^ERROR POLICY_TLS_VERIFY_FORBIDDEN: /);
  });

  it("SSL-Verify:false is honored for exempt hosts", async () => {
    // Mock GitLab runs on 127.0.0.1, which is not in disable_verify_hosts by
    // default env above; add a dedicated server to exercise the allowed path.
    const config = loadConfig({
      GITLAB_MCP_ALLOWED_HOSTS: gitlabHost,
      GITLAB_MCP_DISABLE_VERIFY_HOSTS: "127.0.0.1",
      GITLAB_MCP_IDENTITY_CACHE_TTL_MS: "3600000",
    } as NodeJS.ProcessEnv);
    const server = createMcpServer(config);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const addr = server.address() as AddressInfo;
    try {
      const res = await fetch(`http://127.0.0.1:${addr.port}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "X-GitLab-URL": gitlabUrl,
          "X-GitLab-Token": TOKEN,
          "X-GitLab-SSL-Verify": "false",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "gitlab_system_current_user", arguments: {} },
        }),
      });
      const body = await readBody(res);
      const { isError } = textOf(body.result);
      expect(isError).toBe(false);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("invalid token → GITLAB_TOKEN_INVALID as isError result", async () => {
    const res = await fetch(mcpUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "X-GitLab-URL": gitlabUrl,
        "X-GitLab-Token": "glpat-wrong",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "gitlab_system_current_user", arguments: {} },
      }),
    });
    const body = await readBody(res);
    const { text, isError } = textOf(body.result);
    expect(isError).toBe(true);
    expect(text).toMatch(/^ERROR GITLAB_TOKEN_INVALID: /);
  });

  it("missing required headers → VALIDATION_ERROR", async () => {
    const res = await fetch(mcpUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "gitlab_system_current_user", arguments: {} },
      }),
    });
    const body = await readBody(res);
    const { text, isError } = textOf(body.result);
    expect(isError).toBe(true);
    expect(text).toMatch(/^ERROR VALIDATION_ERROR: /);
  });

  it("emits exactly one audit JSON line per call on stdout", async () => {
    const lines: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      lines.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      await mcpCall("gitlab_system_current_user");
    } finally {
      process.stdout.write = original;
    }
    const auditLines = lines.filter((l) => l.includes('"tool":"gitlab_system_current_user"'));
    expect(auditLines).toHaveLength(1);
    const rec = JSON.parse(auditLines[0]!);
    expect(rec).toMatchObject({
      gitlab: { host: gitlabHost, user_id: 42, username: "marcus" },
      tool: "gitlab_system_current_user",
      result: "success",
    });
    expect(rec.request_id).toBeTruthy();
    expect(typeof rec.duration_ms).toBe("number");
    expect(auditLines[0]).not.toContain(TOKEN);
  });
});
