/**
 * Contract tests for the work item tools (issue #6, tool-spec §Work Item,
 * ADR-0003): full stack per call — gateway → policy engine → GitLab client →
 * handler — against a mock GitLab HTTP server. Covers endpoint/method/body
 * contracts, description round-trip idempotency, self-link rejection,
 * cross-project rejection, and scope denial without `issue-write`.
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

const TOKEN = "glpat-work-item-test";
const IDENTITY = { id: 42, username: "marcus", name: "Marcus Y" };

/** Mutable issue store: descriptions change as tools PUT updates. */
const issues = new Map<number, { iid: number; title: string; description: string }>();
issues.set(1, {
  iid: 1,
  title: "Parent",
  description: "# Parent\n\nSome intro text.\n- [ ] #2\n- [x] #3",
});
issues.set(2, { iid: 2, title: "Child two", description: "" });
issues.set(3, { iid: 3, title: "Child three", description: "" });
issues.set(4, { iid: 4, title: "Child four", description: "" });
issues.set(5, { iid: 5, title: "Target", description: "" });
issues.set(6, { iid: 6, title: "Ghost parent", description: "- [ ] #999\n- [x] #2" });

/** Issue links keyed by `${a}-${b}` (unordered pair). */
const links = new Map<string, { id: number; link_type: string; a: number; b: number }>();
let nextLinkId = 100;

const calls: Array<{ method: string; path: string; query: Record<string, string>; body?: unknown }> =
  [];

