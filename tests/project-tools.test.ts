/**
 * Contract tests for the project + system domain tools (issue #4, tool-spec
 * §Project/§System): full stack per call — gateway → policy engine → GitLab
 * client → handler — against a mock GitLab HTTP server.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer as createHttpServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { buildMcpServer } from "../src/server/app-server.js";
import { IdentityResolver } from "../src/security/identity.js";
import { HostAllowlist } from "../src/security/host-allowlist.js";
import { loadConfig } from "../src/config.js";
import { runWithRequestScope, type RequestScope } from "../src/context/request-scope.js";
import { resetCapabilityLog } from "../src/gitlab/capability.js";

const TOKEN = "glpat-project-tools-test";
const IDENTITY = { id: 42, username: "marcus", name: "Marcus Y" };

const PROJECTS = [
  { id: 1, path_with_namespace: "vendor/external", default_branch: "main", visibility: "private" },
  { id: 2, path_with_namespace: "itrend/cxutility", default_branch: "main", visibility: "private" },
  { id: 3, path_with_namespace: "playground/misc", default_branch: "master", visibility: "internal" },
  { id: 4, path_with_namespace: "itrend/team/alpha", default_branch: "develop", visibility: "private" },
  { id: 5, path_with_namespace: "itrend/cxgateway", default_branch: "main", visibility: "public" },
  { id: 6, path_with_namespace: "other/thing", default_branch: "main", visibility: "private" },
];

const MEMBERS = [
  { id: 11, username: "marcus", access_level: 40 },
  { id: 12, username: "ada", access_level: 30 },
  { id: 13, username: "grace", access_level: 20 },
];

let gitlab: Server;
let gitlabUrl: string;

function slicePage(all: unknown[], url: URL): { data: unknown[]; nextPage: string } {
  const page = Number(url.searchParams.get("page") ?? "1");
  const perPage = Number(url.searchParams.get("per_page") ?? "20");
  const start = (page - 1) * perPage;
  const data = all.slice(start, start + perPage);
  const nextPage = start + perPage < all.length ? String(page + 1) : "";
  return { data, nextPage };
}

beforeAll(async () => {
  gitlab = createHttpServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = decodeURIComponent(url.pathname);
    const json = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { "Content-Type": "application/json", ...headers });
      res.end(JSON.stringify(body));
    };
    if (path === "/api/v4/user") return json(200, IDENTITY);
    if (path === "/api/v4/version") {
      return json(200, { version: "18.8.3-ee", revision: "abc123" });
    }
    // project list
    if (path === "/api/v4/projects") {
      let rows = PROJECTS;
      const search = url.searchParams.get("search");
      if (search) rows = rows.filter((p) => p.path_with_namespace.includes(search));
      const { data, nextPage } = slicePage(rows, url);
      return json(200, data, { "x-next-page": nextPage, "x-total": String(rows.length) });
    }
    // group project list: /api/v4/groups/:id/projects
    const groupMatch = path.match(/^\/api\/v4\/groups\/(.+)\/projects$/);
    if (groupMatch) {
      const group = groupMatch[1];
      const rows = PROJECTS.filter((p) =>
        p.path_with_namespace.startsWith(`${group}/`),
      );
      const { data, nextPage } = slicePage(rows, url);
      return json(200, data, { "x-next-page": nextPage, "x-total": String(rows.length) });
    }
    // project detail: /api/v4/projects/:id
    const projectMatch = path.match(/^\/api\/v4\/projects\/(.+?)\/members$/);
    if (projectMatch) {
      const { data, nextPage } = slicePage(MEMBERS, url);
      return json(200, data, { "x-next-page": nextPage, "x-total": String(MEMBERS.length) });
    }
    const detailMatch = path.match(/^\/api\/v4\/projects\/(.+)$/);
    if (detailMatch) {
      const project = PROJECTS.find((p) => p.path_with_namespace === detailMatch[1]);
      if (project) return json(200, { ...project, web_url: `https://git.example.com/${project.path_with_namespace}` });
      return json(404, { message: "404 Project Not Found" });
    }
    return json(404, { message: "404 Not Found" });
  });
  await new Promise<void>((r) => gitlab.listen(0, "127.0.0.1", r));
  const ga = gitlab.address() as AddressInfo;
  gitlabUrl = `http://127.0.0.1:${ga.port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => gitlab.close(() => r()));
});

function buildScope(headerEnv: Record<string, string>): RequestScope {
  return {
    headers: {
      "x-gitlab-url": gitlabUrl,
      "x-gitlab-token": TOKEN,
      ...headerEnv,
    },
    config: loadConfig({
      GITLAB_MCP_ALLOWED_HOSTS: "127.0.0.1,localhost",
      GITLAB_MCP_IDENTITY_CACHE_TTL_MS: "3600000",
    } as NodeJS.ProcessEnv),
    identityResolver: new IdentityResolver({
      ttlMs: 3_600_000,
      fetchImpl: async () =>
        new Response(JSON.stringify(IDENTITY), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    }),
    allowlist: new HostAllowlist(["127.0.0.1", "localhost"]),
  };
}

async function callTool(
  scope: RequestScope,
  name: string,
  args: Record<string, unknown> = {},
): Promise<{ text: string; isError: boolean }> {
  const server: McpServer = buildMcpServer();
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

beforeAll(() => {
  resetCapabilityLog();
});

describe("gitlab_system_info", () => {
  it("returns version + revision + capabilities seen at startup", async () => {
    const result = await callTool(buildScope({}), "gitlab_system_info");
    expect(result.isError).toBe(false);
    const body = JSON.parse(result.text);
    expect(body.gitlab_version).toBe("18.8.3-ee");
    expect(body.revision).toBe("abc123");
    expect(body.capabilities_seen_at_startup).toEqual({ version: "18.8.3-ee" });
  });

  it("rejects unknown arguments with VALIDATION_ERROR", async () => {
    const result = await callTool(buildScope({}), "gitlab_system_info", { bogus: 1 });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/^ERROR VALIDATION_ERROR: unknown argument\(s\): bogus$/);
  });
});

describe("gitlab_project_get", () => {
  it("returns project metadata for an explicit project", async () => {
    const result = await callTool(
      buildScope({}),
      "gitlab_project_get",
      { project: "itrend/cxutility" },
    );
    expect(result.isError).toBe(false);
    const project = JSON.parse(result.text);
    expect(project.path_with_namespace).toBe("itrend/cxutility");
    expect(project.default_branch).toBe("main");
    expect(project.visibility).toBe("private");
  });

  it("falls back to the X-GitLab-Default-Project header when project is omitted", async () => {
    const result = await callTool(
      buildScope({ "x-gitlab-default-project": "itrend/team/alpha" }),
      "gitlab_project_get",
    );
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.text).path_with_namespace).toBe("itrend/team/alpha");
  });

  it("URL-encodes namespaced project paths", async () => {
    const result = await callTool(
      buildScope({}),
      "gitlab_project_get",
      { project: "itrend/team/alpha" },
    );
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.text).default_branch).toBe("develop");
  });

  it("missing project without default header → VALIDATION_ERROR", async () => {
    const result = await callTool(buildScope({}), "gitlab_project_get");
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/^ERROR VALIDATION_ERROR: missing required argument 'project'/);
  });

  it("project outside Project Scope → SCOPE_PROJECT_NOT_ALLOWED", async () => {
    const result = await callTool(
      buildScope({ "x-gitlab-project-scope": "itrend/*" }),
      "gitlab_project_get",
      { project: "vendor/external" },
    );
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/^ERROR SCOPE_PROJECT_NOT_ALLOWED: .*vendor\/external/);
  });

  it("unknown project → GITLAB_API_ERROR (404 surfaced)", async () => {
    const result = await callTool(
      buildScope({}),
      "gitlab_project_get",
      { project: "nope/missing" },
    );
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/^ERROR GITLAB_API_ERROR: GitLab returned HTTP 404/);
  });

  it("rejects unknown arguments with VALIDATION_ERROR", async () => {
    const result = await callTool(buildScope({}), "gitlab_project_get", {
      project: "itrend/cxutility",
      foo: "bar",
    });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/^ERROR VALIDATION_ERROR: unknown argument\(s\): foo$/);
  });
});

describe("gitlab_project_list", () => {
  it("returns only in-scope projects when Project Scope is set (mixed data)", async () => {
    const result = await callTool(
      buildScope({ "x-gitlab-project-scope": "itrend/*" }),
      "gitlab_project_list",
    );
    expect(result.isError).toBe(false);
    const body = JSON.parse(result.text);
    expect(body.items.map((p: { path_with_namespace: string }) => p.path_with_namespace))
      .toEqual(["itrend/cxutility", "itrend/team/alpha", "itrend/cxgateway"]);
    expect(body.pagination).toEqual({ has_more: false, next_cursor: null });
  });

  it("returns everything the PAT can see without a scope header", async () => {
    const result = await callTool(buildScope({}), "gitlab_project_list");
    expect(result.isError).toBe(false);
    const body = JSON.parse(result.text);
    expect(body.items).toHaveLength(PROJECTS.length);
  });

  it("keeps listing past out-of-scope pages via the continuation cursor", async () => {
    const scope = buildScope({ "x-gitlab-project-scope": "itrend/*" });
    const first = await callTool(scope, "gitlab_project_list", { limit: 1 });
    const firstBody = JSON.parse(first.text);
    // Page 1 holds only vendor/external (out of scope) — the tool must not
    // report an empty end-of-list; it pages on until an in-scope item appears.
    expect(firstBody.items.map((p: { path_with_namespace: string }) => p.path_with_namespace))
      .toEqual(["itrend/cxutility"]);
    expect(firstBody.pagination.has_more).toBe(true);

    const second = await callTool(scope, "gitlab_project_list", {
      cursor: firstBody.pagination.next_cursor,
    });
    const secondBody = JSON.parse(second.text);
    expect(secondBody.items.map((p: { path_with_namespace: string }) => p.path_with_namespace))
      .toEqual(["itrend/team/alpha"]);
    expect(secondBody.pagination.has_more).toBe(true);
  });

  it("lists a group's projects and still respects Project Scope", async () => {
    const result = await callTool(
      buildScope({ "x-gitlab-project-scope": "itrend/team/*" }),
      "gitlab_project_list",
      { group: "itrend/team" },
    );
    expect(result.isError).toBe(false);
    const body = JSON.parse(result.text);
    expect(body.items.map((p: { path_with_namespace: string }) => p.path_with_namespace))
      .toEqual(["itrend/team/alpha"]);
  });

  it("group outside Project Scope → SCOPE_PROJECT_NOT_ALLOWED", async () => {
    const result = await callTool(
      buildScope({ "x-gitlab-project-scope": "itrend/*" }),
      "gitlab_project_list",
      { group: "vendor" },
    );
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/^ERROR SCOPE_PROJECT_NOT_ALLOWED: .*vendor/);
  });

  it("supports search filtering", async () => {
    const result = await callTool(buildScope({}), "gitlab_project_list", { search: "cx" });
    expect(result.isError).toBe(false);
    const body = JSON.parse(result.text);
    expect(body.items.map((p: { path_with_namespace: string }) => p.path_with_namespace).sort())
      .toEqual(["itrend/cxgateway", "itrend/cxutility"]);
  });

  it("rejects unknown arguments with VALIDATION_ERROR", async () => {
    const result = await callTool(buildScope({}), "gitlab_project_list", { star: true });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/^ERROR VALIDATION_ERROR: unknown argument\(s\): star$/);
  });
});

describe("gitlab_project_members", () => {
  it("lists members with the pagination contract", async () => {
    const result = await callTool(
      buildScope({}),
      "gitlab_project_members",
      { project: "itrend/cxutility" },
    );
    expect(result.isError).toBe(false);
    const body = JSON.parse(result.text);
    expect(body.items).toHaveLength(3);
    expect(body.pagination).toEqual({ has_more: false, next_cursor: null });
  });

  it("paginates via opaque cursors", async () => {
    const scope = buildScope({ "x-gitlab-default-project": "itrend/cxutility" });
    const first = await callTool(scope, "gitlab_project_members", { limit: 2 });
    const firstBody = JSON.parse(first.text);
    expect(firstBody.items.map((m: { username: string }) => m.username)).toEqual(["marcus", "ada"]);
    expect(firstBody.pagination.has_more).toBe(true);

    const second = await callTool(scope, "gitlab_project_members", {
      cursor: firstBody.pagination.next_cursor,
    });
    const secondBody = JSON.parse(second.text);
    expect(secondBody.items.map((m: { username: string }) => m.username)).toEqual(["grace"]);
    expect(secondBody.pagination.has_more).toBe(false);
  });

  it("project outside Project Scope → SCOPE_PROJECT_NOT_ALLOWED", async () => {
    const result = await callTool(
      buildScope({ "x-gitlab-project-scope": "itrend/*" }),
      "gitlab_project_members",
      { project: "other/thing" },
    );
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/^ERROR SCOPE_PROJECT_NOT_ALLOWED: /);
  });

  it("rejects unknown arguments with VALIDATION_ERROR", async () => {
    const result = await callTool(buildScope({}), "gitlab_project_members", {
      project: "itrend/cxutility",
      with_inherited: true,
    });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/^ERROR VALIDATION_ERROR: unknown argument\(s\): with_inherited$/);
  });
});
