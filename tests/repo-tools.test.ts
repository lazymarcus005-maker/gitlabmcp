/**
 * Contract tests for the branch + repository domain tools (issue #7, tool-spec
 * §Branch/§Repository): full stack per call — gateway → policy engine → GitLab
 * client → handler — against a mock GitLab HTTP server. Covers guardrail
 * denials (POLICY_BRANCH_PROTECTED), the repo-write scope requirement for the
 * PRIVILEGED delete, pagination, size caps and file decoding.
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

const TOKEN = "glpat-repo-tools-test";
const IDENTITY = { id: 42, username: "marcus", name: "Marcus Y" };

const BRANCHES = [
  { name: "main", default: true, commit: { id: "a1" } },
  { name: "feature/login", default: false, commit: { id: "b2" } },
  { name: "feature/signup", default: false, commit: { id: "c3" } },
  { name: "hotfix/policy", default: false, commit: { id: "d4" } },
];

const TREE = Array.from({ length: 7 }, (_, i) => ({
  id: `tree-${i}`,
  type: i % 3 === 0 ? "tree" : "blob",
  path: `src/dir${i}/file.ts`,
  mode: "100644",
}));

const FILE_BODY = {
  file_name: "app.ts",
  file_path: "src/app.ts",
  size: 11,
  encoding: "base64",
  content: Buffer.from("hello world", "utf8").toString("base64"),
};

let gitlab: Server;
let gitlabUrl: string;
/** Captured (method, path) of every GitLab API call for endpoint assertions. */
let seenRequests: Array<{ method: string; path: string }>;

beforeAll(() => {
  resetCapabilityLog();
});

