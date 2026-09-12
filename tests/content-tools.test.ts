/**
 * Contract tests for the content-domain tools (issue #10, tool-spec
 * §Milestone/§Wiki/§Label): full stack per call — gateway → policy engine →
 * GitLab client → handler — against a mock GitLab HTTP server. WRITEs require
 * the `project-write` scope (FR-7), group milestones use /groups/:id
 * endpoints, default project/group fallback and VALIDATION_ERROR for bad args.
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

const TOKEN = "glpat-content-tools-test";
const IDENTITY = { id: 42, username: "marcus", name: "Marcus Y" };

const MILESTONES = [
  { id: 1, iid: 1, title: "v1.0", state: "active" },
  { id: 2, iid: 2, title: "v2.0", state: "closed" },
];
const GROUP_MILESTONES = [
  { id: 10, title: "Group M1", state: "active" },
  { id: 11, title: "Group M2", state: "active" },
];
const WIKIS = [
  { slug: "home", title: "Home", format: "markdown" },
  { slug: "setup-guide", title: "Setup Guide", format: "markdown" },
];
const LABELS = [
  { id: 1, name: "bug", color: "#FF0000" },
  { id: 2, name: "feature", color: "#00FF00" },
];

let gitlab: Server;
let gitlabUrl: string;

const calls: Array<{
  method: string;
  path: string;
  query: Record<string, string>;
  body?: unknown;
}> = [];

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
    let raw = "";
    req.on("data", (chunk: Buffer) => {
      raw += chunk.toString();
    });
    req.on("end", () => {
      const body = raw !== "" ? JSON.parse(raw) : undefined;
      if (path !== "/api/v4/user" && path !== "/api/v4/version") {
        calls.push({
          method: req.method ?? "GET",
          path,
          query: Object.fromEntries(url.searchParams),
          body,
        });
      }
      if (path === "/api/v4/user") return json(200, IDENTITY);
      if (path === "/api/v4/version") {
        return json(200, { version: "18.8.3-ee", revision: "abc123" });
      }
      const p = "api/v4/projects/itrend/cxutility";
      const g = "api/v4/groups/itrend";
      // milestones: project and group collections
      if (path === `/${p}/milestones`) {
        if (req.method === "POST") return json(201, { id: 3, ...body, state: "active" });
        let rows = MILESTONES;
        const state = url.searchParams.get("state");
        if (state) rows = rows.filter((m) => m.state === state);
        const { data, nextPage } = slicePage(rows, url);
        return json(200, data, { "x-next-page": nextPage, "x-total": String(rows.length) });
      }
      if (path === `/${g}/milestones`) {
        const { data, nextPage } = slicePage(GROUP_MILESTONES, url);
        return json(200, data, { "x-next-page": nextPage, "x-total": String(GROUP_MILESTONES.length) });
      }
      const msMatch = path.match(/^\/api\/v4\/(projects\/itrend\/cxutility|groups\/itrend)\/milestones\/(\d+)$/);
      if (msMatch) {
        const id = Number(msMatch[2]);
        if (req.method === "PUT") {
          const source = msMatch[1].startsWith("groups")
            ? GROUP_MILESTONES.find((m) => m.id === id)
            : MILESTONES.find((m) => m.id === id);
          if (!source) return json(404, { message: "404 Milestone Not Found" });
          const state_event = (body as Record<string, unknown> | undefined)?.state_event;
          const state = state_event === "close" ? "closed" : source.state;
          return json(200, { ...source, ...(body as object), state });
        }
        const source = msMatch[1].startsWith("groups")
          ? GROUP_MILESTONES.find((m) => m.id === id)
          : MILESTONES.find((m) => m.id === id);
        return source ? json(200, source) : json(404, { message: "404 Milestone Not Found" });
      }
      // wikis
      if (path === `/${p}/wikis`) {
        if (req.method === "POST") {
          const b = body as Record<string, unknown>;
          return json(201, { slug: String(b.title).toLowerCase().replace(/\s+/g, "-"), ...b });
        }
        const { data, nextPage } = slicePage(WIKIS, url);
        return json(200, data, { "x-next-page": nextPage, "x-total": String(WIKIS.length) });
      }
      const wikiMatch = path.match(/^\/api\/v4\/projects\/itrend\/cxutility\/wikis\/(.+)$/);
      if (wikiMatch) {
        const slug = decodeURIComponent(url.pathname.split("/").pop() ?? "");
        const page = WIKIS.find((w) => w.slug === slug);
        if (!page) return json(404, { message: "404 Wiki Not Found" });
        if (req.method === "PUT") return json(200, { ...page, ...(body as object) });
        return json(200, page);
      }
      // labels
      if (path === `/${p}/labels`) {
        if (req.method === "POST") return json(201, { id: 3, ...(body as object) });
        const { data, nextPage } = slicePage(LABELS, url);
        return json(200, data, { "x-next-page": nextPage, "x-total": String(LABELS.length) });
      }
      return json(404, { message: "404 Not Found" });
    });
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

const DEFAULT = { "x-gitlab-default-project": "itrend/cxutility" };

describe("gitlab_milestone_list", () => {
  it("lists project milestones with the pagination contract", async () => {
    const result = await callTool(buildScope(DEFAULT), "gitlab_milestone_list");
    expect(result.isError).toBe(false);
    const body = JSON.parse(result.text);
    expect(body.items).toHaveLength(2);
    expect(body.pagination).toEqual({ has_more: false, next_cursor: null });
  });

  it("paginates via opaque cursors", async () => {
    const scope = buildScope(DEFAULT);
    const first = await callTool(scope, "gitlab_milestone_list", { limit: 1 });
    const firstBody = JSON.parse(first.text);
    expect(firstBody.items).toHaveLength(1);
    expect(firstBody.pagination.has_more).toBe(true);
    const second = await callTool(scope, "gitlab_milestone_list", {
      cursor: firstBody.pagination.next_cursor,
    });
    expect(JSON.parse(second.text).items).toHaveLength(1);
    expect(JSON.parse(second.text).pagination.has_more).toBe(false);
  });

  it("uses /groups/:id/milestones when the group argument is present", async () => {
    calls.length = 0;
    const result = await callTool(buildScope({}), "gitlab_milestone_list", {
      group: "itrend",
    });
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.text).items.map((m: { id: number }) => m.id)).toEqual([10, 11]);
    expect(calls[calls.length - 1].path).toBe("/api/v4/groups/itrend/milestones");
  });

  it("falls back to the X-GitLab-Default-Group header for group milestones", async () => {
    calls.length = 0;
    const result = await callTool(
      buildScope({ "x-gitlab-default-group": "itrend" }),
      "gitlab_milestone_list",
    );
    expect(result.isError).toBe(false);
    expect(calls[calls.length - 1].path).toBe("/api/v4/groups/itrend/milestones");
  });
});

describe("gitlab_milestone_get", () => {
  it("returns a single project milestone by id", async () => {
    const result = await callTool(buildScope({}), "gitlab_milestone_get", {
      project: "itrend/cxutility",
      milestone_id: 1,
    });
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.text).title).toBe("v1.0");
  });

  it("uses the group endpoint when group is passed", async () => {
    calls.length = 0;
    const result = await callTool(buildScope({}), "gitlab_milestone_get", {
      group: "itrend",
      milestone_id: 10,
    });
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.text).id).toBe(10);
    expect(calls[calls.length - 1].path).toBe("/api/v4/groups/itrend/milestones/10");
  });

  it("missing project and group → VALIDATION_ERROR", async () => {
    const result = await callTool(buildScope({}), "gitlab_milestone_get", { milestone_id: 1 });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/^ERROR VALIDATION_ERROR: missing required argument 'project'/);
  });
});

describe("gitlab_milestone_create", () => {
  it("POSTs title/description/dates to the project milestones endpoint", async () => {
    calls.length = 0;
    const result = await callTool(buildScope({}), "gitlab_milestone_create", {
      project: "itrend/cxutility",
      title: "v3.0",
      description: "Next major",
      due_date: "2026-12-31",
      start_date: "2026-10-01",
    });
    expect(result.isError).toBe(false);
    const created = JSON.parse(result.text);
    expect(created.id).toBe(3);
    expect(created.title).toBe("v3.0");
    const call = calls[calls.length - 1];
    expect(call.method).toBe("POST");
    expect(call.path).toBe("/api/v4/projects/itrend/cxutility/milestones");
    expect(call.body).toEqual({
      title: "v3.0",
      description: "Next major",
      due_date: "2026-12-31",
      start_date: "2026-10-01",
    });
  });

  it("requested scope without project-write → POLICY_SCOPE_MISSING", async () => {
    const result = await callTool(
      buildScope({ "x-gitlab-request-scope": "read" }),
      "gitlab_milestone_create",
      { project: "itrend/cxutility", title: "Denied" },
    );
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/^ERROR POLICY_SCOPE_MISSING: .*project-write/);
  });
});

describe("gitlab_milestone_update", () => {
  it("PUTs only the provided fields, including state_event", async () => {
    calls.length = 0;
    const result = await callTool(buildScope({}), "gitlab_milestone_update", {
      project: "itrend/cxutility",
      milestone_id: 1,
      title: "v1.0 final",
      state_event: "close",
    });
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.text).state).toBe("closed");
    const call = calls[calls.length - 1];
    expect(call.method).toBe("PUT");
    expect(call.path).toBe("/api/v4/projects/itrend/cxutility/milestones/1");
    expect(call.body).toEqual({ title: "v1.0 final", state_event: "close" });
  });

  it("requested scope without project-write → POLICY_SCOPE_MISSING", async () => {
    const result = await callTool(
      buildScope({ "x-gitlab-request-scope": "read" }),
      "gitlab_milestone_update",
      { project: "itrend/cxutility", milestone_id: 1, title: "Denied" },
    );
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/^ERROR POLICY_SCOPE_MISSING: /);
  });

  it("rejects unknown arguments with VALIDATION_ERROR", async () => {
    const result = await callTool(buildScope({}), "gitlab_milestone_update", {
      project: "itrend/cxutility",
      milestone_id: 1,
      labels: "x",
    });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/^ERROR VALIDATION_ERROR: unknown argument\(s\): labels$/);
  });
});

describe("gitlab_wiki_list", () => {
  it("lists wiki pages with the pagination contract", async () => {
    const result = await callTool(buildScope(DEFAULT), "gitlab_wiki_list");
    expect(result.isError).toBe(false);
    const body = JSON.parse(result.text);
    expect(body.items.map((w: { slug: string }) => w.slug)).toEqual(["home", "setup-guide"]);
    expect(body.pagination).toEqual({ has_more: false, next_cursor: null });
  });
});

describe("gitlab_wiki_get", () => {
  it("returns a wiki page by slug, URL-encoding special characters", async () => {
    calls.length = 0;
    const result = await callTool(buildScope(DEFAULT), "gitlab_wiki_get", { slug: "home" });
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.text).title).toBe("Home");
    expect(calls[calls.length - 1].path).toBe("/api/v4/projects/itrend/cxutility/wikis/home");
  });

  it("falls back to the X-GitLab-Default-Project header", async () => {
    const result = await callTool(buildScope({}), "gitlab_wiki_get", {
      project: "itrend/cxutility",
      slug: "setup-guide",
    });
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.text).slug).toBe("setup-guide");
  });

  it("missing project → VALIDATION_ERROR", async () => {
    const result = await callTool(buildScope({}), "gitlab_wiki_get", { slug: "home" });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/^ERROR VALIDATION_ERROR: missing required argument 'project'/);
  });
});

describe("gitlab_wiki_create", () => {
  it("POSTs title/content/format to the wikis endpoint", async () => {
    calls.length = 0;
    const result = await callTool(buildScope({}), "gitlab_wiki_create", {
      project: "itrend/cxutility",
      title: "Runbook",
      content: "# Runbook\n\nStep 1.",
      format: "markdown",
    });
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.text).slug).toBe("runbook");
    const call = calls[calls.length - 1];
    expect(call.method).toBe("POST");
    expect(call.path).toBe("/api/v4/projects/itrend/cxutility/wikis");
    expect(call.body).toEqual({
      title: "Runbook",
      content: "# Runbook\n\nStep 1.",
      format: "markdown",
    });
  });

  it("requested scope without project-write → POLICY_SCOPE_MISSING", async () => {
    const result = await callTool(
      buildScope({ "x-gitlab-request-scope": "read" }),
      "gitlab_wiki_create",
      { project: "itrend/cxutility", title: "Denied", content: "nope" },
    );
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/^ERROR POLICY_SCOPE_MISSING: /);
  });
});

describe("gitlab_wiki_update", () => {
  it("PUTs the provided fields to the wiki page endpoint", async () => {
    calls.length = 0;
    const result = await callTool(buildScope({}), "gitlab_wiki_update", {
      project: "itrend/cxutility",
      slug: "home",
      content: "# Home (updated)",
    });
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.text).content).toBe("# Home (updated)");
    const call = calls[calls.length - 1];
    expect(call.method).toBe("PUT");
    expect(call.path).toBe("/api/v4/projects/itrend/cxutility/wikis/home");
    expect(call.body).toEqual({ content: "# Home (updated)" });
  });

  it("requested scope without project-write → POLICY_SCOPE_MISSING", async () => {
    const result = await callTool(
      buildScope({ "x-gitlab-request-scope": "read" }),
      "gitlab_wiki_update",
      { project: "itrend/cxutility", slug: "home", content: "denied" },
    );
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/^ERROR POLICY_SCOPE_MISSING: /);
  });
});

describe("gitlab_label_list", () => {
  it("lists labels with the pagination contract", async () => {
    const result = await callTool(buildScope(DEFAULT), "gitlab_label_list");
    expect(result.isError).toBe(false);
    const body = JSON.parse(result.text);
    expect(body.items.map((l: { name: string }) => l.name)).toEqual(["bug", "feature"]);
    expect(body.pagination).toEqual({ has_more: false, next_cursor: null });
  });
});

describe("gitlab_label_create", () => {
  it("POSTs name/color/description/priority to the labels endpoint", async () => {
    calls.length = 0;
    const result = await callTool(buildScope({}), "gitlab_label_create", {
      project: "itrend/cxutility",
      name: "p1",
      color: "#0000FF",
      description: "Top priority",
      priority: 1,
    });
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.text).id).toBe(3);
    const call = calls[calls.length - 1];
    expect(call.method).toBe("POST");
    expect(call.path).toBe("/api/v4/projects/itrend/cxutility/labels");
    expect(call.body).toEqual({
      name: "p1",
      color: "#0000FF",
      description: "Top priority",
      priority: 1,
    });
  });

  it("non-hex color is rejected by schema validation", async () => {
    const result = await callTool(buildScope({}), "gitlab_label_create", {
      project: "itrend/cxutility",
      name: "p2",
      color: "blue",
    });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/color must be a hex value/);
  });

  it("requested scope without project-write → POLICY_SCOPE_MISSING", async () => {
    const result = await callTool(
      buildScope({ "x-gitlab-request-scope": "read" }),
      "gitlab_label_create",
      { project: "itrend/cxutility", name: "denied", color: "#000000" },
    );
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/^ERROR POLICY_SCOPE_MISSING: /);
  });

  it("explicit project outside Project Scope → SCOPE_PROJECT_NOT_ALLOWED", async () => {
    const result = await callTool(
      buildScope({ "x-gitlab-project-scope": "itrend/*" }),
      "gitlab_label_create",
      { project: "vendor/external", name: "nope", color: "#000000" },
    );
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/^ERROR SCOPE_PROJECT_NOT_ALLOWED: /);
  });
});
