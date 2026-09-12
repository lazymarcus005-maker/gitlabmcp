/**
 * Contract tests for the issue domain tools (issue #5, tool-spec §Issue):
 * full stack per call — gateway → policy engine → GitLab client → handler —
 * against a mock GitLab HTTP server. Covers the first WRITE path: WRITE tools
 * require the `issue-write` scope (FR-7), default-project fallback, project
 * scope enforcement and VALIDATION_ERROR for unknown args.
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

const TOKEN = "glpat-issue-tools-test";
const IDENTITY = { id: 42, username: "marcus", name: "Marcus Y" };

const ISSUES = [
  { iid: 1, title: "First issue", state: "opened", labels: ["bug"] },
  { iid: 2, title: "Second issue", state: "closed", labels: [] },
  { iid: 3, title: "Third issue", state: "opened", labels: ["feature"] },
];

let gitlab: Server;
let gitlabUrl: string;

/** Recorded GitLab requests: method, decoded path, query, parsed JSON body. */
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
      // issue list / create: /api/v4/projects/:id/issues
      if (path === "/api/v4/projects/itrend/cxutility/issues") {
        if (req.method === "POST") {
          return json(201, { iid: 4, state: "opened", ...body });
        }
        let rows = ISSUES;
        const state = url.searchParams.get("state");
        if (state) rows = rows.filter((i) => i.state === state);
        const search = url.searchParams.get("search");
        if (search) rows = rows.filter((i) => i.title.includes(search));
        const labels = url.searchParams.get("labels");
        if (labels) rows = rows.filter((i) => i.labels.some((l) => l === labels));
        const assignee = url.searchParams.get("assignee_username");
        if (assignee) rows = rows.filter((i) => i.iid === 1);
        const { data, nextPage } = slicePage(rows, url);
        return json(200, data, { "x-next-page": nextPage, "x-total": String(rows.length) });
      }
      // issue detail / update: /api/v4/projects/:id/issues/:iid
      const issueMatch = path.match(/^\/api\/v4\/projects\/itrend\/cxutility\/issues\/(\d+)$/);
      if (issueMatch) {
        const iid = Number(issueMatch[1]);
        const issue = ISSUES.find((i) => i.iid === iid);
        if (!issue) return json(404, { message: "404 Issue Not Found" });
        if (req.method === "POST") {
          const { state_event, ...rest } = body as Record<string, unknown>;
          const state =
            state_event === "close" ? "closed" : state_event === "reopen" ? "opened" : issue.state;
          return json(200, { ...issue, ...rest, state });
        }
        return json(200, issue);
      }
      // issue notes: /api/v4/projects/:id/issues/:iid/notes
      const notesMatch = path.match(
        /^\/api\/v4\/projects\/itrend\/cxutility\/issues\/(\d+)\/notes$/,
      );
      if (notesMatch && req.method === "POST") {
        return json(201, { id: 9001, noteable_iid: Number(notesMatch[1]), ...body });
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

describe("gitlab_issue_list", () => {
  it("lists issues with the pagination contract", async () => {
    const result = await callTool(
      buildScope({ "x-gitlab-default-project": "itrend/cxutility" }),
      "gitlab_issue_list",
    );
    expect(result.isError).toBe(false);
    const body = JSON.parse(result.text);
    expect(body.items).toHaveLength(3);
    expect(body.pagination).toEqual({ has_more: false, next_cursor: null });
  });

  it("paginates via opaque cursors", async () => {
    const scope = buildScope({ "x-gitlab-default-project": "itrend/cxutility" });
    const first = await callTool(scope, "gitlab_issue_list", { limit: 2 });
    const firstBody = JSON.parse(first.text);
    expect(firstBody.items.map((i: { iid: number }) => i.iid)).toEqual([1, 2]);
    expect(firstBody.pagination.has_more).toBe(true);

    const second = await callTool(scope, "gitlab_issue_list", {
      cursor: firstBody.pagination.next_cursor,
    });
    const secondBody = JSON.parse(second.text);
    expect(secondBody.items.map((i: { iid: number }) => i.iid)).toEqual([3]);
    expect(secondBody.pagination).toEqual({ has_more: false, next_cursor: null });
  });

  it("sends state/labels/search/assignee filters as query params", async () => {
    calls.length = 0;
    const result = await callTool(
      buildScope({ "x-gitlab-default-project": "itrend/cxutility" }),
      "gitlab_issue_list",
      { state: "opened", labels: "bug", search: "First", assignee: "marcus" },
    );
    expect(result.isError).toBe(false);
    const last = calls[calls.length - 1];
    expect(last.method).toBe("GET");
    expect(last.path).toBe("/api/v4/projects/itrend/cxutility/issues");
    expect(last.query.state).toBe("opened");
    expect(last.query.labels).toBe("bug");
    expect(last.query.search).toBe("First");
    expect(last.query.assignee_username).toBe("marcus");
  });

  it("applies state and labels filtering server-side via query params", async () => {
    const opened = await callTool(
      buildScope({ "x-gitlab-default-project": "itrend/cxutility" }),
      "gitlab_issue_list",
      { state: "opened" },
    );
    expect(JSON.parse(opened.text).items.map((i: { iid: number }) => i.iid)).toEqual([1, 3]);

    const labeled = await callTool(
      buildScope({ "x-gitlab-default-project": "itrend/cxutility" }),
      "gitlab_issue_list",
      { labels: "feature" },
    );
    expect(JSON.parse(labeled.text).items.map((i: { iid: number }) => i.iid)).toEqual([3]);
  });

  it("project outside Project Scope → SCOPE_PROJECT_NOT_ALLOWED", async () => {
    const result = await callTool(
      buildScope({ "x-gitlab-project-scope": "itrend/*" }),
      "gitlab_issue_list",
      { project: "other/thing" },
    );
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/^ERROR SCOPE_PROJECT_NOT_ALLOWED: /);
  });

  it("rejects unknown arguments with VALIDATION_ERROR", async () => {
    const result = await callTool(
      buildScope({ "x-gitlab-default-project": "itrend/cxutility" }),
      "gitlab_issue_list",
      { weight: 2 },
    );
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/^ERROR VALIDATION_ERROR: unknown argument\(s\): weight$/);
  });
});