beforeAll(async () => {
  gitlab = createHttpServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = decodeURIComponent(url.pathname);
    seenRequests.push({ method: req.method ?? "GET", path: url.pathname });
    const json = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { "Content-Type": "application/json", ...headers });
      res.end(JSON.stringify(body));
    };
    if (path === "/api/v4/user") return json(200, IDENTITY);
    if (path === "/api/v4/version") {
      return json(200, { version: "18.8.3-ee", revision: "abc123" });
    }
    const repoMatch = path.match(/^\/api\/v4\/projects\/(.+?)\/repository\/(.+)$/);
    if (!repoMatch) return json(404, { message: "404 Not Found" });
    const project = repoMatch[1];
    const rest = repoMatch[2];

    // branches collection
    if (rest === "repository/branches" || rest === "branches") {
      if (req.method === "POST") {
        let body = "";
        req.on("data", (c: Buffer) => (body += c.toString("utf8")));
        req.on("end", () => {
          const parsed = JSON.parse(body || "{}") as { branch?: string; ref?: string };
          if (!parsed.branch || !parsed.ref) return json(400, { message: "branch missing" });
          json(201, { name: parsed.branch, commit: { id: "new" }, created: true });
        });
        return;
      }
      const search = url.searchParams.get("search");
      const rows = search ? BRANCHES.filter((b) => b.name.includes(search)) : BRANCHES;
      const page = Number(url.searchParams.get("page") ?? "1");
      const perPage = Number(url.searchParams.get("per_page") ?? "20");
      const data = rows.slice((page - 1) * perPage, page * perPage);
      const nextPage = page * perPage < rows.length ? String(page + 1) : "";
      return json(200, data, {
        "x-next-page": nextPage,
        "x-total": String(rows.length),
      });
    }

    // single branch: /repository/branches/:branch
    const branchMatch = rest.match(/^branches\/(.+)$/);
    if (branchMatch) {
      const branch = decodeURIComponent(branchMatch[1]);
      if (req.method === "DELETE") {
        return json(200, null);
      }
      const found = BRANCHES.find((b) => b.name === branch);
      if (found) return json(200, found);
      return json(404, { message: "404 Branch Not Found" });
    }

    // tree
    if (rest === "tree") {
      const page = Number(url.searchParams.get("page") ?? "1");
      const perPage = Number(url.searchParams.get("per_page") ?? "20");
      const data = TREE.slice((page - 1) * perPage, page * perPage);
      const nextPage = page * perPage < TREE.length ? String(page + 1) : "";
      return json(200, data, { "x-next-page": nextPage, "x-total": String(TREE.length) });
    }

    // file: /repository/files/:path
    const fileMatch = rest.match(/^files\/(.+)$/);
    if (fileMatch) {
      const filePath = decodeURIComponent(fileMatch[1]);
      if (filePath === "src/huge.ts") {
        const big = "x".repeat(200 * 1024); // > default 100 KB cap
        return json(200, {
          ...FILE_BODY,
          file_name: "huge.ts",
          file_path: filePath,
          size: big.length,
          content: Buffer.from(big, "utf8").toString("base64"),
        });
      }
      if (filePath === "src/app.ts") return json(200, FILE_BODY);
      return json(404, { message: "404 File Not Found" });
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

function buildScope(
  headerEnv: Record<string, string>,
  extraEnv: Record<string, string> = {},
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
      ...extraEnv,
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

const DEFAULTS = { "x-gitlab-default-project": "acme/app" };
const REPO_WRITE = { "x-gitlab-request-scope": "repo-write" };

describe("gitlab_branch_list", () => {
  it("hits GET /projects/:id/repository/branches and honors search + pagination", async () => {
    seenRequests = [];
    const first = await callTool(buildScope(DEFAULTS), "gitlab_branch_list", {
      search: "feature",
      limit: 1,
    });
    expect(first.isError).toBe(false);
    expect(seenRequests.some((r) => r.method === "GET" && r.path.endsWith("/repository/branches")))
      .toBe(true);
    const body = JSON.parse(first.text);
    expect(body.items.map((b: { name: string }) => b.name)).toEqual(["feature/login"]);
    expect(body.pagination.has_more).toBe(true);

    const second = await callTool(buildScope(DEFAULTS), "gitlab_branch_list", {
      search: "feature",
      cursor: body.pagination.next_cursor,
    });
    const secondBody = JSON.parse(second.text);
    expect(secondBody.items.map((b: { name: string }) => b.name)).toEqual(["feature/signup"]);
    expect(secondBody.pagination.has_more).toBe(false);
  });
});

describe("gitlab_branch_get", () => {
  it("URL-encodes the branch and returns its metadata", async () => {
    seenRequests = [];
    const result = await callTool(buildScope(DEFAULTS), "gitlab_branch_get", {
      branch: "feature/login",
    });
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.text).name).toBe("feature/login");
    const hit = seenRequests.find((r) => r.path.includes("/repository/branches/"));
    expect(hit?.path).toContain(encodeURIComponent("feature/login"));
  });

  it("unknown branch → GITLAB_API_ERROR (404 surfaced)", async () => {
    const result = await callTool(buildScope(DEFAULTS), "gitlab_branch_get", {
      branch: "nope",
    });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/^ERROR GITLAB_API_ERROR: GitLab returned HTTP 404/);
  });
});

describe("gitlab_branch_create", () => {
  it("POSTs branch + ref on a non-protected branch with repo-write scope", async () => {
    seenRequests = [];
    const result = await callTool(buildScope({ ...DEFAULTS, ...REPO_WRITE }), "gitlab_branch_create", {
      branch: "feature/new",
      ref: "main",
    });
    expect(result.isError).toBe(false);
    const body = JSON.parse(result.text);
    expect(body.name).toBe("feature/new");
    expect(body.created).toBe(true);
    expect(seenRequests.some((r) => r.method === "POST" && r.path.endsWith("/repository/branches")))
      .toBe(true);
  });

  it("create on a protected branch → POLICY_BRANCH_PROTECTED (no GitLab call)", async () => {
    seenRequests = [];
    const result = await callTool(buildScope({ ...DEFAULTS, ...REPO_WRITE }), "gitlab_branch_create", {
      branch: "main",
      ref: "main",
    });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/^ERROR POLICY_BRANCH_PROTECTED: branch 'main' is protected/);
    expect(seenRequests.some((r) => r.path.includes("/repository/branches"))).toBe(false);
  });

  it("missing repo-write scope → POLICY_SCOPE_MISSING", async () => {
    const result = await callTool(
      buildScope({ ...DEFAULTS, "x-gitlab-request-scope": "read" }),
      "gitlab_branch_create",
      { branch: "feature/new", ref: "main" },
    );
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/^ERROR POLICY_SCOPE_MISSING: .*repo-write/);
  });
});

