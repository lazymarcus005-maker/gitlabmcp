/**
 * Integration tests: the policy engine runs inside the tool wrapper, so
 * every tool call is gated before its handler executes and rejections
 * surface as isError tool results in `ERROR <CODE>: <message>` form.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { registerTool } from "../src/tools/register.js";
import { IdentityResolver } from "../src/security/identity.js";
import { HostAllowlist } from "../src/security/host-allowlist.js";
import { loadConfig } from "../src/config.js";
import { runWithRequestScope, type RequestScope } from "../src/context/request-scope.js";

const BASE = "https://git.tiddaw.net";
const TOKEN = "glpat-integration-test";
const IDENTITY = { id: 42, username: "marcus", name: "Marcus Y" };

function buildScope(configEnv: Record<string, string>): RequestScope {
  return {
    headers: {
      "x-gitlab-url": BASE,
      "x-gitlab-token": TOKEN,
    },
    config: loadConfig({
      GITLAB_MCP_ALLOWED_HOSTS: "git.tiddaw.net",
      GITLAB_MCP_IDENTITY_CACHE_TTL_MS: "3600000",
      ...configEnv,
    } as NodeJS.ProcessEnv),
    identityResolver: new IdentityResolver({
      ttlMs: 3_600_000,
      fetchImpl: async () =>
        new Response(JSON.stringify(IDENTITY), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    }),
    allowlist: new HostAllowlist(["git.tiddaw.net"]),
  };
}

function buildServer(): McpServer {
  const server = new McpServer({ name: "policy-test", version: "0.0.0" });

  registerTool(
    server,
    {
      name: "gitlab_issue_create",
      description: "test WRITE tool",
      schema: { project: z.string().optional(), branch: z.string().optional() },
      policy: { riskClass: "WRITE", requiredScope: "issue-write" },
    },
    async (_ctx, args) => ({ created: true, project: args.project ?? "default" }),
  );

  registerTool(
    server,
    {
      name: "gitlab_branch_delete",
      description: "test branch delete tool",
      schema: { project: z.string(), branch: z.string() },
      policy: { riskClass: "WRITE", requiredScope: "repo-write", branchOperation: "delete" },
    },
    async (_ctx, args) => ({ deleted: args.branch }),
  );

  registerTool(
    server,
    {
      name: "gitlab_system_info",
      description: "test READ tool",
      schema: {},
      policy: { riskClass: "READ" },
    },
    async () => ({ version: "18.8.3-ee" }),
  );

  return server;
}

async function callTool(
  scope: RequestScope,
  name: string,
  args: Record<string, unknown> = {},
): Promise<{ text: string; isError: boolean }> {
  const server = buildServer();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    return await runWithRequestScope(scope, async () => {
      const result = (await client.callTool({ name, arguments: args })) as {
        isError?: boolean;
        content: Array<{ text?: string }>;
      };
      return {
        text: result.content[0]?.text ?? "",
        isError: result.isError === true,
      };
    });
  } finally {
    await client.close();
    await server.close();
  }
}

let scope: RequestScope;

beforeEach(() => {
  scope = buildScope({});
});

describe("policy engine behind the tool wrapper", () => {
  it("READ tool works with any requested scope (scopes only reduce)", async () => {
    const result = await callTool({ ...scope, headers: { ...scope.headers, "x-gitlab-request-scope": "read" } }, "gitlab_system_info");
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.text)).toEqual({ version: "18.8.3-ee" });
  });

  it("WRITE tool passes with no scope header and reaches the handler", async () => {
    const result = await callTool(scope, "gitlab_issue_create", { project: "itrend/cxutility" });
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.text)).toEqual({ created: true, project: "itrend/cxutility" });
  });

  it("`X-GitLab-Request-Scope: read` blocks a WRITE with POLICY_SCOPE_MISSING as isError result", async () => {
    const narrow = buildScope({});
    narrow.headers = { ...narrow.headers, "x-gitlab-request-scope": "read" };
    const result = await callTool(narrow, "gitlab_issue_create", { project: "itrend/cxutility" });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/^ERROR POLICY_SCOPE_MISSING: /);
  });

  it("`X-GitLab-Request-Scope: admin` grants nothing", async () => {
    const admin = buildScope({});
    admin.headers = { ...admin.headers, "x-gitlab-request-scope": "admin" };
    const result = await callTool(admin, "gitlab_issue_create", { project: "itrend/cxutility" });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/^ERROR POLICY_SCOPE_MISSING: /);
  });

  it("target outside Project Scope → SCOPE_PROJECT_NOT_ALLOWED", async () => {
    const scoped = buildScope({});
    scoped.headers = { ...scoped.headers, "x-gitlab-project-scope": "itrend/*" };
    const result = await callTool(scoped, "gitlab_issue_create", { project: "other/repo" });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/^ERROR SCOPE_PROJECT_NOT_ALLOWED: .*other\/repo/);
  });

  it("glob `itrend/*` admits nested subgroup targets", async () => {
    const scoped = buildScope({});
    scoped.headers = { ...scoped.headers, "x-gitlab-project-scope": "itrend/*" };
    const result = await callTool(scoped, "gitlab_issue_create", { project: "itrend/team/alpha/app" });
    expect(result.isError).toBe(false);
  });

  it("GITLAB_MCP_READ_ONLY=true denies WRITE server-wide", async () => {
    const ro = buildScope({ GITLAB_MCP_READ_ONLY: "true" });
    const result = await callTool(ro, "gitlab_issue_create", { project: "itrend/cxutility" });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/^ERROR POLICY_OPERATION_DENIED: /);
    // READ tools keep working under the kill switch.
    const read = await callTool(ro, "gitlab_system_info");
    expect(read.isError).toBe(false);
  });

  it("protected branch delete → POLICY_BRANCH_PROTECTED as isError result", async () => {
    const result = await callTool(scope, "gitlab_branch_delete", {
      project: "itrend/cxutility",
      branch: "main",
    });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/^ERROR POLICY_BRANCH_PROTECTED: /);
  });

  it("non-protected branch delete passes with the right scope", async () => {
    const result = await callTool(scope, "gitlab_branch_delete", {
      project: "itrend/cxutility",
      branch: "feature/x",
    });
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.text)).toEqual({ deleted: "feature/x" });
  });
});