let gitlab: Server;
let gitlabUrl: string;

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

      // Issue detail: /api/v4/projects/itrend/cxutility/issues/:iid
      const issueMatch = path.match(/^\/api\/v4\/projects\/itrend\/cxutility\/issues\/(\d+)$/);
      if (issueMatch) {
        const issue = issues.get(Number(issueMatch[1]));
        if (!issue) return json(404, { message: "404 Issue Not Found" });
        if (req.method === "PUT") {
          const patch = body as Record<string, unknown>;
          if (typeof patch.description === "string") issue.description = patch.description;
          return json(200, issue);
        }
        return json(200, issue);
      }

      // Links collection: /api/v4/projects/:id/issues/:iid/links
      const linksMatch = path.match(
        /^\/api\/v4\/projects\/itrend\/cxutility\/issues\/(\d+)\/links$/,
      );
      if (linksMatch) {
        const iid = Number(linksMatch[1]);
        if (req.method === "POST") {
          const { target_issue_iid, link_type } = body as {
            target_issue_iid: number;
            link_type: string;
          };
          if (!issues.has(target_issue_iid)) {
            return json(404, { message: "404 Issue Not Found" });
          }
          const key = [iid, target_issue_iid].sort((a, b) => a - b).join("-");
          const link = { id: nextLinkId++, link_type, a: iid, b: target_issue_iid };
          links.set(key, link);
          return json(201, {
            id: link.id,
            link_type,
            source_issue: { iid },
            target_issue: { iid: target_issue_iid, title: issues.get(target_issue_iid)?.title },
          });
        }
        if (req.method === "GET") {
          const rows = [...links.values()]
            .filter((l) => l.a === iid || l.b === iid)
            .map((l) => ({
              id: l.id,
              link_type: l.link_type,
              source_issue: { iid: l.a },
              target_issue: { iid: l.b },
            }));
          return json(200, rows, { "x-next-page": "", "x-total": String(rows.length) });
        }
      }

      // Link deletion: /api/v4/projects/:id/issues/:iid/links/:linkId
      const linkDeleteMatch = path.match(
        /^\/api\/v4\/projects\/itrend\/cxutility\/issues\/(\d+)\/links\/(\d+)$/,
      );
      if (linkDeleteMatch && req.method === "DELETE") {
        const linkId = Number(linkDeleteMatch[2]);
        for (const [key, link] of links) {
          if (link.id === linkId) {
            links.delete(key);
            return json(200, { ...link });
          }
        }
        return json(404, { message: "404 Not Found" });
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

beforeAll(() => {
  resetCapabilityLog();
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

const READ_SCOPE = () => buildScope({ "x-gitlab-default-project": "itrend/cxutility" });
const WRITE_SCOPE = () =>
  buildScope({
    "x-gitlab-default-project": "itrend/cxutility",
    "x-gitlab-request-scope": "issue-write",
  });
/** Read-only requested scope: WRITE tools must be denied (POLICY_SCOPE_MISSING). */
const READ_ONLY_SCOPE = () =>
  buildScope({
    "x-gitlab-default-project": "itrend/cxutility",
    "x-gitlab-request-scope": "read",
  });

describe("gitlab_work_item_get", () => {
  it("returns issue data plus hierarchy and dependency views", async () => {
    links.set("1-5", { id: 77, link_type: "blocks", a: 1, b: 5 });
    const result = await callTool(READ_SCOPE(), "gitlab_work_item_get", { iid: 1 });
    expect(result.isError).toBe(false);
    const body = JSON.parse(result.text);
    expect(body.issue.iid).toBe(1);
    expect(body.issue.title).toBe("Parent");
    expect(body.hierarchy).toEqual([
      { iid: 2, title: "Child two", checked: false },
      { iid: 3, title: "Child three", checked: true },
    ]);
    expect(body.dependencies).toHaveLength(1);
    expect(body.dependencies[0].id).toBe(77);
  });

  it("skips deleted children in the hierarchy view", async () => {
    const result = await callTool(READ_SCOPE(), "gitlab_work_item_get", { iid: 6 });
    const body = JSON.parse(result.text);
    expect(body.hierarchy).toEqual([{ iid: 2, title: "Child two", checked: true }]);
  });
});

describe("gitlab_work_item_children", () => {
  it("parses task-list entries with titles", async () => {
    const result = await callTool(READ_SCOPE(), "gitlab_work_item_children", { iid: 1 });
    expect(result.isError).toBe(false);
    const body = JSON.parse(result.text);
    expect(body.items).toEqual([
      { iid: 2, title: "Child two", checked: false },
      { iid: 3, title: "Child three", checked: true },
    ]);
  });

  it("returns an empty list when the description has no task list", async () => {
    const result = await callTool(READ_SCOPE(), "gitlab_work_item_children", { iid: 5 });
    expect(JSON.parse(result.text).items).toEqual([]);
  });
});

describe("gitlab_work_item_add_child", () => {
  it("PUTs the description with the appended entry, preserving content", async () => {
    calls.length = 0;
    const result = await callTool(WRITE_SCOPE(), "gitlab_work_item_add_child", {
      iid: 1,
      child_iid: 4,
    });
    expect(result.isError).toBe(false);
    const put = calls.find((c) => c.method === "PUT");
    expect(put?.path).toBe("/api/v4/projects/itrend/cxutility/issues/1");
    expect(put?.body).toEqual({
      description: "# Parent\n\nSome intro text.\n- [ ] #2\n- [x] #3\n- [ ] #4",
    });
    expect(JSON.parse(result.text).added).toBe(true);
    // restore
    issues.get(1)!.description = "# Parent\n\nSome intro text.\n- [ ] #2\n- [x] #3";
  });

  it("is idempotent: no PUT when the child is already listed", async () => {
    calls.length = 0;
    const result = await callTool(WRITE_SCOPE(), "gitlab_work_item_add_child", {
      iid: 1,
      child_iid: 2,
    });
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.text).added).toBe(false);
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
  });

  it("rejects self-parenting with VALIDATION_ERROR", async () => {
    const result = await callTool(WRITE_SCOPE(), "gitlab_work_item_add_child", {
      iid: 1,
      child_iid: 1,
    });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/^ERROR VALIDATION_ERROR: /);
  });

  it("denies without the issue-write scope", async () => {
    const result = await callTool(READ_ONLY_SCOPE(), "gitlab_work_item_add_child", {
      iid: 1,
      child_iid: 4,
    });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/^ERROR POLICY_SCOPE_MISSING: /);
  });
});