describe("gitlab_issue_get", () => {
  it("returns a single issue by iid, URL-encoding the project path", async () => {
    const result = await callTool(
      buildScope({}),
      "gitlab_issue_get",
      { project: "itrend/cxutility", iid: 2 },
    );
    expect(result.isError).toBe(false);
    const issue = JSON.parse(result.text);
    expect(issue.iid).toBe(2);
    expect(issue.state).toBe("closed");
  });

  it("falls back to the X-GitLab-Default-Project header when project is omitted", async () => {
    const result = await callTool(
      buildScope({ "x-gitlab-default-project": "itrend/cxutility" }),
      "gitlab_issue_get",
      { iid: 1 },
    );
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.text).iid).toBe(1);
  });

  it("missing project without default header → VALIDATION_ERROR", async () => {
    const result = await callTool(buildScope({}), "gitlab_issue_get", { iid: 1 });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/^ERROR VALIDATION_ERROR: missing required argument 'project'/);
  });

  it("unknown issue → GITLAB_API_ERROR (404 surfaced)", async () => {
    const result = await callTool(
      buildScope({}),
      "gitlab_issue_get",
      { project: "itrend/cxutility", iid: 999 },
    );
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/^ERROR GITLAB_API_ERROR: GitLab returned HTTP 404/);
  });
});

describe("gitlab_issue_create", () => {
  it("POSTs title/description/labels/assignee_ids and returns the created issue", async () => {
    calls.length = 0;
    const result = await callTool(
      buildScope({}),
      "gitlab_issue_create",
      {
        project: "itrend/cxutility",
        title: "New bug",
        description: "It broke",
        labels: "bug,p1",
        assignee_ids: [11, 12],
      },
    );
    expect(result.isError).toBe(false);
    const created = JSON.parse(result.text);
    expect(created.iid).toBe(4);
    expect(created.title).toBe("New bug");
    const call = calls[calls.length - 1];
    expect(call.method).toBe("POST");
    expect(call.path).toBe("/api/v4/projects/itrend/cxutility/issues");
    expect(call.body).toEqual({
      title: "New bug",
      description: "It broke",
      labels: "bug,p1",
      assignee_ids: [11, 12],
    });
  });

  it("omitting project uses the X-GitLab-Default-Project header", async () => {
    calls.length = 0;
    const result = await callTool(
      buildScope({ "x-gitlab-default-project": "itrend/cxutility" }),
      "gitlab_issue_create",
      { title: "From default" },
    );
    expect(result.isError).toBe(false);
    expect(calls[calls.length - 1].path).toBe("/api/v4/projects/itrend/cxutility/issues");
    expect(calls[calls.length - 1].body).toEqual({ title: "From default" });
  });

  it("requested scope without issue-write → POLICY_SCOPE_MISSING", async () => {
    const result = await callTool(
      buildScope({ "x-gitlab-request-scope": "read" }),
      "gitlab_issue_create",
      { project: "itrend/cxutility", title: "Denied" },
    );
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/^ERROR POLICY_SCOPE_MISSING: .*issue-write/);
  });

  it("explicit project outside Project Scope → SCOPE_PROJECT_NOT_ALLOWED", async () => {
    const result = await callTool(
      buildScope({ "x-gitlab-project-scope": "itrend/*" }),
      "gitlab_issue_create",
      { project: "vendor/external", title: "Nope" },
    );
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/^ERROR SCOPE_PROJECT_NOT_ALLOWED: .*vendor\/external/);
  });
});