describe("gitlab_branch_delete", () => {
  it("DELETEs the branch (PRIVILEGED, repo-write scope)", async () => {
    seenRequests = [];
    const result = await callTool(buildScope({ ...DEFAULTS, ...REPO_WRITE }), "gitlab_branch_delete", {
      branch: "hotfix/policy",
    });
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.text)).toEqual({ branch: "hotfix/policy", deleted: true });
    expect(seenRequests.some(
      (r) => r.method === "DELETE" && r.path.endsWith(`/repository/branches/${encodeURIComponent("hotfix/policy")}`),
    )).toBe(true);
  });

  it("delete of a protected branch → POLICY_BRANCH_PROTECTED", async () => {
    const result = await callTool(buildScope({ ...DEFAULTS, ...REPO_WRITE }), "gitlab_branch_delete", {
      branch: "master",
    });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/^ERROR POLICY_BRANCH_PROTECTED: branch 'master' is protected/);
  });

  it("delete on the deny_direct_delete list → POLICY_BRANCH_PROTECTED", async () => {
    const scope = buildScope(
      { ...DEFAULTS, ...REPO_WRITE },
      { GITLAB_MCP_DENY_DIRECT_DELETE: "release" },
    );
    const result = await callTool(scope, "gitlab_branch_delete", { branch: "release" });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/^ERROR POLICY_BRANCH_PROTECTED: direct delete of branch 'release'/);
  });

  it("missing repo-write scope → POLICY_SCOPE_MISSING", async () => {
    const result = await callTool(
      buildScope({ ...DEFAULTS, "x-gitlab-request-scope": "read" }),
      "gitlab_branch_delete",
      { branch: "hotfix/policy" },
    );
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/^ERROR POLICY_SCOPE_MISSING: .*repo-write/);
  });
});

describe("gitlab_repository_tree", () => {
  it("paginates the tree with the cursor contract", async () => {
    seenRequests = [];
    const first = await callTool(buildScope(DEFAULTS), "gitlab_repository_tree", { limit: 3 });
    expect(first.isError).toBe(false);
    expect(seenRequests.some((r) => r.path.endsWith("/repository/tree"))).toBe(true);
    const body = JSON.parse(first.text);
    expect(body.items).toHaveLength(3);
    expect(body.pagination.has_more).toBe(true);
    expect(body.truncated).toBeUndefined();

    const second = await callTool(buildScope(DEFAULTS), "gitlab_repository_tree", {
      cursor: body.pagination.next_cursor,
    });
    const secondBody = JSON.parse(second.text);
    expect(secondBody.items).toHaveLength(3);
    expect(secondBody.pagination.has_more).toBe(true);
  });

  it("passes path/ref query params", async () => {
    seenRequests = [];
    await callTool(buildScope(DEFAULTS), "gitlab_repository_tree", {
      path: "src",
      ref: "feature/login",
    });
    const raw = seenRequests.find((r) => r.path.endsWith("/repository/tree"));
    expect(raw).toBeDefined();
  });

  it("size-caps oversized listings with truncated + hint, keeping pagination", async () => {
    const capped = buildScope(DEFAULTS, { GITLAB_MCP_MAX_BYTES: "256" });
    const result = await callTool(capped, "gitlab_repository_tree", { limit: 5 });
    expect(result.isError).toBe(false);
    const body = JSON.parse(result.text);
    expect(body.truncated).toBe(true);
    expect(body.original_bytes).toBeGreaterThan(256);
    expect(typeof body.items_json).toBe("string");
    expect(body.items_json.length).toBeLessThanOrEqual(256 + 8); // + UTF-8 lead-byte walkback slack
    expect(body.continuation_hint).toMatch(/size cap/);
    expect(body.pagination).toBeDefined();
    expect(body.items).toBeUndefined();
  });
});