describe("gitlab_work_item_remove_child", () => {
  it("removes only the matching entry via PUT", async () => {
    issues.get(1)!.description = "keep\n- [ ] #2\n- [x] #3\n#2 mention stays";
    calls.length = 0;
    const result = await callTool(WRITE_SCOPE(), "gitlab_work_item_remove_child", {
      iid: 1,
      child_iid: 2,
    });
    expect(result.isError).toBe(false);
    const put = calls.find((c) => c.method === "PUT");
    expect(put?.body).toEqual({ description: "keep\n- [x] #3\n#2 mention stays" });
    expect(JSON.parse(result.text).removed).toBe(true);
  });

  it("tolerates absence idempotently (no PUT)", async () => {
    calls.length = 0;
    const result = await callTool(WRITE_SCOPE(), "gitlab_work_item_remove_child", {
      iid: 1,
      child_iid: 42,
    });
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.text).removed).toBe(false);
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
  });

  it("rejects self-removal with VALIDATION_ERROR and denies without scope", async () => {
    const self = await callTool(WRITE_SCOPE(), "gitlab_work_item_remove_child", {
      iid: 1,
      child_iid: 1,
    });
    expect(self.text).toMatch(/^ERROR VALIDATION_ERROR: /);
    const noScope = await callTool(READ_ONLY_SCOPE(), "gitlab_work_item_remove_child", {
      iid: 1,
      child_iid: 2,
    });
    expect(noScope.text).toMatch(/^ERROR POLICY_SCOPE_MISSING: /);
  });
});

describe("gitlab_work_item_link", () => {
  it("POSTs target_project_id/target_issue_iid/link_type to the links endpoint", async () => {
    calls.length = 0;
    const result = await callTool(WRITE_SCOPE(), "gitlab_work_item_link", {
      iid: 1,
      target_iid: 5,
      link_type: "blocks",
    });
    expect(result.isError).toBe(false);
    const post = calls.find((c) => c.method === "POST");
    expect(post?.path).toBe("/api/v4/projects/itrend/cxutility/issues/1/links");
    expect(post?.body).toEqual({
      target_project_id: "itrend/cxutility",
      target_issue_iid: 5,
      link_type: "blocks",
    });
  });

  it("accepts is_blocked_by", async () => {
    const result = await callTool(WRITE_SCOPE(), "gitlab_work_item_link", {
      iid: 2,
      target_iid: 4,
      link_type: "is_blocked_by",
    });
    expect(result.isError).toBe(false);
  });

  it("rejects self-linking with VALIDATION_ERROR", async () => {
    const result = await callTool(WRITE_SCOPE(), "gitlab_work_item_link", {
      iid: 1,
      target_iid: 1,
      link_type: "blocks",
    });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/^ERROR VALIDATION_ERROR: /);
  });

  it("rejects cross-project targets with VALIDATION_ERROR", async () => {
    const result = await callTool(WRITE_SCOPE(), "gitlab_work_item_link", {
      iid: 1,
      target_iid: 5,
      link_type: "blocks",
      target_project: "other/project",
    });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/^ERROR VALIDATION_ERROR: cross-project/);
  });

  it("denies without the issue-write scope", async () => {
    const result = await callTool(READ_ONLY_SCOPE(), "gitlab_work_item_link", {
      iid: 1,
      target_iid: 5,
      link_type: "blocks",
    });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/^ERROR POLICY_SCOPE_MISSING: /);
  });
});

describe("gitlab_work_item_unlink", () => {
  it("finds the link id via the links endpoint and DELETEs it", async () => {
    links.set("1-5", { id: 555, link_type: "blocks", a: 1, b: 5 });
    calls.length = 0;
    const result = await callTool(WRITE_SCOPE(), "gitlab_work_item_unlink", {
      iid: 1,
      target_iid: 5,
    });
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.text)).toEqual({ unlinked: true, link_id: 555 });
    const del = calls.find((c) => c.method === "DELETE");
    expect(del?.path).toBe("/api/v4/projects/itrend/cxutility/issues/1/links/555");
  });

  it("tolerates a missing link idempotently (no DELETE)", async () => {
    calls.length = 0;
    const result = await callTool(WRITE_SCOPE(), "gitlab_work_item_unlink", {
      iid: 1,
      target_iid: 5,
    });
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.text)).toEqual({ unlinked: false });
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
  });

  it("rejects self-unlinking with VALIDATION_ERROR and denies without scope", async () => {
    const self = await callTool(WRITE_SCOPE(), "gitlab_work_item_unlink", {
      iid: 1,
      target_iid: 1,
    });
    expect(self.text).toMatch(/^ERROR VALIDATION_ERROR: /);
    const noScope = await callTool(READ_ONLY_SCOPE(), "gitlab_work_item_unlink", {
      iid: 1,
      target_iid: 5,
    });
    expect(noScope.text).toMatch(/^ERROR POLICY_SCOPE_MISSING: /);
  });
});