describe("gitlab_issue_update", () => {
  it("POSTs only the provided fields to the issue endpoint", async () => {
    calls.length = 0;
    const result = await callTool(
      buildScope({}),
      "gitlab_issue_update",
      { project: "itrend/cxutility", iid: 1, labels: "bug,confirmed" },
    );
    expect(result.isError).toBe(false);
    const call = calls[calls.length - 1];
    expect(call.method).toBe("POST");
    expect(call.path).toBe("/api/v4/projects/itrend/cxutility/issues/1");
    expect(call.body).toEqual({ labels: "bug,confirmed" });
  });

  it("supports state_event close/reopen", async () => {
    calls.length = 0;
    const result = await callTool(
      buildScope({}),
      "gitlab_issue_update",
      { project: "itrend/cxutility", iid: 1, state_event: "close" },
    );
    expect(result.isError).toBe(false);
    expect(calls[calls.length - 1].body).toEqual({ state_event: "close" });
  });

  it("requested scope without issue-write → POLICY_SCOPE_MISSING", async () => {
    const result = await callTool(
      buildScope({ "x-gitlab-request-scope": "read" }),
      "gitlab_issue_update",
      { project: "itrend/cxutility", iid: 1, title: "Denied" },
    );
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/^ERROR POLICY_SCOPE_MISSING: /);
  });

  it("rejects unknown arguments with VALIDATION_ERROR", async () => {
    const result = await callTool(
      buildScope({}),
      "gitlab_issue_update",
      { project: "itrend/cxutility", iid: 1, due_date: "2026-01-01" },
    );
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/^ERROR VALIDATION_ERROR: unknown argument\(s\): due_date$/);
  });
});

describe("gitlab_issue_close / gitlab_issue_reopen", () => {
  it("close POSTs state_event=close to the issue endpoint", async () => {
    calls.length = 0;
    const result = await callTool(
      buildScope({}),
      "gitlab_issue_close",
      { project: "itrend/cxutility", iid: 1 },
    );
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.text).state).toBe("closed");
    const call = calls[calls.length - 1];
    expect(call.method).toBe("POST");
    expect(call.path).toBe("/api/v4/projects/itrend/cxutility/issues/1");
    expect(call.body).toEqual({ state_event: "close" });
  });

  it("reopen POSTs state_event=reopen to the issue endpoint", async () => {
    calls.length = 0;
    const result = await callTool(
      buildScope({}),
      "gitlab_issue_reopen",
      { project: "itrend/cxutility", iid: 2 },
    );
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.text).state).toBe("opened");
    const call = calls[calls.length - 1];
    expect(call.method).toBe("POST");
    expect(call.path).toBe("/api/v4/projects/itrend/cxutility/issues/2");
    expect(call.body).toEqual({ state_event: "reopen" });
  });

  it("read-only requested scope → POLICY_SCOPE_MISSING on close", async () => {
    const result = await callTool(
      buildScope({ "x-gitlab-request-scope": "read" }),
      "gitlab_issue_close",
      { project: "itrend/cxutility", iid: 1 },
    );
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/^ERROR POLICY_SCOPE_MISSING: /);
  });
});

describe("gitlab_issue_comment", () => {
  it("POSTs the note body to /issues/:iid/notes", async () => {
    calls.length = 0;
    const result = await callTool(
      buildScope({}),
      "gitlab_issue_comment",
      { project: "itrend/cxutility", iid: 3, body: "Looking into this." },
    );
    expect(result.isError).toBe(false);
    const note = JSON.parse(result.text);
    expect(note.noteable_iid).toBe(3);
    expect(note.body).toBe("Looking into this.");
    const call = calls[calls.length - 1];
    expect(call.method).toBe("POST");
    expect(call.path).toBe("/api/v4/projects/itrend/cxutility/issues/3/notes");
    expect(call.body).toEqual({ body: "Looking into this." });
  });

  it("requested scope without issue-write → POLICY_SCOPE_MISSING", async () => {
    const result = await callTool(
      buildScope({ "x-gitlab-request-scope": "read" }),
      "gitlab_issue_comment",
      { project: "itrend/cxutility", iid: 3, body: "Denied." },
    );
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/^ERROR POLICY_SCOPE_MISSING: /);
  });

  it("rejects unknown arguments with VALIDATION_ERROR", async () => {
    const result = await callTool(
      buildScope({}),
      "gitlab_issue_comment",
      { project: "itrend/cxutility", iid: 3, body: "hi", confidential: true },
    );
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/^ERROR VALIDATION_ERROR: unknown argument\(s\): confidential$/);
  });
});