describe("gitlab_repository_file_get", () => {
  it("decodes base64 content and returns metadata", async () => {
    seenRequests = [];
    const result = await callTool(buildScope(DEFAULTS), "gitlab_repository_file_get", {
      file_path: "src/app.ts",
      ref: "main",
    });
    expect(result.isError).toBe(false);
    const body = JSON.parse(result.text);
    expect(body.content).toBe("hello world");
    expect(body.truncated).toBe(false);
    expect(body.file_path).toBe("src/app.ts");
    expect(body.ref).toBe("main");
    expect(seenRequests.some((r) => r.path.includes("/repository/files/"))).toBe(true);
  });

  it("URL-encodes slashes in the file path and defaults ref-less calls", async () => {
    seenRequests = [];
    await callTool(buildScope(DEFAULTS), "gitlab_repository_file_get", {
      file_path: "src/app.ts",
    });
    const hit = seenRequests.find((r) => r.path.includes("/repository/files/"));
    expect(hit?.path).toContain(encodeURIComponent("src/app.ts"));
  });

  it("truncates oversized files with truncated: true", async () => {
    const result = await callTool(buildScope(DEFAULTS), "gitlab_repository_file_get", {
      file_path: "src/huge.ts",
    });
    expect(result.isError).toBe(false);
    const body = JSON.parse(result.text);
    expect(body.truncated).toBe(true);
    expect(body.original_bytes).toBe(200 * 1024);
    expect(Buffer.byteLength(body.content, "utf8")).toBeLessThanOrEqual(100 * 1024);
    expect(body.continuation_hint).toBeDefined();
  });

  it("unknown file → GITLAB_API_ERROR (404 surfaced)", async () => {
    const result = await callTool(buildScope(DEFAULTS), "gitlab_repository_file_get", {
      file_path: "nope.ts",
    });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/^ERROR GITLAB_API_ERROR: GitLab returned HTTP 404/);
  });

  it("missing file_path → VALIDATION_ERROR", async () => {
    const result = await callTool(buildScope(DEFAULTS), "gitlab_repository_file_get", {});
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/^ERROR VALIDATION_ERROR: missing required argument 'file_path'/);
  });
});

describe("default-project fallback + validation", () => {
  it("branch_get/file_get fall back to X-GitLab-Default-Project", async () => {
    seenRequests = [];
    await callTool(buildScope(DEFAULTS), "gitlab_branch_get", { branch: "main" });
    await callTool(buildScope(DEFAULTS), "gitlab_repository_file_get", { file_path: "src/app.ts" });
    const paths = seenRequests.map((r) => r.path);
    expect(paths.filter((p) => p.startsWith("/api/v4/projects/acme%2Fapp"))).toHaveLength(2);
  });

  it("missing project without default header → VALIDATION_ERROR", async () => {
    const result = await callTool(buildScope({}), "gitlab_branch_list");
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/^ERROR VALIDATION_ERROR: missing required argument 'project'/);
  });

  it("unknown arguments → VALIDATION_ERROR", async () => {
    const result = await callTool(buildScope(DEFAULTS), "gitlab_branch_list", { bogus: 1 });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/^ERROR VALIDATION_ERROR: unknown argument\(s\): bogus$/);
  });
});
