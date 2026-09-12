/**
 * Contract tests for the merge request domain tools (issue #8, tool-spec
 * §Merge Request): full stack per call — gateway → policy engine → GitLab
 * client → handler — against a mock GitLab HTTP server. Covers WRITE tools
 * requiring `mr-write`, the PRIVILEGED merge requiring the dedicated
 * `mr-merge` scope (mr-write alone → POLICY_SCOPE_MISSING), diff truncation
 * (FR-13), pagination and default-project fallback.
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

const TOKEN = "glpat-mr-tools-test";
const IDENTITY = { id: 42, username: "marcus", name: "Marcus Y" };

const MRS = [
  {
    iid: 1,
    title: "First MR",
    state: "opened",
    source_branch: "feature/one",
    target_branch: "main",
  },
  {
    iid: 2,
    title: "Second MR",
    state: "merged",
    source_branch: "feature/two",
    target_branch: "release",
  },
  {
    iid: 3,
    title: "Third MR",
    state: "opened",
    source_branch: "feature/three",
    target_branch: "main",
  },
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
      // MR list / create: /api/v4/projects/:id/merge_requests
      if (path === "/api/v4/projects/itrend/cxutility/merge_requests") {
        if (req.method === "POST") {
          return json(201, { iid: 4, state: "opened", ...body });
        }
        let rows = MRS;
        const state = url.searchParams.get("state");
        if (state) rows = rows.filter((m) => m.state === state);
        const targetBranch = url.searchParams.get("target_branch");
        if (targetBranch) rows = rows.filter((m) => m.target_branch === targetBranch);
        const { data, nextPage } = slicePage(rows, url);
        return json(200, data, { "x-next-page": nextPage, "x-total": String(rows.length) });
      }
      // MR detail / update: /merge_requests/:iid
      const mrMatch = path.match(/^\/api\/v4\/projects\/itrend\/cxutility\/merge_requests\/(\d+)$/);
      if (mrMatch) {
        const iid = Number(mrMatch[1]);
        const mr = MRS.find((m) => m.iid === iid);
        if (!mr) return json(404, { message: "404 Merge Request Not Found" });
        if (req.method === "PUT") {
          const { state_event, ...rest } = body as Record<string, unknown>;
          const state =
            state_event === "close" ? "closed" : state_event === "reopen" ? "opened" : mr.state;
          return json(200, { ...mr, ...rest, state });
        }
        return json(200, mr);
      }
      // MR diffs: /merge_requests/:iid/diffs
      const diffsMatch = path.match(
        /^\/api\/v4\/projects\/itrend\/cxutility\/merge_requests\/(\d+)\/diffs$/,
      );
      if (diffsMatch && req.method === "GET") {
        const huge = "x".repeat(5000);
        return json(200, [
          { old_path: "src/a.ts", new_path: "src/a.ts", diff: `@@ -1 +1 @@\n-hello\n+${huge}` },
          { old_path: "src/b.ts", new_path: "src/b.ts", diff: "@@ -1 +1 @@\n-world\n+world!" },
        ]);
      }
      // MR notes: /merge_requests/:iid/notes
      const notesMatch = path.match(
        /^\/api\/v4\/projects\/itrend\/cxutility\/merge_requests\/(\d+)\/notes$/,
      );
      if (notesMatch && req.method === "POST") {
        return json(201, { id: 9001, noteable_iid: Number(notesMatch[1]), ...body });
      }
      // MR merge: /merge_requests/:iid/merge
      const mergeMatch = path.match(
        /^\/api\/v4\/projects\/itrend\/cxutility\/merge_requests\/(\d+)\/merge$/,
      );
      if (mergeMatch && req.method === "PUT") {
        const iid = Number(mergeMatch[1]);
        const mr = MRS.find((m) => m.iid === iid);
        if (!mr) return json(404, { message: "404 Merge Request Not Found" });
        return json(200, { ...mr, state: "merged", merge_commit_sha: "abc999", ...body });
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

function buildScope(
  headerEnv: Record<string, string>,
  configEnv: Record<string, string> = {},
): RequestScope {
  return {
    headers: {
      "x-gitlab-url": gitlabUrl,
      "x-gitlab-token": TOKEN,
      ...headerEnv,
    },
    config: loadConfig({
      GITLAB_MCP_ALLOWED_HOSTS: "127.0.0.1,localhost",
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

describe("gitlab_mr_list", () => {
  it("lists MRs with the pagination contract", async () => {
    const result = await callTool(
      buildScope({ "x-gitlab-default-project": "itrend/cxutility" }),
      "gitlab_mr_list",
    );
    expect(result.isError).toBe(false);
    const body = JSON.parse(result.text);
    expect(body.items).toHaveLength(3);
    expect(body.pagination).toEqual({ has_more: false, next_cursor: null });
  });

  it("paginates via opaque cursors", async () => {
    const scope = buildScope({ "x-gitlab-default-project": "itrend/cxutility" });
    const first = await callTool(scope, "gitlab_mr_list", { limit: 2 });
    const firstBody = JSON.parse(first.text);
    expect(firstBody.items.map((m: { iid: number }) => m.iid)).toEqual([1, 2]);
    expect(firstBody.pagination.has_more).toBe(true);

    const second = await callTool(scope, "gitlab_mr_list", {
      cursor: firstBody.pagination.next_cursor,
    });
    const secondBody = JSON.parse(second.text);
    expect(secondBody.items.map((m: { iid: number }) => m.iid)).toEqual([3]);
    expect(secondBody.pagination).toEqual({ has_more: false, next_cursor: null });
  });

  it("sends state and target_branch filters as query params", async () => {
    calls.length = 0;
    const result = await callTool(
      buildScope({ "x-gitlab-default-project": "itrend/cxutility" }),
      "gitlab_mr_list",
      { state: "opened", target_branch: "main" },
    );
    expect(result.isError).toBe(false);
    const last = calls[calls.length - 1];
    expect(last.method).toBe("GET");
    expect(last.path).toBe("/api/v4/projects/itrend/cxutility/merge_requests");
    expect(last.query.state).toBe("opened");
    expect(last.query.target_branch).toBe("main");
    expect(JSON.parse(result.text).items.map((m: { iid: number }) => m.iid)).toEqual([1, 3]);
  });

  it("project outside Project Scope → SCOPE_PROJECT_NOT_ALLOWED", async () => {
    const result = await callTool(
      buildScope({ "x-gitlab-project-scope": "itrend/*" }),
      "gitlab_mr_list",
      { project: "other/thing" },
    );
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/^ERROR SCOPE_PROJECT_NOT_ALLOWED: /);
  });
});

describe("gitlab_mr_get", () => {
  it("returns a single MR by iid, URL-encoding the project path", async () => {
    const result = await callTool(
      buildScope({}),
      "gitlab_mr_get",
      { project: "itrend/cxutility", mr_iid: 2 },
    );
    expect(result.isError).toBe(false);
    const mr = JSON.parse(result.text);
    expect(mr.iid).toBe(2);
    expect(mr.state).toBe("merged");
  });

  it("falls back to the X-GitLab-Default-Project header when project is omitted", async () => {
    const result = await callTool(
      buildScope({ "x-gitlab-default-project": "itrend/cxutility" }),
      "gitlab_mr_get",
      { mr_iid: 1 },
    );
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.text).iid).toBe(1);
  });

  it("missing project without default header → VALIDATION_ERROR", async () => {
    const result = await callTool(buildScope({}), "gitlab_mr_get", { mr_iid: 1 });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/^ERROR VALIDATION_ERROR: missing required argument 'project'/);
  });
});

describe("gitlab_mr_create", () => {
  it("POSTs source/target/title/description/remove_source_branch and returns the created MR", async () => {
    calls.length = 0;
    const result = await callTool(
      buildScope({}),
      "gitlab_mr_create",
      {
        project: "itrend/cxutility",
        source_branch: "feature/new",
        target_branch: "main",
        title: "New feature",
        description: "Adds a feature",
        remove_source_branch: true,
      },
    );
    expect(result.isError).toBe(false);
    const created = JSON.parse(result.text);
    expect(created.iid).toBe(4);
    expect(created.source_branch).toBe("feature/new");
    const call = calls[calls.length - 1];
    expect(call.method).toBe("POST");
    expect(call.path).toBe("/api/v4/projects/itrend/cxutility/merge_requests");
    expect(call.body).toEqual({
      source_branch: "feature/new",
      target_branch: "main",
      title: "New feature",
      description: "Adds a feature",
      remove_source_branch: true,
    });
  });

  it("omitting project uses the X-GitLab-Default-Project header", async () => {
    calls.length = 0;
    const result = await callTool(
      buildScope({ "x-gitlab-default-project": "itrend/cxutility" }),
      "gitlab_mr_create",
      { source_branch: "f", target_branch: "main", title: "From default" },
    );
    expect(result.isError).toBe(false);
    expect(calls[calls.length - 1].path).toBe(
      "/api/v4/projects/itrend/cxutility/merge_requests",
    );
  });

  it("requested scope without mr-write → POLICY_SCOPE_MISSING", async () => {
    const result = await callTool(
      buildScope({ "x-gitlab-request-scope": "read" }),
      "gitlab_mr_create",
      {
        project: "itrend/cxutility",
        source_branch: "f",
        target_branch: "main",
        title: "Denied",
      },
    );
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/^ERROR POLICY_SCOPE_MISSING: .*mr-write/);
  });

  it("rejects unknown arguments with VALIDATION_ERROR", async () => {
    const result = await callTool(
      buildScope({}),
      "gitlab_mr_create",
      {
        project: "itrend/cxutility",
        source_branch: "f",
        target_branch: "main",
        title: "x",
        squash: true,
      },
    );
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/^ERROR VALIDATION_ERROR: unknown argument\(s\): squash$/);
  });
});

describe("gitlab_mr_update", () => {
  it("PUTs only the provided fields to the MR endpoint", async () => {
    calls.length = 0;
    const result = await callTool(
      buildScope({}),
      "gitlab_mr_update",
      { project: "itrend/cxutility", mr_iid: 1, title: "Renamed" },
    );
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.text).title).toBe("Renamed");
    const call = calls[calls.length - 1];
    expect(call.method).toBe("PUT");
    expect(call.path).toBe("/api/v4/projects/itrend/cxutility/merge_requests/1");
    expect(call.body).toEqual({ title: "Renamed" });
  });

  it("supports state_event close/reopen", async () => {
    calls.length = 0;
    const result = await callTool(
      buildScope({ "x-gitlab-request-scope": "mr-write" }),
      "gitlab_mr_update",
      { project: "itrend/cxutility", mr_iid: 1, state_event: "close" },
    );
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.text).state).toBe("closed");
    expect(calls[calls.length - 1].body).toEqual({ state_event: "close" });
  });

  it("requested scope without mr-write → POLICY_SCOPE_MISSING", async () => {
    const result = await callTool(
      buildScope({ "x-gitlab-request-scope": "read" }),
      "gitlab_mr_update",
      { project: "itrend/cxutility", mr_iid: 1, title: "Denied" },
    );
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/^ERROR POLICY_SCOPE_MISSING: /);
  });
});

describe("gitlab_mr_diff", () => {
  it("keeps the per-file list structure when it fits the size cap", async () => {
    const result = await callTool(
      buildScope({}, { GITLAB_MCP_MAX_BYTES: "65536" }),
      "gitlab_mr_diff",
      { project: "itrend/cxutility", mr_iid: 1 },
    );
    expect(result.isError).toBe(false);
    const body = JSON.parse(result.text);
    expect(body.truncated).toBe(false);
    expect(body.files).toHaveLength(2);
    expect(body.files[0].new_path).toBe("src/a.ts");
  });

  it("truncates from the start with truncated:true when over the cap", async () => {
    const result = await callTool(
      buildScope({}, { GITLAB_MCP_MAX_BYTES: "512" }),
      "gitlab_mr_diff",
      { project: "itrend/cxutility", mr_iid: 1 },
    );
    expect(result.isError).toBe(false);
    const body = JSON.parse(result.text);
    expect(body.truncated).toBe(true);
    expect(body.original_bytes).toBeGreaterThan(512);
    expect(Buffer.byteLength(body.content, "utf8")).toBeLessThanOrEqual(512);
    expect(body.continuation_hint).toMatch(/truncated from the start/);
    // Latest content survives: the tail of the joined diff is present.
    expect(body.content).toContain("world!");
    expect(body.file_count).toBe(2);
  });
});

describe("gitlab_mr_comment", () => {
  it("POSTs the note body to /merge_requests/:iid/notes", async () => {
    calls.length = 0;
    const result = await callTool(
      buildScope({}),
      "gitlab_mr_comment",
      { project: "itrend/cxutility", mr_iid: 3, body: "LGTM." },
    );
    expect(result.isError).toBe(false);
    const note = JSON.parse(result.text);
    expect(note.noteable_iid).toBe(3);
    expect(note.body).toBe("LGTM.");
    const call = calls[calls.length - 1];
    expect(call.method).toBe("POST");
    expect(call.path).toBe("/api/v4/projects/itrend/cxutility/merge_requests/3/notes");
    expect(call.body).toEqual({ body: "LGTM." });
  });

  it("requested scope without mr-write → POLICY_SCOPE_MISSING", async () => {
    const result = await callTool(
      buildScope({ "x-gitlab-request-scope": "read" }),
      "gitlab_mr_comment",
      { project: "itrend/cxutility", mr_iid: 3, body: "Denied." },
    );
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/^ERROR POLICY_SCOPE_MISSING: /);
  });
});

describe("gitlab_mr_merge", () => {
  it("merges when the mr-merge scope is present", async () => {
    calls.length = 0;
    const result = await callTool(
      buildScope({ "x-gitlab-request-scope": "mr-write,mr-merge" }),
      "gitlab_mr_merge",
      {
        project: "itrend/cxutility",
        mr_iid: 1,
        merge_when_pipeline_succeeds: true,
      },
    );
    expect(result.isError).toBe(false);
    const merged = JSON.parse(result.text);
    expect(merged.state).toBe("merged");
    const call = calls[calls.length - 1];
    expect(call.method).toBe("PUT");
    expect(call.path).toBe("/api/v4/projects/itrend/cxutility/merge_requests/1/merge");
    expect(call.body).toEqual({ merge_when_pipeline_succeeds: true });
  });

  it("merges with an absent request-scope header (default allows all scopes)", async () => {
    const result = await callTool(
      buildScope({}),
      "gitlab_mr_merge",
      { project: "itrend/cxutility", mr_iid: 1 },
    );
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.text).state).toBe("merged");
    expect(calls[calls.length - 1].body).toEqual({});
  });

  it("mr-write present but mr-merge absent → POLICY_SCOPE_MISSING", async () => {
    const result = await callTool(
      buildScope({ "x-gitlab-request-scope": "mr-write" }),
      "gitlab_mr_merge",
      { project: "itrend/cxutility", mr_iid: 1 },
    );
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/^ERROR POLICY_SCOPE_MISSING: .*mr-merge/);
  });

  it("read-only requested scope → POLICY_SCOPE_MISSING", async () => {
    const result = await callTool(
      buildScope({ "x-gitlab-request-scope": "read" }),
      "gitlab_mr_merge",
      { project: "itrend/cxutility", mr_iid: 1 },
    );
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/^ERROR POLICY_SCOPE_MISSING: /);
  });

  it("project outside Project Scope → SCOPE_PROJECT_NOT_ALLOWED", async () => {
    const result = await callTool(
      buildScope({ "x-gitlab-project-scope": "itrend/*" }),
      "gitlab_mr_merge",
      { project: "vendor/other", mr_iid: 1 },
    );
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/^ERROR SCOPE_PROJECT_NOT_ALLOWED: /);
  });
});
